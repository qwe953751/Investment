-- 帳戶明細頁的每日總值歷史（db/035_asset_value_snapshots.sql 的帳戶層級版本）。
--
-- 每個帳戶每天只有一筆，前端只有在當日尚無快照或使用者修改該帳戶內容時才寫入；
-- 一般每分鐘重讀只會查詢，不會反覆新增資料。今日折線仍以頁面即時計算值顯示，
-- 這張表負責跨裝置保存已經走過的日期。與 asset_value_snapshots（使用者總表）
-- 各自獨立，不互相取代：後者是「所有帳戶加總」，這張是單一帳戶自己的歷史。

create table if not exists asset_account_value_snapshots (
    account_id      uuid not null references asset_accounts (id) on delete cascade,
    snapshot_date   date not null,
    total_value_twd numeric not null,
    market_value_twd numeric,
    cash_twd        numeric,
    cost_twd        numeric,
    unrealized_twd  numeric,
    updated_at      timestamptz not null default now(),
    primary key (account_id, snapshot_date)
);

alter table asset_account_value_snapshots enable row level security;

drop policy if exists "public read" on asset_account_value_snapshots;
drop policy if exists "public insert" on asset_account_value_snapshots;
drop policy if exists "public update" on asset_account_value_snapshots;
drop policy if exists "public delete" on asset_account_value_snapshots;
drop policy if exists "writer all" on asset_account_value_snapshots;

-- 與 db/019_assets.sql 目前已知且文件化的匿名資產存取契約一致；登入驗收後，
-- 這張表應和 asset_owners / asset_accounts / asset_holdings / asset_value_snapshots
-- 一起收緊。
create policy "public read" on asset_account_value_snapshots
    for select to anon using (true);
create policy "public insert" on asset_account_value_snapshots
    for insert to anon with check (true);
create policy "public update" on asset_account_value_snapshots
    for update to anon using (true) with check (true);
create policy "public delete" on asset_account_value_snapshots
    for delete to anon using (true);
create policy "writer all" on asset_account_value_snapshots
    for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on asset_account_value_snapshots to anon;
grant select, insert, update, delete on asset_account_value_snapshots to invest_writer;

insert into schema_migrations (filename) values ('037_asset_account_value_snapshots.sql')
on conflict (filename) do nothing;
