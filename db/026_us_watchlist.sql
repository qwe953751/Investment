-- 美股觀察清單。backfill-us 只讀 is_active 的列；觀察清單可能包含還沒買的股票，
-- 資產表只是清單的其中一個消費者，兩者資料模型仍然刻意分開。
--
-- 新增 ticker 已改成自動同步（backfill-us 執行時由
-- UsWatchlistStore.SyncFromHoldingsAsync 從 asset_holdings 補齊持倉裡有、
-- 清單裡沒有的美股 ticker，2026-09-03 起），不用再手動來這裡新增一列。
-- 停用、改名、調整排序等既有列的維護仍然只能走 Supabase Studio——沒有開放
-- anon 寫入：亂寫一檔就會在下次排程吃掉一次 Alpha Vantage 額度（免費方案
-- 25 次/日），只有真的持有的股票才會被自動加進來，維護既有列的風險比照舊規則
-- 留在人工這一邊。
--
-- 提醒：daily_quotes / daily_quotes_view 從這個 migration 之後會混進美股（USD、
-- 估算成交值）列，任何要跨市場加總或排序 trading_value／close_price 的功能，
-- 都必須先用 market 分流，不能直接對整張表做全市場運算。

create table if not exists us_watchlist (
    id uuid primary key default gen_random_uuid(),
    ticker text not null unique,
    name text not null,
    is_active boolean not null default true,
    sort_order integer not null default 0,
    backfilled_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists us_watchlist_active_sort_idx
    on us_watchlist (is_active, sort_order);

alter table us_watchlist enable row level security;

create policy "public read" on us_watchlist
    for select
    to anon
    using (true);

create policy "writer all" on us_watchlist
    for all
    to invest_writer
    using (true)
    with check (true);

insert into schema_migrations (filename) values ('026_us_watchlist.sql')
on conflict (filename) do nothing;
