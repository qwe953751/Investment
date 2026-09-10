-- Dashboard 與帳戶明細的年度總資產／淨資產資料。
--
-- 當年度不是資料庫快照：前端每次載入都用目前資產狀態自動帶入，
-- 因此不會被手動編輯或刪除。這張表只保存使用者自行建立的歷史年度，
-- 讓年度資料能跨裝置使用，並支援歷史總資產的編輯與刪除。

create table if not exists asset_annual_snapshots (
    id               uuid primary key default gen_random_uuid(),
    owner_id         uuid references asset_owners (id) on delete cascade,
    account_id       uuid references asset_accounts (id) on delete cascade,
    snapshot_year    integer not null check (snapshot_year between 2000 and 2100),
    total_assets_twd numeric(18, 2) not null check (total_assets_twd >= 0),
    cost_twd         numeric(18, 2) not null check (cost_twd >= 0),
    updated_at       timestamptz not null default now(),
    constraint asset_annual_snapshots_one_scope
        check ((owner_id is not null) <> (account_id is not null))
);

create unique index if not exists asset_annual_snapshots_owner_year
    on asset_annual_snapshots (owner_id, snapshot_year)
    where owner_id is not null;

create unique index if not exists asset_annual_snapshots_account_year
    on asset_annual_snapshots (account_id, snapshot_year)
    where account_id is not null;

alter table asset_annual_snapshots enable row level security;

drop policy if exists "public read" on asset_annual_snapshots;
drop policy if exists "public insert" on asset_annual_snapshots;
drop policy if exists "public update" on asset_annual_snapshots;
drop policy if exists "public delete" on asset_annual_snapshots;
drop policy if exists "writer all" on asset_annual_snapshots;

-- 沿用 db/019_assets.sql 與既有資產快照的匿名存取契約；網站本身仍只在最高權限
-- 顯示可寫入的資產頁。登入／RLS 收緊時，本表要與資產主表一起調整。
create policy "public read" on asset_annual_snapshots
    for select to anon using (true);
create policy "public insert" on asset_annual_snapshots
    for insert to anon with check (true);
create policy "public update" on asset_annual_snapshots
    for update to anon using (true) with check (true);
create policy "public delete" on asset_annual_snapshots
    for delete to anon using (true);
create policy "writer all" on asset_annual_snapshots
    for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on asset_annual_snapshots to anon;
grant select, insert, update, delete on asset_annual_snapshots to invest_writer;

insert into schema_migrations (filename) values ('048_asset_annual_snapshots.sql')
on conflict (filename) do nothing;
