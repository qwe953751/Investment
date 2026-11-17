-- 券商日末淨值是績效估值來源，與盤中持倉快照分開保存。
begin;

create table if not exists public.asset_performance_valuations (
    account_id uuid not null references public.asset_accounts (id) on delete cascade,
    valuation_date date not null check (
        isfinite(valuation_date) and valuation_date < (now() at time zone 'Asia/Taipei')::date
    ),
    net_value_twd numeric(18, 2) not null check (net_value_twd <> 'NaN'::numeric),
    updated_at timestamptz not null default now(),
    primary key (account_id, valuation_date)
);

alter table public.asset_performance_valuations enable row level security;
revoke all privileges on public.asset_performance_valuations
    from public, anon, authenticated, invest_writer, service_role;
grant select, insert, update, delete on public.asset_performance_valuations to authenticated;
-- 備份原結構的帳號需能鎖表，資料列只由加密備份角色讀取。
grant select on public.asset_performance_valuations to invest_writer, invest_backup_reader;

drop policy if exists "asset performance admin" on public.asset_performance_valuations;
create policy "asset performance admin" on public.asset_performance_valuations
    for all to authenticated
    using ((select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin')
    with check ((select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin');

drop policy if exists "protected backup read" on public.asset_performance_valuations;
create policy "protected backup read" on public.asset_performance_valuations
    for select to invest_backup_reader using (true);

insert into public.schema_migrations (filename) values ('076_asset_performance_valuations.sql')
on conflict (filename) do nothing;

commit;
