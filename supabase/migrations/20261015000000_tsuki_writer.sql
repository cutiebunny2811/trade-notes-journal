-- Tsuki's narrowly scoped, revocable journal writer. The existing
-- journal_trades.data.fills array remains the single UI-readable ledger.
-- Apply only after reviewing this file against the live schema.

create table if not exists public.journal_agent_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);
alter table public.journal_agent_tokens enable row level security;
revoke all on public.journal_agent_tokens from public, anon, authenticated;

create table if not exists public.journal_agent_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_key text not null check (char_length(source_key) between 1 and 300),
  broker_execution_id text,
  fingerprint text not null,
  -- Keep a tombstone if the user deletes a journal trade; replaying the same
  -- Telegram message must not silently recreate a deleted entry.
  trade_id uuid not null,
  fill_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, source_key)
);
create unique index if not exists journal_agent_broker_execution_idx
  on public.journal_agent_receipts(user_id, broker_execution_id)
  where broker_execution_id is not null;
create index if not exists journal_agent_receipts_trade_idx
  on public.journal_agent_receipts(trade_id);
alter table public.journal_agent_receipts enable row level security;
revoke all on public.journal_agent_receipts from public, anon, authenticated;

create or replace function public.api_tsuki_summarize_fills(p_direction text, p_fills jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
  v_open_side text := case when p_direction = 'SHORT' then 'sell' else 'buy' end;
  v_action text;
  v_qty numeric;
  v_price numeric;
  v_multiplier numeric;
  v_first_multiplier numeric;
  v_fees numeric;
  v_gross numeric;
  v_open numeric := 0;
  v_basis numeric := 0;
  v_realized numeric := 0;
  v_allocated numeric;
  v_completed boolean := false;
begin
  if p_direction not in ('LONG', 'SHORT') or jsonb_typeof(p_fills) <> 'array' then
    raise exception 'INVALID_FILL_SERIES';
  end if;
  for v_item in
    select item from jsonb_array_elements(p_fills) with ordinality as f(item, ordinal)
    order by (item->>'executedAt')::timestamptz, ordinal
  loop
    v_action := v_item->>'action';
    v_qty := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unitPrice')::numeric;
    v_multiplier := coalesce((v_item->>'multiplier')::numeric, 1);
    v_fees := coalesce((v_item->>'commission')::numeric, 0)
      + coalesce((v_item->>'otherFees')::numeric, 0);
    if v_action not in ('buy', 'sell') or v_qty is null or v_qty <= 0
      or v_price is null or v_price < 0 or v_multiplier <= 0 or v_fees < 0
      or nullif(v_item->>'executedAt', '') is null then
      raise exception 'INVALID_FILL';
    end if;
    if v_first_multiplier is not null and v_multiplier <> v_first_multiplier then
      raise exception 'MIXED_MULTIPLIER';
    end if;
    v_first_multiplier := v_multiplier;
    if v_completed then raise exception 'TRADE_ALREADY_CLOSED'; end if;
    v_gross := v_qty * v_price * v_multiplier;
    if v_action = v_open_side then
      v_open := v_open + v_qty;
      v_basis := v_basis + v_gross
        + case when v_open_side = 'buy' then v_fees else -v_fees end;
    else
      if v_qty > v_open + 0.00000001 then raise exception 'EXIT_EXCEEDS_POSITION'; end if;
      v_allocated := v_basis / v_open * v_qty;
      v_realized := v_realized
        + case when v_open_side = 'buy'
            then v_gross - v_fees - v_allocated
            else v_allocated - v_gross - v_fees end;
      v_basis := v_basis - v_allocated;
      v_open := v_open - v_qty;
      if abs(v_open) < 0.00000001 then
        v_open := 0;
        v_basis := 0;
        v_completed := true;
      end if;
    end if;
  end loop;
  return jsonb_build_object(
    'status', case when v_completed then 'closed' else 'pending' end,
    'openQuantity', v_open,
    'realizedPl', round(v_realized, 2),
    'pl', case when v_completed then round(v_realized, 2) else null end
  );
end;
$$;
revoke all on function public.api_tsuki_summarize_fills(text, jsonb) from public, anon, authenticated;

create or replace function public.api_tsuki_record_fill(p_token text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_source text;
  v_broker_id text;
  v_fingerprint text;
  v_lane text;
  v_asset text;
  v_style text;
  v_symbol text;
  v_direction text;
  v_action text;
  v_intent text;
  v_match_key text;
  v_contract jsonb;
  v_qty numeric;
  v_price numeric;
  v_multiplier numeric;
  v_commission numeric;
  v_other_fees numeric;
  v_at timestamptz;
  v_trade_id uuid;
  v_fill_id uuid := gen_random_uuid();
  v_candidate_count integer;
  v_data jsonb;
  v_fills jsonb;
  v_fill jsonb;
  v_summary jsonb;
  v_previous public.journal_agent_receipts%rowtype;
begin
  if p_token is null or p_token !~ '^tn_[a-f0-9]{64}$' then
    raise exception 'INVALID_AGENT_TOKEN' using errcode = '28000';
  end if;
  select token.user_id into v_user
  from public.journal_agent_tokens token
  where token.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and token.revoked_at is null
    and (token.expires_at is null or token.expires_at > now());
  if v_user is null then raise exception 'INVALID_AGENT_TOKEN' using errcode = '28000'; end if;
  if jsonb_typeof(p_payload) <> 'object' then raise exception 'INVALID_PAYLOAD'; end if;

  -- One writer transaction at a time per account. Matching, dedupe and the
  -- journal update therefore cannot race another Tsuki request.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 7419));
  v_source := nullif(trim(p_payload->>'sourceKey'), '');
  v_broker_id := nullif(trim(p_payload->>'brokerExecutionId'), '');
  v_lane := lower(trim(p_payload->>'lane'));
  v_asset := lower(trim(p_payload->>'assetClass'));
  v_style := nullif(lower(trim(p_payload->>'tradeStyle')), '');
  v_symbol := upper(trim(p_payload->>'symbol'));
  v_direction := upper(trim(p_payload->>'direction'));
  v_action := lower(trim(p_payload->>'action'));
  v_intent := nullif(lower(trim(p_payload->>'intent')), '');
  v_match_key := nullif(trim(p_payload->>'matchKey'), '');
  v_contract := p_payload->'optionContract';
  if v_source is null or char_length(v_source) > 300
    or (v_source !~ '^tg:[-0-9]+:[0-9]+:[0-9]+$'
      and v_source !~ '^broker:[A-Za-z0-9._:-]{1,200}$')
    or v_lane is null or v_lane not in ('nut', 'ging', 'swing', 'option', 'gold')
    or v_asset is null or v_asset not in ('stock', 'option', 'gold')
    or v_symbol is null or v_symbol !~ '^[A-Z0-9.^-]{1,20}$'
    or v_direction is null or v_direction not in ('LONG', 'SHORT')
    or v_action is null or v_action not in ('buy', 'sell')
    or (v_intent is not null and v_intent not in ('buy1', 'buy2', 'sell', 'open', 'add')) then
    raise exception 'INVALID_ROUTE_OR_IDENTITY';
  end if;
  if v_broker_id is not null and char_length(v_broker_id) > 200 then
    raise exception 'INVALID_BROKER_EXECUTION_ID';
  end if;
  if v_style is not null and v_style not in ('swing', 'day', 'position') then
    raise exception 'INVALID_TRADE_STYLE';
  end if;
  if (v_intent in ('buy1', 'buy2', 'open', 'add')
      and v_action <> case when v_direction = 'SHORT' then 'sell' else 'buy' end)
    or (v_intent = 'sell'
      and v_action <> case when v_direction = 'SHORT' then 'buy' else 'sell' end) then
    raise exception 'INTENT_SIDE_MISMATCH';
  end if;
  if (v_lane = 'option') <> (v_asset = 'option')
    or (v_lane = 'gold') <> (v_asset = 'gold') then
    raise exception 'LANE_ASSET_MISMATCH';
  end if;
  if v_asset = 'option' then
    if jsonb_typeof(v_contract) <> 'object'
      or (v_contract->>'expiry') is null
      or (v_contract->>'expiry') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (v_contract->>'strike') is null
      or (v_contract->>'strike')::numeric <= 0
      or (v_contract->>'right') is null
      or lower(v_contract->>'right') not in ('call', 'put') then
      raise exception 'OPTION_CONTRACT_REQUIRED';
    end if;
    v_contract := jsonb_build_object('expiry', v_contract->>'expiry',
      'strike', (v_contract->>'strike')::numeric, 'right', lower(v_contract->>'right'));
  else
    v_contract := null;
  end if;
  if not (p_payload ? 'commission') or not (p_payload ? 'otherFees') then
    raise exception 'FEES_MUST_BE_EXPLICIT';
  end if;
  v_qty := (p_payload->>'quantity')::numeric;
  v_price := (p_payload->>'unitPrice')::numeric;
  v_multiplier := (p_payload->>'multiplier')::numeric;
  v_commission := (p_payload->>'commission')::numeric;
  v_other_fees := (p_payload->>'otherFees')::numeric;
  if v_qty is null or v_qty <= 0 or v_price is null or v_price < 0
    or v_multiplier is null or v_commission is null or v_commission < 0
    or v_other_fees is null or v_other_fees < 0
    or (v_asset = 'option' and v_multiplier <> 100)
    or (v_asset <> 'option' and v_multiplier <> 1) then
    raise exception 'INVALID_FILL_VALUES';
  end if;
  if (p_payload->>'executedAt') is null or
    (p_payload->>'executedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    raise exception 'EXECUTION_TIME_WITH_ZONE_REQUIRED';
  end if;
  v_at := (p_payload->>'executedAt')::timestamptz;
  if v_at > now() + interval '5 minutes' then raise exception 'FUTURE_EXECUTION'; end if;

  v_fingerprint := encode(extensions.digest(concat_ws('|', v_lane, v_asset,
    v_symbol, coalesce(v_contract::text, ''), v_direction, v_action,
    round(v_qty, 8)::numeric(20,8)::text,
    round(v_price, 8)::numeric(20,8)::text,
    v_multiplier::text,
    round(v_commission, 8)::numeric(20,8)::text,
    round(v_other_fees, 8)::numeric(20,8)::text, v_at::text), 'sha256'), 'hex');
  select * into v_previous from public.journal_agent_receipts
  where user_id = v_user and (source_key = v_source
    or (v_broker_id is not null and broker_execution_id = v_broker_id))
  order by case when source_key = v_source then 0 else 1 end limit 1;
  if found then
    if v_previous.fingerprint <> v_fingerprint then
      raise exception 'SOURCE_IDENTITY_CONFLICT';
    end if;
    return jsonb_build_object('duplicate', true, 'tradeId', v_previous.trade_id,
      'fillId', v_previous.fill_id);
  end if;
  if exists (select 1 from public.journal_agent_receipts
    where user_id = v_user and fingerprint = v_fingerprint
      and (v_broker_id is null or broker_execution_id is null)) then
    raise exception 'POSSIBLE_FORWARDED_DUPLICATE';
  end if;

  if v_match_key is not null then
    select id, data into v_trade_id, v_data from public.journal_trades
    where user_id = v_user and data->>'matchKey' = v_match_key for update;
    if v_trade_id is null then raise exception 'MATCHKEY_NOT_FOUND'; end if;
    if v_data->>'status' <> 'pending' or v_data->>'symbol' <> v_symbol
      or v_data->>'direction' <> v_direction
      or coalesce(v_data->>'assetClass', '') <> v_asset
      or (v_asset = 'option' and v_data->'optionContract' <> v_contract)
      or (v_data->>'lane' is not null and v_data->>'lane' <> v_lane) then
      raise exception 'MATCHKEY_CONFLICT';
    end if;
  else
    select count(*), (array_agg(id))[1] into v_candidate_count, v_trade_id
    from public.journal_trades where user_id = v_user
      and data->>'status' = 'pending' and data->>'symbol' = v_symbol
      and data->>'direction' = v_direction and data->>'assetClass' = v_asset
      and data->>'lane' = v_lane
      and (v_asset <> 'option' or data->'optionContract' = v_contract);
    if v_candidate_count = 0 then
      select count(*), (array_agg(id))[1] into v_candidate_count, v_trade_id
      from public.journal_trades where user_id = v_user
        and data->>'status' = 'pending' and data->>'symbol' = v_symbol
        and data->>'direction' = v_direction and data->>'assetClass' = v_asset
        and nullif(data->>'lane', '') is null
        and (v_asset <> 'option' or data->'optionContract' = v_contract);
    end if;
    if v_candidate_count > 1 then raise exception 'AMBIGUOUS_OPEN_TRADE'; end if;
  end if;
  if v_trade_id is not null then
    select data into v_data from public.journal_trades
    where id = v_trade_id and user_id = v_user for update;
    if v_intent in ('buy1', 'open') then raise exception 'OPEN_TRADE_ALREADY_EXISTS'; end if;
  elsif (v_action = (case when v_direction = 'SHORT' then 'buy' else 'sell' end)
    or v_intent in ('buy2', 'add', 'sell')) then
    raise exception 'OPEN_TRADE_NOT_FOUND';
  else
    v_trade_id := gen_random_uuid();
    v_data := jsonb_build_object('id', v_trade_id, 'matchKey', 'TN-' || v_trade_id,
      'lane', v_lane, 'assetClass', v_asset, 'tradeStyle', v_style,
      'optionContract', v_contract, 'symbol', v_symbol, 'status', 'pending',
      'direction', v_direction,
      'date', to_char(v_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI'),
      'pl', null, 'setup', '', 'emotions', jsonb_build_object(
        'before', null, 'during', null, 'after', null),
      'notes', '', 'imagePaths', jsonb_build_array(), 'fills', jsonb_build_array());
  end if;

  v_fill := jsonb_build_object('id', v_fill_id, 'source', 'tsuki',
    'sourceKey', v_source, 'brokerExecutionId', v_broker_id,
    'action', v_action, 'quantity', v_qty, 'unitPrice', v_price,
    'multiplier', v_multiplier, 'commission', v_commission,
    'otherFees', v_other_fees, 'executedAt', v_at,
    'brokerTimeText', nullif(p_payload->>'brokerTimeText', ''),
    'createdAt', now());
  v_fills := coalesce(v_data->'fills', '[]'::jsonb) || jsonb_build_array(v_fill);
  v_summary := public.api_tsuki_summarize_fills(v_direction, v_fills);
  v_data := v_data || jsonb_build_object('lane', v_lane, 'fills', v_fills,
    'plSource', 'fills', 'status', v_summary->>'status',
    'pl', v_summary->'pl', 'realizedPl', v_summary->'realizedPl',
    'openQuantity', v_summary->'openQuantity');
  if v_summary->>'status' = 'pending' then
    v_data := jsonb_set(v_data, '{emotions,after}', 'null'::jsonb, true);
  end if;
  insert into public.journal_trades(id, user_id, data)
  values (v_trade_id, v_user, v_data)
  on conflict (id) do update set data = excluded.data, updated_at = clock_timestamp()
  where public.journal_trades.user_id = v_user;
  if not found then raise exception 'TRADE_WRITE_REJECTED'; end if;
  insert into public.journal_agent_receipts
    (user_id, source_key, broker_execution_id, fingerprint, trade_id, fill_id)
  values (v_user, v_source, v_broker_id, v_fingerprint, v_trade_id, v_fill_id);
  if (select count(*) from public.journal_trades trade,
      jsonb_array_elements(trade.data->'fills') as fill(value)
      where trade.id = v_trade_id and trade.user_id = v_user
        and fill.value->>'sourceKey' = v_source) <> 1 then
    raise exception 'READBACK_MISMATCH';
  end if;
  update public.journal_agent_tokens set last_used_at = now()
    where user_id = v_user and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  return jsonb_build_object('duplicate', false, 'tradeId', v_trade_id,
    'matchKey', v_data->>'matchKey', 'fillId', v_fill_id,
    'symbol', v_symbol, 'lane', v_lane, 'status', v_summary->>'status',
    'openQuantity', v_summary->'openQuantity',
    'realizedPl', v_summary->'realizedPl', 'pl', v_summary->'pl',
    'fillCount', jsonb_array_length(v_fills));
end;
$$;
revoke all on function public.api_tsuki_record_fill(text, jsonb) from public;
grant execute on function public.api_tsuki_record_fill(text, jsonb) to anon, authenticated;
