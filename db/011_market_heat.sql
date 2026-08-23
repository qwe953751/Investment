-- 市場熱絡程度與盤中快照同一輪保存。
-- 分數由 C# MarketHeatCalculator 產生，這裡只增加可讀欄位，不在資料庫重算。

alter table intraday_runs
    add column if not exists market_heat_score numeric(10, 6),
    add column if not exists market_heat_short_trend_score numeric(10, 6),
    add column if not exists market_heat_breadth_score numeric(10, 6),
    add column if not exists market_heat_volume_score numeric(10, 6),
    add column if not exists market_heat_index_daily_change_percent numeric(10, 6),
    add column if not exists market_heat_index_weekly_change_percent numeric(10, 6),
    add column if not exists market_heat_up_count integer,
    add column if not exists market_heat_down_count integer,
    add column if not exists market_heat_flat_count integer,
    add column if not exists market_heat_compared_stock_count integer,
    add column if not exists market_heat_turnover numeric(20, 2),
    add column if not exists market_heat_average_turnover numeric(20, 2),
    add column if not exists market_heat_volume_ratio numeric(10, 6);

-- 既有 007／008／010 的 view 欄位順序曾經不同；先重建成完整欄位，
-- 避免 CREATE OR REPLACE VIEW 因為無法移除舊欄位而卡住。
drop view if exists intraday_latest;

create view intraday_latest
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
    r.market_heat_volume_ratio
from intraday_quotes q
join intraday_runs r on r.id = q.run_id
join securities s on s.id = q.security_id
where r.id = (
    select id from intraday_runs
    order by trade_date desc, captured_at desc
    limit 1
);

grant select on intraday_latest to anon;

insert into schema_migrations (filename) values ('011_market_heat.sql')
on conflict (filename) do nothing;
