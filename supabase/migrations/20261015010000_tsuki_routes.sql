-- Retire Sheet-era Nut/Ging/longterm routing. The three Tsuki routes are
-- Swing stock, Option contract, and Position stock. No journal rows are changed.
do $route_patch$
declare
  v_sql text := pg_get_functiondef('public.api_tsuki_record_fill(text,jsonb)'::regprocedure);
  v_old text;
  v_new text;
begin
  v_old := $q$v_lane not in ('nut', 'ging', 'swing', 'option', 'gold')$q$;
  v_new := $q$v_lane not in ('swing', 'option', 'position')$q$;
  if position(v_old in v_sql) = 0 then raise exception 'EXPECTED_OLD_LANES_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  v_old := $q$v_asset not in ('stock', 'option', 'gold')$q$;
  v_new := $q$v_asset not in ('stock', 'option')$q$;
  if position(v_old in v_sql) = 0 then raise exception 'EXPECTED_OLD_ASSETS_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  v_old := $q$v_style not in ('swing', 'day', 'position')$q$;
  v_new := $q$v_style not in ('swing', 'position')$q$;
  if position(v_old in v_sql) = 0 then raise exception 'EXPECTED_OLD_STYLES_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  v_old := $q$or (v_lane = 'gold') <> (v_asset = 'gold')$q$;
  v_new := '';
  if position(v_old in v_sql) = 0 then raise exception 'EXPECTED_OLD_PAIRING_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  v_old := $q$if (v_intent in ('buy1', 'buy2', 'open', 'add')$q$;
  v_new := $q$if v_lane in ('swing', 'position') then$q$ || chr(10) ||
    $q$    if v_style is not null and v_style <> v_lane then$q$ || chr(10) ||
    $q$      raise exception 'LANE_STYLE_MISMATCH';$q$ || chr(10) ||
    $q$    end if;$q$ || chr(10) ||
    $q$    v_style := v_lane;$q$ || chr(10) ||
    $q$  end if;$q$ || chr(10) || v_old;
  if position(v_old in v_sql) = 0 then raise exception 'EXPECTED_INSERT_POINT_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  -- A manually created stock position has no lane; match only if its visible
  -- holding style agrees with the bot route. Never attach a Position fill to
  -- a Swing entry (or the reverse) merely because the ticker matches.
  v_old := $q$or (v_data->>'lane' is not null and v_data->>'lane' <> v_lane) then$q$;
  v_new := $q$or (v_data->>'lane' is not null and v_data->>'lane' <> v_lane)
      or (v_asset = 'stock' and v_data->>'tradeStyle' is distinct from v_lane) then$q$;
  if position(v_old in v_sql) = 0 then raise exception 'EXPECTED_KEY_MATCH_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  v_old := $q$and nullif(data->>'lane', '') is null$q$;
  v_new := $q$and nullif(data->>'lane', '') is null
        and (v_asset = 'option' or data->>'tradeStyle' = v_lane)$q$;
  if position(v_old in v_sql) = 0 then raise exception 'EXPECTED_MANUAL_MATCH_NOT_FOUND'; end if;
  v_sql := replace(v_sql, v_old, v_new);

  execute v_sql;
end;
$route_patch$;
