-- 盤中快照的資料表。貼進 Supabase 的 SQL Editor 執行即可，可重複執行。
--
-- 拆成三張表是為了省空間：每 2 分鐘一輪、每輪約 2000 檔，一天約三十九萬列。
-- 把「哪一輪抓的」與「哪一檔股票」抽成獨立的表之後，明細列只留數字，
-- 連索引實測是一列 171 bytes，一天約 63 MB。
--
-- 撐得住的前提是「下一個有效交易日寫入成功後，刪掉舊日期」
-- （見 IntradayQuoteStore.DeleteSupersededRunsAsync），所以盤中資料只保留最新交易日。
-- 休市或來源失敗時沒有新快照進入 transaction，舊資料不會被先刪。
-- 新交易日寫入失敗時會繼續留著舊日期；一旦新快照成功，舊輪次當場清理。

create table if not exists securities (
    id          integer generated always as identity primary key,
    symbol      text not null unique,
    name        text not null,
    market      text not null check (market in ('TWSE', 'TPEX'))
);

-- 一次收集 = 一列。source 記錄是誰抓的（GitHub Actions／Mac／公司電腦），
-- 盤中若由不同裝置接力，可以看出哪一段是誰補的。
create table if not exists intraday_runs (
    id           bigint generated always as identity primary key,
    trade_date   date not null,
    captured_at  timestamptz not null,
    source       text not null,
    quote_count  integer not null default 0,
    unique (trade_date, captured_at, source)
);

create table if not exists intraday_quotes (
    run_id         bigint not null references intraday_runs(id) on delete cascade,
    security_id    integer not null references securities(id),
    price          numeric(10, 2),
    turnover       bigint not null,
    change_percent numeric(6, 2),
    primary key (run_id, security_id)
);

create index if not exists intraday_runs_date_time
    on intraday_runs (trade_date, captured_at desc);

-- 手機直接讀這個 view，一次拿到最新一輪的排行，不必自己 join。
create or replace view intraday_latest as
select
    s.symbol,
    s.name,
    s.market,
    q.price,
    q.turnover,
    q.change_percent,
    r.trade_date,
    r.captured_at
from intraday_quotes q
join intraday_runs r on r.id = q.run_id
join securities s on s.id = q.security_id
where r.id = (
    select id from intraday_runs
    order by trade_date desc, captured_at desc
    limit 1
);

-- 權限：手機端用公開的 publishable key 讀取，只給 select，寫入一律走
-- 連線字串（service 權限），所以 anon 沒有任何寫入能力。
-- invest_writer 這個角色本身在 000_migrations.sql 建立。
alter table securities      enable row level security;
alter table intraday_runs   enable row level security;
alter table intraday_quotes enable row level security;

drop policy if exists "public read" on securities;
drop policy if exists "public read" on intraday_runs;
drop policy if exists "public read" on intraday_quotes;
drop policy if exists "writer all" on securities;
drop policy if exists "writer all" on intraday_runs;
drop policy if exists "writer all" on intraday_quotes;

create policy "public read" on securities      for select to anon using (true);
create policy "public read" on intraday_runs   for select to anon using (true);
create policy "public read" on intraday_quotes for select to anon using (true);

create policy "writer all" on securities      for all to invest_writer using (true) with check (true);
create policy "writer all" on intraday_runs   for all to invest_writer using (true) with check (true);
create policy "writer all" on intraday_quotes for all to invest_writer using (true) with check (true);

grant select on securities, intraday_runs, intraday_quotes, intraday_latest to anon;
grant select, insert, update, delete on all tables in schema public to invest_writer;
grant usage, select on all sequences in schema public to invest_writer;

insert into schema_migrations (filename) values ('001_intraday.sql')
on conflict (filename) do nothing;
