-- 資產：從瀏覽器 localStorage 改成直接讀寫 Supabase。
--
-- 原本的資產頁把使用者、帳戶與金額存在 localStorage，換一台裝置就看不到，
-- 清一次瀏覽器資料就全沒了。使用者要求「實作與資料庫串接」，所以搬到這裡。
--
-- 權限沿用 db/015_notes.sql 檔頭那個已知情的取捨：純靜態網站沒有伺服器可以擋
-- 登入邊界，要做到「任何裝置打開網站就能編輯」，只能把匿名金鑰本身當成寫入權杖。
-- 也就是任何知道網址與 anon key（本來就寫在 manifest.json 裡）的人，都能讀寫
-- 這三張表。資產金額比筆記敏感，所以：
--
--   * 這裡只存「使用者自己填或截圖辨識出來的數字」，不存券商帳號、密碼或任何
--     可以下單的東西，也不存原始截圖。
--   * 資產頁本來就只在最高權限（admin）網址顯示，檢視網址看不到這個頁籤。
--   * 之後真的做登入時，要先讓登入頂上再收回 anon 的寫入權限，不能只把政策
--     改回唯讀——那樣資產頁會直接壞掉。

-- 使用者。同一個人可能幫家人一起看，所以不是只有一位。
create table if not exists asset_owners (
    id         uuid primary key default gen_random_uuid(),
    name       text not null default '',
    sort_order integer not null default 0,
    updated_at timestamptz not null default now()
);

-- 帳戶。cash 與 realized 由使用者自己填：現金餘額與累計已實現損益在券商的
-- 未實現損益畫面上看不到，截圖辨識不出來。
create table if not exists asset_accounts (
    id         uuid primary key default gen_random_uuid(),
    owner_id   uuid not null references asset_owners (id) on delete cascade,
    name       text not null default '',
    market     text not null default '台股',
    broker     text not null default '',
    cash       numeric(18, 2) not null default 0,
    realized   numeric(18, 2) not null default 0,
    sort_order integer not null default 0,
    updated_at timestamptz not null default now()
);

-- 持倉。這是帳戶市值與未實現損益的唯一來源：帳戶層不另外存一份加總，
-- 免得截圖更新了持倉、帳戶那份卻忘了跟著改，兩個數字對不起來。
--
-- quantity/cost/market_value/unrealized 允許 null：券商截圖能辨識到哪幾欄
-- 不一定，寧可留空顯示「—」，也不要塞 0 讓人以為真的是零。
create table if not exists asset_holdings (
    id           uuid primary key default gen_random_uuid(),
    account_id   uuid not null references asset_accounts (id) on delete cascade,
    ticker       text not null default '',
    name         text not null default '',
    quantity     numeric(18, 4),
    cost         numeric(18, 2),
    market_value numeric(18, 2),
    unrealized   numeric(18, 2),
    source       text not null default 'manual' check (source in ('manual', 'ocr')),
    sort_order   integer not null default 0,
    updated_at   timestamptz not null default now()
);

create index if not exists asset_accounts_by_owner on asset_accounts (owner_id, sort_order);
create index if not exists asset_holdings_by_account on asset_holdings (account_id, sort_order);

alter table asset_owners enable row level security;
alter table asset_accounts enable row level security;
alter table asset_holdings enable row level security;

drop policy if exists "public read" on asset_owners;
drop policy if exists "public write" on asset_owners;
drop policy if exists "writer all" on asset_owners;
drop policy if exists "public read" on asset_accounts;
drop policy if exists "public write" on asset_accounts;
drop policy if exists "writer all" on asset_accounts;
drop policy if exists "public read" on asset_holdings;
drop policy if exists "public write" on asset_holdings;
drop policy if exists "writer all" on asset_holdings;

create policy "public read" on asset_owners for select to anon using (true);
create policy "public read" on asset_accounts for select to anon using (true);
create policy "public read" on asset_holdings for select to anon using (true);

-- 見檔頭說明：跟 notes 一樣故意讓 anon 可寫。
create policy "public write" on asset_owners for all to anon using (true) with check (true);
create policy "public write" on asset_accounts for all to anon using (true) with check (true);
create policy "public write" on asset_holdings for all to anon using (true) with check (true);

create policy "writer all" on asset_owners for all to invest_writer using (true) with check (true);
create policy "writer all" on asset_accounts for all to invest_writer using (true) with check (true);
create policy "writer all" on asset_holdings for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on asset_owners to anon;
grant select, insert, update, delete on asset_accounts to anon;
grant select, insert, update, delete on asset_holdings to anon;
grant select, insert, update, delete on asset_owners to invest_writer;
grant select, insert, update, delete on asset_accounts to invest_writer;
grant select, insert, update, delete on asset_holdings to invest_writer;

insert into schema_migrations (filename) values ('019_assets.sql')
on conflict (filename) do nothing;
