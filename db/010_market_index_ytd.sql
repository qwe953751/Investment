-- 指數的年初至今漲跌幅，與盤中最新一輪的指數同一筆保存。
-- 計算基準由 C# MarketIndexPerformanceCalculator 統一產生；舊 run 允許為 NULL。

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
