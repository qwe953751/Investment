-- 資產帳戶的出入金明細。
--
-- 入金成本不另存帳戶加總欄位，而是由入金合計減出金合計得到；
-- 每一筆保留日期、方向與備註，才能追溯並支援多筆紀錄。
-- 套用本 migration 後，前端的「入金成本」欄位才會解除停用。

create table if not exists asset_cash_flows (
    id         uuid primary key default gen_random_uuid(),
    account_id uuid not null references asset_accounts (id) on delete cascade,
    flow_date  date not null,
    direction  text not null check (direction in ('deposit', 'withdrawal')),
    amount     numeric(18, 2) not null check (amount > 0),
    note       text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists asset_cash_flows_by_account_date
    on asset_cash_flows (account_id, flow_date desc, created_at desc);

alter table asset_cash_flows enable row level security;

drop policy if exists "public read" on asset_cash_flows;
drop policy if exists "public write" on asset_cash_flows;
drop policy if exists "writer all" on asset_cash_flows;

create policy "public read" on asset_cash_flows
    for select to anon using (true);

-- 見 db/019_assets.sql 檔頭說明：登入與 RLS 白名單尚未完成前，
-- 資產頁沿用 anon 寫入的既有取捨。
create policy "public write" on asset_cash_flows
    for all to anon using (true) with check (true);

create policy "writer all" on asset_cash_flows
    for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on asset_cash_flows to anon;
grant select, insert, update, delete on asset_cash_flows to invest_writer;

insert into schema_migrations (filename) values ('030_asset_cash_flows.sql')
on conflict (filename) do nothing;
