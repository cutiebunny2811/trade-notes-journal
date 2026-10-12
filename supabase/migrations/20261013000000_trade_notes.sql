-- Trade Notes: private per-user journal and screenshot storage.
create table if not exists public.journal_trades (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists journal_trades_user_id_idx on public.journal_trades(user_id);
alter table public.journal_trades enable row level security;
grant select, insert, update, delete on public.journal_trades to authenticated;
create policy "Users read own journal trades" on public.journal_trades for select to authenticated using (auth.uid() = user_id);
create policy "Users insert own journal trades" on public.journal_trades for insert to authenticated with check (auth.uid() = user_id);
create policy "Users update own journal trades" on public.journal_trades for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users delete own journal trades" on public.journal_trades for delete to authenticated using (auth.uid() = user_id);

create table if not exists public.journal_setups (
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  created_at timestamptz not null default now(),
  primary key (user_id, name)
);
alter table public.journal_setups enable row level security;
grant select, insert, update, delete on public.journal_setups to authenticated;
create policy "Users read own journal setups" on public.journal_setups for select to authenticated using (auth.uid() = user_id);
create policy "Users insert own journal setups" on public.journal_setups for insert to authenticated with check (auth.uid() = user_id);
create policy "Users update own journal setups" on public.journal_setups for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users delete own journal setups" on public.journal_setups for delete to authenticated using (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trade-images', 'trade-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "Users read own trade images" on storage.objects for select to authenticated
  using (bucket_id = 'trade-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users upload own trade images" on storage.objects for insert to authenticated
  with check (bucket_id = 'trade-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users delete own trade images" on storage.objects for delete to authenticated
  using (bucket_id = 'trade-images' and (storage.foldername(name))[1] = auth.uid()::text);
