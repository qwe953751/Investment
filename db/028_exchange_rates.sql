-- 每日外幣參考匯率與美股最新收盤價。
--
-- USD/TWD 由台股盤後 workflow 向臺灣期貨交易所 OpenAPI 取得，一天保存一筆，
-- 不讓每一台瀏覽器各自呼叫外部 API。歷史值保留下來，日後才能追查某天資產總值
-- 使用的是哪一個匯率；不使用「只有一列、每天覆蓋」的不可追溯做法。

create table if not exists exchange_rates (
    rate_date      date not null,
    base_currency  text not null check (base_currency ~ '^[A-Z]{3}$'),
    quote_currency text not null check (quote_currency ~ '^[A-Z]{3}$'),
    rate           numeric(18, 6) not null check (rate > 0),
    source         text not null,
    updated_at     timestamptz not null default now(),
    primary key (rate_date, base_currency, quote_currency)
);

create index if not exists exchange_rates_pair_date
    on exchange_rates (base_currency, quote_currency, rate_date desc);

alter table exchange_rates enable row level security;

drop policy if exists "public read" on exchange_rates;
drop policy if exists "writer all" on exchange_rates;

create policy "public read" on exchange_rates
    for select to anon using (true);

create policy "writer all" on exchange_rates
    for all to invest_writer using (true) with check (true);

grant select on exchange_rates to anon;
grant select, insert, update, delete on exchange_rates to invest_writer;

-- 資產頁只需要每檔美股最新一個交易日的收盤價。若直接讀 daily_quotes_view，
-- 兩檔 100 天就要傳 200 列；這個 security-invoker view 只回每檔一列，仍受底層
-- daily_quotes 的 RLS 與 grant 約束。
create or replace view latest_us_quotes
with (security_invoker = true)
as
select distinct on (s.symbol)
    s.symbol,
    s.name,
    d.trade_date,
    d.close_price
from daily_quotes d
join securities s on s.id = d.security_id
where s.market = 'US'
order by s.symbol, d.trade_date desc;

grant select on latest_us_quotes to anon;
grant select on latest_us_quotes to invest_writer;

insert into schema_migrations (filename) values ('028_exchange_rates.sql')
on conflict (filename) do nothing;
