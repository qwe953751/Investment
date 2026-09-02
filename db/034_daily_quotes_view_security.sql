-- daily_quotes_view 原先沿用 PostgreSQL 預設的 view owner 權限，Supabase advisor
-- 因此將它列為 security-definer view。改成 security_invoker 後，匿名查詢仍須通過
-- daily_quotes 自己的 RLS，欄位與既有前端契約不變。
--
-- latest_us_quotes 會按 security_id 取最新交易日；補上同方向索引，避免每次讀十檔
-- 美股都掃描整張盤後行情副本。既有主鍵 (trade_date, security_id) 無法涵蓋這個順序。

create index if not exists daily_quotes_by_security_date
    on daily_quotes (security_id, trade_date desc);

create or replace view daily_quotes_view
with (security_invoker = true)
as
select
    d.trade_date,
    s.symbol,
    s.name,
    s.market,
    d.close_price,
    d.trading_value,
    d.trading_volume,
    d.transaction_count
from daily_quotes d
join securities s on s.id = d.security_id;

grant select on daily_quotes_view to anon;
grant select on daily_quotes_view to invest_writer;

insert into schema_migrations (filename) values ('034_daily_quotes_view_security.sql')
on conflict (filename) do nothing;
