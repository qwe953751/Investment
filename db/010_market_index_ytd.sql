-- 指數的年初至今漲跌幅，與盤中最新一輪的指數同一筆保存。
-- 計算基準由 C# MarketIndexPerformanceCalculator 統一產生；舊 run 允許為 NULL。
--
-- 重貼 view 的時候，欄位只能往後加，不能少也不能改名或換順序：
-- Postgres 的 create or replace view 遇到這種情況會直接擋下來（42P16 cannot drop columns from view）。
-- 所以下面必須把 008 加的 open_price／high_price／low_price 原封不動照抄，
-- 新的兩個欄位接在最後面。漏抄的話這支 SQL 在任何已經套過 008 的資料庫上都套不下去。

alter table intraday_runs
    add column if not exists twse_year_to_date_change_percent numeric(10, 4),
    add column if not exists tpex_year_to_date_change_percent numeric(10, 4);

create or replace view intraday_latest as
select
    s.symbol,
    s.name,
    s.market,
    q.price,
    q.turnover,
    q.change_percent,
    r.trade_date,
    r.captured_at,
    r.twse_index,
    r.twse_change_percent,
    r.tpex_index,
    r.tpex_change_percent,
    q.open_price,
    q.high_price,
    q.low_price,
    r.twse_year_to_date_change_percent,
    r.tpex_year_to_date_change_percent
from intraday_quotes q
join intraday_runs r on r.id = q.run_id
join securities s on s.id = q.security_id
where r.id = (
    select id from intraday_runs
    order by trade_date desc, captured_at desc
    limit 1
);

grant select on intraday_latest to anon;

insert into schema_migrations (filename) values ('010_market_index_ytd.sql')
on conflict (filename) do nothing;
