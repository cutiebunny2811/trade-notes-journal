-- Bot-ready execution ledger. The existing journal_trades row remains the
-- human-facing trade; each broker fill is a separate, deduplicated fact.
create table if not exists public.journal_fills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trade_id uuid not null references public.journal_trades(id) on delete cascade,
  source_key text not null check (char_length(source_key) between 1 and 300),
  source_platform text not null default 'manual',
  broker_execution_id text,
  side text not null check (side in ('buy', 'sell')),
  quantity numeric(20, 8) not null check (quantity > 0),
  unit_price numeric(20, 8) not null check (unit_price >= 0),
  multiplier numeric(12, 4) not null default 1 check (multiplier > 0),
  commission numeric(20, 8) not null default 0 check (commission >= 0),
  other_fees numeric(20, 8) not null default 0 check (other_fees >= 0),
  executed_at timestamptz not null,
  broker_time_text text,
  evidence_path text,
  created_at timestamptz not null default now(),
  unique (user_id, source_key)
);

create index if not exists journal_fills_trade_time_idx
  on public.journal_fills (trade_id, executed_at, created_at);
create unique index if not exists journal_trades_match_key_idx
  on public.journal_trades (user_id, (data ->> 'matchKey'))
  where nullif(data ->> 'matchKey', '') is not null;

alter table public.journal_fills enable row level security;
grant select, insert, update, delete on public.journal_fills to authenticated;

create policy "Users read own journal fills" on public.journal_fills
  for select to authenticated using (auth.uid() = user_id);
create policy "Users insert fills into own trades" on public.journal_fills
  for insert to authenticated with check (
    auth.uid() = user_id and exists (
      select 1 from public.journal_trades trade
      where trade.id = trade_id and trade.user_id = auth.uid()
    )
  );
create policy "Users update fills in own trades" on public.journal_fills
  for update to authenticated using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id and exists (
      select 1 from public.journal_trades trade
      where trade.id = trade_id and trade.user_id = auth.uid()
    )
  );
create policy "Users delete own journal fills" on public.journal_fills
  for delete to authenticated using (auth.uid() = user_id);
