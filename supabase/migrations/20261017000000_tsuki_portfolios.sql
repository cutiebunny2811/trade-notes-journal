-- Keep multiple open cycles of the same symbol in the same lane separate by
-- broker account/portfolio. Existing journal rows and receipts stay untouched.
-- Apply after 20261015010000_tsuki_routes.sql.
do $portfolio_patch$
declare
  v_sql text := pg_catalog.pg_get_functiondef('public.api_tsuki_record_fill(text,jsonb)'::pg_catalog.regprocedure);
  v_old text;
  v_new text;
begin
  if position('PORTFOLIO_REQUIRED' in v_sql) > 0 then return; end if;
  if position($q$v_lane not in ('swing', 'option', 'position')$q$ in v_sql) = 0 then
    raise exception 'TSUKI_ROUTE_MIGRATION_REQUIRED';
  end if;

  v_old := $q$  v_match_key text;$q$;
  v_new := v_old || chr(10) || $q$  v_portfolio_key text;$q$;
  if position(v_old in v_sql) = 0 then raise exception 'PORTFOLIO_DECLARATION_POINT_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  v_old := $q$  v_match_key := nullif(trim(p_payload->>'matchKey'), '');$q$;
  v_new := v_old || chr(10) || $q$  v_portfolio_key := nullif(upper(trim(p_payload->>'portfolioKey')), '');$q$;
  if position(v_old in v_sql) = 0 then raise exception 'PORTFOLIO_ASSIGNMENT_POINT_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  v_old := $q$  if v_broker_id is not null and char_length(v_broker_id) > 200 then$q$;
  v_new := $q$  if v_portfolio_key is not null and (char_length(v_portfolio_key) > 100
    or v_portfolio_key ~ '[[:cntrl:]]') then
    raise exception 'INVALID_PORTFOLIO_KEY';
  end if;
$q$ || v_old;
  if position(v_old in v_sql) = 0 then raise exception 'PORTFOLIO_VALIDATION_POINT_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  v_old := $q$concat_ws('|', v_lane, v_asset,
    v_symbol$q$;
  v_new := $q$concat_ws('|', v_lane, v_asset, v_portfolio_key,
    v_symbol$q$;
  if position(v_old in v_sql) = 0 then raise exception 'PORTFOLIO_FINGERPRINT_POINT_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  -- A known MatchKey is authoritative, but a supplied portfolio may never
  -- silently attach to a different portfolio's trade.
  v_old := $q$or (v_data->>'lane' is not null and v_data->>'lane' <> v_lane)$q$;
  v_new := $q$or (v_data->>'lane' is not null and v_data->>'lane' <> v_lane)
      or (v_portfolio_key is not null and v_data->>'portfolioKey' is distinct from v_portfolio_key)$q$;
  if position(v_old in v_sql) = 0 then raise exception 'PORTFOLIO_MATCHKEY_POINT_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  -- Both exact-lane and manual-lane searches must use the same portfolio.
  v_old := $q$and data->>'lane' = v_lane
      and (v_asset <> 'option'$q$;
  v_new := $q$and data->>'lane' = v_lane
      and ((v_portfolio_key is null and nullif(data->>'portfolioKey', '') is null)
        or data->>'portfolioKey' = v_portfolio_key)
      and (v_asset <> 'option'$q$;
  if position(v_old in v_sql) = 0 then raise exception 'PORTFOLIO_LANE_SEARCH_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  v_old := $q$and nullif(data->>'lane', '') is null
        and (v_asset = 'option' or data->>'tradeStyle' = v_lane)$q$;
  v_new := $q$and nullif(data->>'lane', '') is null
        and ((v_portfolio_key is null and nullif(data->>'portfolioKey', '') is null)
          or data->>'portfolioKey' = v_portfolio_key)
        and (v_asset = 'option' or data->>'tradeStyle' = v_lane)$q$;
  if position(v_old in v_sql) = 0 then raise exception 'PORTFOLIO_MANUAL_SEARCH_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  -- An unscoped slip must not create/alter an entry when a scoped holding of
  -- the same symbol is open. Ask for the broker account instead.
  v_old := $q$    if v_candidate_count > 1 then raise exception 'AMBIGUOUS_OPEN_TRADE'; end if;$q$;
  v_new := $q$    if v_portfolio_key is null and exists (
      select 1 from public.journal_trades trade
      where trade.user_id = v_user and trade.data->>'status' = 'pending'
        and trade.data->>'symbol' = v_symbol
        and trade.data->>'direction' = v_direction
        and trade.data->>'assetClass' = v_asset
        and (trade.data->>'lane' = v_lane
          or (nullif(trade.data->>'lane', '') is null
            and (v_asset = 'option' or trade.data->>'tradeStyle' = v_lane)))
        and nullif(trade.data->>'portfolioKey', '') is not null
        and (v_asset <> 'option' or trade.data->'optionContract' = v_contract)
    ) then raise exception 'PORTFOLIO_REQUIRED'; end if;
$q$ || v_old;
  if position(v_old in v_sql) = 0 then raise exception 'PORTFOLIO_AMBIGUITY_POINT_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  v_old := $q$'lane', v_lane, 'assetClass', v_asset, 'tradeStyle', v_style,$q$;
  v_new := $q$'lane', v_lane, 'assetClass', v_asset, 'tradeStyle', v_style,
      'portfolioKey', v_portfolio_key,$q$;
  if position(v_old in v_sql) = 0 then raise exception 'PORTFOLIO_CREATE_POINT_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  execute v_sql;
end;
$portfolio_patch$;

-- Expose the private portfolio discriminator to Tsuki's read/correction
-- lookup, without exposing screenshot URLs or changing review calculations.
do $portfolio_review_patch$
declare
  v_sql text := pg_catalog.pg_get_functiondef('public.api_tsuki_read_journal(text,timestamptz,timestamptz,text,text,text)'::pg_catalog.regprocedure);
  v_old text := $q$'optionContract', trade.data->'optionContract',$q$;
begin
  if position($q$'portfolioKey', trade.data->>'portfolioKey'$q$ in v_sql) > 0 then return; end if;
  if position(v_old in v_sql) = 0 then raise exception 'PORTFOLIO_REVIEW_POINT_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old,
    $q$'optionContract', trade.data->'optionContract',
      'portfolioKey', trade.data->>'portfolioKey',$q$);
  execute v_sql;
end;
$portfolio_review_patch$;
