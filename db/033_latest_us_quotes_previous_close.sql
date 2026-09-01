-- latest_us_quotes 補上前一個有效收盤價。
--
-- 資產頁以它計算美股名稱右側的當日漲跌幅；只回傳每檔最新一列，仍沿用
-- security_invoker、既有 RLS 與 grant。新增欄位放在既有欄位最後，符合
-- PostgreSQL create or replace view 的相容規則。

create or replace view latest_us_quotes
with (security_invoker = true)
as
select
    latest.symbol,
    latest.name,
    latest.trade_date,
    latest.close_price,
    latest.previous_close_price
from (
    select
        s.symbol,
        s.name,
        d.trade_date,
        d.close_price,
        lag(d.close_price) over (
            partition by d.security_id
            order by d.trade_date) as previous_close_price,
        row_number() over (
            partition by d.security_id
            order by d.trade_date desc) as latest_rank
    from daily_quotes d
    join securities s on s.id = d.security_id
    where s.market = 'US'
) latest
where latest.latest_rank = 1;

grant select on latest_us_quotes to anon;
grant select on latest_us_quotes to invest_writer;

insert into schema_migrations (filename) values ('033_latest_us_quotes_previous_close.sql')
on conflict (filename) do nothing;
