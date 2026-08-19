-- 盤中的全市場累計成交額曲線。一輪一列，一天約 197 列。
--
-- 為什麼要獨立一張表：intraday_runs / intraday_quotes 在當天盤後資料補齊後會整批刪除
-- （見 DailyQuoteSyncStore.DeleteSettledIntradayAsync），一天三十九萬列留不起。
-- 但「量在一天之內是怎麼跑出來的」這件事只有盤中看得到，盤後行情裡沒有，
-- 刪掉之後永遠算不回來。所以每一輪順手把全市場合計抽成一列留著，一年約五萬列。
--
-- 用途：把當日成交額預估的分母從「時間過了幾成」換成「量通常跑了幾成」。
-- 台股的量是 U 型的，開盤與尾盤爆量、中午乾涸，用時間當分母早盤會高估、中午會低估。

create table if not exists intraday_curve (
    trade_date     date not null,
    captured_at    timestamptz not null,
    turnover_total bigint not null,
    quote_count    integer not null,
    primary key (trade_date, captured_at)
);

alter table intraday_curve enable row level security;

drop policy if exists "public read" on intraday_curve;
drop policy if exists "writer all" on intraday_curve;

create policy "public read" on intraday_curve for select to anon using (true);
create policy "writer all" on intraday_curve for all to invest_writer using (true) with check (true);

grant select on intraday_curve to anon;
grant select, insert, update, delete on intraday_curve to invest_writer;

insert into schema_migrations (filename) values ('004_intraday_curve.sql')
on conflict (filename) do nothing;
