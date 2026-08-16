-- 盤後行情。貼進 Supabase 的 SQL Editor 執行即可，可重複執行。
--
-- 這裡只放最近 300 個交易日的工作副本：每天補進當日、砍掉最舊一天。
-- 完整歷史仍然以 JSON 留在 GitHub 的 data 分支，且只增不刪，
-- 所以資料庫任何時候都能從原始檔重建。

create table if not exists daily_quotes (
    trade_date        date not null,
    security_id       integer not null references securities(id),
    close_price       numeric(10, 2),
    trading_value     bigint not null,
    trading_volume    bigint not null,
    transaction_count integer not null default 0,
    primary key (trade_date, security_id)
);

create index if not exists daily_quotes_date on daily_quotes (trade_date desc);

-- 手機端讀排行時要的欄位都在這，不必自己 join 基本資料。
create or replace view daily_quotes_view as
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

alter table daily_quotes enable row level security;

drop policy if exists "public read" on daily_quotes;
drop policy if exists "writer all" on daily_quotes;

create policy "public read" on daily_quotes for select to anon using (true);
create policy "writer all" on daily_quotes for all to invest_writer using (true) with check (true);

grant select on daily_quotes, daily_quotes_view to anon;
grant select, insert, update, delete on daily_quotes to invest_writer;

insert into schema_migrations (filename) values ('002_daily.sql')
on conflict (filename) do nothing;
