-- 指數 K 線的盤中當日棒。
--
-- 指數日 K 的歷史開高低收由 data branch 的官方快照提供；盤中則把 MIS 的
-- 開高低與目前指數跟個股快照寫在同一個 intraday_runs，讓前端切到盤中時
-- 不會把前一交易日的指數棒誤當成今天。
--
-- 這支 migration 必須在明確授權後獨立套用，不能混進網站發布流程。

alter table intraday_runs
    add column if not exists twse_index_open numeric(14, 4),
    add column if not exists twse_index_high numeric(14, 4),
    add column if not exists twse_index_low numeric(14, 4),
    add column if not exists tpex_index_open numeric(14, 4),
    add column if not exists tpex_index_high numeric(14, 4),
    add column if not exists tpex_index_low numeric(14, 4);

-- 既有欄位順序全部保留，新欄位只接在 view 末端，避免既有前端查詢的欄位位置改變。
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
    r.market_heat_volume_ratio,
    r.market_heat_previous_turnover,
    r.market_heat_turnover_change,
    r.market_heat_turnover_change_rate,
    r.twse_index_open,
    r.twse_index_high,
    r.twse_index_low,
    r.tpex_index_open,
    r.tpex_index_high,
    r.tpex_index_low
from intraday_quotes q
join intraday_runs r on r.id = q.run_id
join securities s on s.id = q.security_id
where r.id = (
    select id from intraday_runs
    order by trade_date desc, captured_at desc
    limit 1
);

grant select on intraday_latest to anon;

insert into schema_migrations (filename) values ('021_market_index_kline.sql')
on conflict (filename) do nothing;
