-- Tsuki can read a bounded, owner-scoped journal window and correct an
-- existing bot fill. Neither operation creates a second execution.
create table if not exists public.journal_agent_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trade_id uuid not null,
  fill_id uuid not null,
  before_fill jsonb not null,
  after_fill jsonb not null,
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists journal_agent_corrections_trade_idx
  on public.journal_agent_corrections(user_id, trade_id, created_at);
alter table public.journal_agent_corrections enable row level security;
revoke all on public.journal_agent_corrections from public, anon, authenticated;

create or replace function public.api_tsuki_read_journal(
  p_token text, p_from timestamptz, p_to timestamptz,
  p_symbol text default null, p_match_key text default null,
  p_broker_execution_id text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid;
  v_rows jsonb;
  v_total integer;
  v_symbol text := nullif(upper(trim(p_symbol)), '');
  v_match_key text := nullif(trim(p_match_key), '');
  v_broker_id text := nullif(trim(p_broker_execution_id), '');
begin
  if p_token is null or p_token !~ '^tn_[a-f0-9]{64}$' then
    raise exception 'INVALID_AGENT_TOKEN' using errcode = '28000';
  end if;
  select token.user_id into v_user from public.journal_agent_tokens token
    where token.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
      and token.revoked_at is null
      and (token.expires_at is null or token.expires_at > now());
  if v_user is null then raise exception 'INVALID_AGENT_TOKEN' using errcode = '28000'; end if;
  if p_from is null or p_to is null or p_from >= p_to
    or p_to - p_from > interval '93 days'
    or p_from < now() - interval '5 years'
    or p_to > now() + interval '2 days' then
    raise exception 'INVALID_REVIEW_RANGE';
  end if;
  if (v_symbol is not null and v_symbol !~ '^[A-Z0-9.^-]{1,20}$')
    or (v_match_key is not null and char_length(v_match_key) > 100)
    or (v_broker_id is not null and char_length(v_broker_id) > 200) then
    raise exception 'INVALID_REVIEW_FILTER';
  end if;

  -- Include a position when any execution happened in the window, even if
  -- its opening date is older. A note-only trade is located by its local date.
  select coalesce(jsonb_agg(row_data order by updated_at desc), '[]'::jsonb),
         coalesce(max(total_count), 0)
    into v_rows, v_total
  from (
    select jsonb_build_object(
      'tradeId', trade.id, 'matchKey', trade.data->>'matchKey',
      'updatedAt', trade.updated_at, 'date', trade.data->>'date',
      'symbol', trade.data->>'symbol', 'lane', trade.data->>'lane',
      'assetClass', trade.data->>'assetClass', 'tradeStyle', trade.data->>'tradeStyle',
      'optionContract', trade.data->'optionContract',
      'direction', trade.data->>'direction', 'status', trade.data->>'status',
      'pl', trade.data->'pl', 'realizedPl', trade.data->'realizedPl',
      'openQuantity', trade.data->'openQuantity',
      'setup', trade.data->>'setup', 'notes', left(coalesce(trade.data->>'notes', ''), 4000),
      'emotions', trade.data->'emotions', 'fills', coalesce(trade.data->'fills', '[]'::jsonb)
    ) as row_data, trade.updated_at,
    count(*) over () as total_count
    from public.journal_trades trade
    where trade.user_id = v_user
      and (v_symbol is null or trade.data->>'symbol' = v_symbol)
      and (v_match_key is null or trade.data->>'matchKey' = v_match_key)
      and (v_broker_id is null or exists (
        select 1 from jsonb_array_elements(coalesce(trade.data->'fills', '[]'::jsonb)) as item(value)
          where item.value->>'brokerExecutionId' = v_broker_id))
      and (v_match_key is not null or v_broker_id is not null
        or (left(coalesce(trade.data->>'date', ''), 10) >=
              to_char(p_from at time zone 'Asia/Bangkok', 'YYYY-MM-DD')
            and left(coalesce(trade.data->>'date', ''), 10) <
              to_char(p_to at time zone 'Asia/Bangkok', 'YYYY-MM-DD'))
        or exists (
          select 1 from jsonb_array_elements(coalesce(trade.data->'fills', '[]'::jsonb)) as item(value)
            where (item.value->>'executedAt')::timestamptz >= p_from
              and (item.value->>'executedAt')::timestamptz < p_to))
    order by trade.updated_at desc
    limit 100
  ) limited;
  update public.journal_agent_tokens set last_used_at = now()
    where user_id = v_user and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  return jsonb_build_object('from', p_from, 'to', p_to,
    'totalCount', v_total, 'returnedCount', jsonb_array_length(v_rows),
    'truncated', v_total > 100, 'trades', v_rows);
end;
$$;
revoke all on function public.api_tsuki_read_journal(text,timestamptz,timestamptz,text,text,text) from public;
grant execute on function public.api_tsuki_read_journal(text,timestamptz,timestamptz,text,text,text) to anon, authenticated;

create or replace function public.api_tsuki_correct_fill(p_token text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid;
  v_match_key text;
  v_fill_id uuid;
  v_expected timestamptz;
  v_trade_id uuid;
  v_updated_at timestamptz;
  v_data jsonb;
  v_changes jsonb;
  v_reason text;
  v_before jsonb;
  v_after jsonb;
  v_fills jsonb;
  v_summary jsonb;
  v_receipt public.journal_agent_receipts%rowtype;
  v_fingerprint text;
  v_at timestamptz;
begin
  if p_token is null or p_token !~ '^tn_[a-f0-9]{64}$' then
    raise exception 'INVALID_AGENT_TOKEN' using errcode = '28000';
  end if;
  select token.user_id into v_user from public.journal_agent_tokens token
    where token.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
      and token.revoked_at is null
      and (token.expires_at is null or token.expires_at > now());
  if v_user is null then raise exception 'INVALID_AGENT_TOKEN' using errcode = '28000'; end if;
  if jsonb_typeof(p_payload) <> 'object' then raise exception 'INVALID_CORRECTION'; end if;
  v_match_key := nullif(trim(p_payload->>'matchKey'), '');
  if v_match_key is null then raise exception 'MATCHKEY_REQUIRED'; end if;
  v_fill_id := (p_payload->>'fillId')::uuid;
  v_expected := (p_payload->>'expectedUpdatedAt')::timestamptz;
  v_changes := p_payload->'changes';
  v_reason := nullif(trim(p_payload->>'reason'), '');
  if v_fill_id is null or v_expected is null or v_reason is null
    or char_length(v_reason) > 500 or jsonb_typeof(v_changes) <> 'object'
    or v_changes = '{}'::jsonb
    or v_changes - array['action','quantity','unitPrice','commission','otherFees','executedAt','brokerTimeText'] <> '{}'::jsonb then
    raise exception 'INVALID_CORRECTION';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 7419));
  select trade.id, trade.data, trade.updated_at
    into v_trade_id, v_data, v_updated_at
    from public.journal_trades trade
    where trade.user_id = v_user and trade.data->>'matchKey' = v_match_key
    for update;
  if v_trade_id is null then raise exception 'MATCHKEY_NOT_FOUND'; end if;
  if (select count(*) from jsonb_array_elements(coalesce(v_data->'fills','[]'::jsonb)) as item(value)
      where item.value->>'id' = v_fill_id::text) <> 1 then
    raise exception 'FILL_NOT_FOUND_OR_AMBIGUOUS';
  end if;
  select item.value into v_before
    from jsonb_array_elements(v_data->'fills') as item(value)
    where item.value->>'id' = v_fill_id::text;
  if v_before->>'source' <> 'tsuki' then raise exception 'BOT_FILL_ONLY'; end if;
  select * into v_receipt from public.journal_agent_receipts receipt
    where receipt.user_id = v_user and receipt.trade_id = v_trade_id
      and receipt.fill_id = v_fill_id and receipt.source_key = v_before->>'sourceKey'
    for update;
  if not found then raise exception 'SOURCE_RECEIPT_NOT_FOUND'; end if;
  v_after := v_before || v_changes;
  if v_after->>'action' not in ('buy','sell')
    or (v_after->>'quantity')::numeric <= 0
    or (v_after->>'unitPrice')::numeric < 0
    or (v_after->>'commission')::numeric < 0
    or (v_after->>'otherFees')::numeric < 0
    or (v_after->>'quantity') is null
    or (v_after->>'unitPrice') is null
    or (v_after->>'commission') is null
    or (v_after->>'otherFees') is null
    or (v_after->>'executedAt') !~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    raise exception 'INVALID_CORRECTED_FILL';
  end if;
  v_at := (v_after->>'executedAt')::timestamptz;
  if v_at > now() + interval '5 minutes' then raise exception 'FUTURE_EXECUTION'; end if;
  v_after := jsonb_set(v_after, '{executedAt}', to_jsonb(v_at));
  if v_after = v_before then
    return jsonb_build_object('unchanged', true, 'matchKey', v_match_key,
      'fillId', v_fill_id, 'updatedAt', v_updated_at);
  end if;
  if v_updated_at <> v_expected then raise exception 'STALE_TRADE'; end if;
  select jsonb_agg(case when fill->>'id' = v_fill_id::text then v_after else fill end
      order by ordinal) into v_fills
    from jsonb_array_elements(v_data->'fills') with ordinality as f(fill, ordinal);
  v_summary := public.api_tsuki_summarize_fills(v_data->>'direction', v_fills);
  v_fingerprint := encode(extensions.digest(concat_ws('|',
    v_data->>'lane', v_data->>'assetClass', v_data->>'symbol',
    coalesce((v_data->'optionContract')::text, ''), v_data->>'direction',
    v_after->>'action',
    round((v_after->>'quantity')::numeric, 8)::numeric(20,8)::text,
    round((v_after->>'unitPrice')::numeric, 8)::numeric(20,8)::text,
    (v_after->>'multiplier')::text,
    round((v_after->>'commission')::numeric, 8)::numeric(20,8)::text,
    round((v_after->>'otherFees')::numeric, 8)::numeric(20,8)::text,
    v_at::text), 'sha256'), 'hex');
  if exists (select 1 from public.journal_agent_receipts receipt
      where receipt.user_id = v_user and receipt.fingerprint = v_fingerprint
        and (receipt.trade_id <> v_trade_id or receipt.fill_id <> v_fill_id)) then
    raise exception 'CORRECTED_FILL_DUPLICATES_ANOTHER';
  end if;
  v_data := v_data || jsonb_build_object('fills', v_fills,
    'status', v_summary->>'status', 'pl', v_summary->'pl',
    'realizedPl', v_summary->'realizedPl',
    'openQuantity', v_summary->'openQuantity');
  if v_summary->>'status' = 'pending' then
    v_data := jsonb_set(v_data, '{emotions,after}', 'null'::jsonb, true);
  end if;
  update public.journal_trades set data = v_data, updated_at = clock_timestamp()
    where id = v_trade_id and user_id = v_user returning updated_at into v_updated_at;
  update public.journal_agent_receipts set fingerprint = v_fingerprint
    where user_id = v_user and source_key = v_receipt.source_key;
  insert into public.journal_agent_corrections
    (user_id, trade_id, fill_id, before_fill, after_fill, reason)
    values (v_user, v_trade_id, v_fill_id, v_before, v_after, v_reason);
  if (select count(*) from public.journal_trades trade,
      jsonb_array_elements(trade.data->'fills') as item(value)
      where trade.user_id = v_user and trade.id = v_trade_id
        and item.value->>'id' = v_fill_id::text and item.value = v_after) <> 1
    or (select fingerprint from public.journal_agent_receipts
        where user_id = v_user and source_key = v_receipt.source_key) <> v_fingerprint then
    raise exception 'CORRECTION_READBACK_MISMATCH';
  end if;
  update public.journal_agent_tokens set last_used_at = now()
    where user_id = v_user and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  return jsonb_build_object('unchanged', false, 'matchKey', v_match_key,
    'fillId', v_fill_id, 'updatedAt', v_updated_at,
    'status', v_summary->>'status', 'openQuantity', v_summary->'openQuantity',
    'realizedPl', v_summary->'realizedPl', 'pl', v_summary->'pl');
end;
$$;
revoke all on function public.api_tsuki_correct_fill(text,jsonb) from public;
grant execute on function public.api_tsuki_correct_fill(text,jsonb) to anon, authenticated;
