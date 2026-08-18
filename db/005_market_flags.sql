-- 盤中畫面要用的交易限制名單：處置、全額交割。
--
-- 為什麼不能沿用 manifest.json 裡的那份：manifest 只在盤後 export 時（約 18:00）重抓一次，
-- 抓到的是「當下」誰被限制，之後整個交易日的盤中畫面都共用同一份沒再更新過的快照。
-- 處置期滿、全額交割解除的時間點不是卡在收盤後，跨過午夜到隔天盤中，
-- manifest 裡的名單就可能是昨天甚至更早之前的
-- （2026-08-18 盤中曾把 3081 錯標成處置中，它其實已經在 08-18 之前解禁）。
--
-- 這張表由盤中 Action 在開場第一輪整批重寫一次，之後同一個交易時段不會再變——
-- 處置與全額交割公告不會在交易時段中途生效，所以一天抓一次就夠，不必每輪都打一次。
-- 盤中頁面直接讀這張表，不再跟盤後畫面共用 manifest 那份快照。

create table if not exists market_flags (
    ticker                        text primary key,
    disposition_period            text,
    disposition_matching_minutes  integer,
    altered_trading               boolean not null default false,
    updated_at                    timestamptz not null default now()
);

alter table market_flags enable row level security;

drop policy if exists "public read" on market_flags;
drop policy if exists "writer all" on market_flags;

create policy "public read" on market_flags for select to anon using (true);
create policy "writer all" on market_flags for all to invest_writer using (true) with check (true);

grant select on market_flags to anon;
grant select, insert, update, delete on market_flags to invest_writer;

insert into schema_migrations (filename) values ('005_market_flags.sql')
on conflict (filename) do nothing;
