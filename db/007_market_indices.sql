-- 盤中最新一輪的加權／櫃買指數，跟個股報價同一個 run 保存。
-- 舊的盤中 run 允許為 NULL：它們沒有指數資料，不偽造歷史值。
alter table intraday_runs
    add column if not exists twse_index numeric(14, 4),
    add column if not exists twse_change_percent numeric(10, 4),
    add column if not exists tpex_index numeric(14, 4),
    add column if not exists tpex_change_percent numeric(10, 4);

-- 新欄位接在既有 view 欄位最後，符合 PostgreSQL CREATE OR REPLACE VIEW 的欄位相容規則。
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
    r.tpex_change_percent
from intraday_quotes q
join intraday_runs r on r.id = q.run_id
join securities s on s.id = q.security_id
where r.id = (
    select id from intraday_runs
    order by trade_date desc, captured_at desc
    limit 1
);

grant select on intraday_latest to anon;

insert into schema_migrations (filename) values ('007_market_indices.sql')
on conflict (filename) do nothing;
