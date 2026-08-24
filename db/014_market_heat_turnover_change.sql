-- 盤後只顯示正式全市場成交額；盤中才保存估算成交額相較前一交易日的變化。
-- 所有數字都由 C# MarketHeatCalculator 產生；資料庫只保存同一輪盤中快照的結果。

alter table intraday_runs
    add column if not exists market_heat_previous_turnover numeric(20, 2),
    add column if not exists market_heat_turnover_change numeric(20, 2),
    add column if not exists market_heat_turnover_change_rate numeric(10, 6);

-- 新欄位只加在既有 view 的末端，CREATE OR REPLACE 不會改變舊欄位的順序。
create or replace view intraday_latest
with (security_invoker = true) as
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
    r.twse_year_to_date_change_percent,
    r.tpex_year_to_date_change_percent,
    q.open_price,
    q.high_price,
    q.low_price,
    r.market_heat_score,
    r.market_heat_short_trend_score,
    r.market_heat_breadth_score,
    r.market_heat_volume_score,
    r.market_heat_index_daily_change_percent,
    r.market_heat_index_weekly_change_percent,
    r.market_heat_up_count,
    r.market_heat_down_count,
    r.market_heat_flat_count,
    r.market_heat_compared_stock_count,
    r.market_heat_turnover,
    r.market_heat_average_turnover,
    r.market_heat_volume_ratio,
    r.market_heat_previous_turnover,
    r.market_heat_turnover_change,
    r.market_heat_turnover_change_rate
from intraday_quotes q
join intraday_runs r on r.id = q.run_id
join securities s on s.id = q.security_id
where r.id = (
    select id from intraday_runs
    order by trade_date desc, captured_at desc
    limit 1
);

grant select on intraday_latest to anon;

insert into schema_migrations (filename) values ('014_market_heat_turnover_change.sql')
on conflict (filename) do nothing;
