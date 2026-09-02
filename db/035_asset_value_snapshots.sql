-- 資產 Dashboard 的每日總值歷史。
--
-- 每位使用者每天只有一筆，前端只有在當日尚無快照或使用者修改資產內容時才寫入；
-- 一般每分鐘重讀只會查詢，不會反覆新增資料。今日折線仍以頁面即時計算值顯示，
-- 這張表負責跨裝置保存已經走過的日期。

create table if not exists asset_value_snapshots (
    owner_id        uuid not null references asset_owners (id) on delete cascade,
    snapshot_date   date not null,
    total_value_twd numeric not null,
    market_value_twd numeric,
    cash_twd        numeric,
    cost_twd        numeric,
    unrealized_twd  numeric,
    updated_at      timestamptz not null default now(),
    primary key (owner_id, snapshot_date)
);

alter table asset_value_snapshots enable row level security;

drop policy if exists "public read" on asset_value_snapshots;
drop policy if exists "public insert" on asset_value_snapshots;
drop policy if exists "public update" on asset_value_snapshots;
drop policy if exists "public delete" on asset_value_snapshots;
drop policy if exists "writer all" on asset_value_snapshots;

-- 與 db/019_assets.sql 目前已知且文件化的匿名資產存取契約一致；登入驗收後，
-- 這張表應和 asset_owners / asset_accounts / asset_holdings 一起收緊。
create policy "public read" on asset_value_snapshots
    for select to anon using (true);
create policy "public insert" on asset_value_snapshots
    for insert to anon with check (true);
create policy "public update" on asset_value_snapshots
    for update to anon using (true) with check (true);
create policy "public delete" on asset_value_snapshots
    for delete to anon using (true);
create policy "writer all" on asset_value_snapshots
    for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on asset_value_snapshots to anon;
grant select, insert, update, delete on asset_value_snapshots to invest_writer;

insert into schema_migrations (filename) values ('035_asset_value_snapshots.sql')
on conflict (filename) do nothing;
