-- 盤中最新一輪的個股日 K 當日棒。
-- 只保存當天的開、高、低；收盤欄位沿用 intraday_latest.price，盤後正式日 K 仍以 daily_quotes 為準。
alter table intraday_quotes
    add column if not exists open_price numeric(10, 2),
    add column if not exists high_price numeric(10, 2),
    add column if not exists low_price numeric(10, 2);

-- 新欄位接在既有 view 欄位最後，維持 PostgreSQL CREATE OR REPLACE VIEW 的欄位相容規則。
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
    q.open_price,
    q.high_price,
    q.low_price
from intraday_quotes q
join intraday_runs r on r.id = q.run_id
join securities s on s.id = q.security_id
where r.id = (
    select id from intraday_runs
    order by trade_date desc, captured_at desc
    limit 1
);

grant select on intraday_latest to anon;

insert into schema_migrations (filename) values ('008_intraday_kline.sql')
on conflict (filename) do nothing;
