-- 月營收。兩張表，分工跟行情那邊一樣：一張放原始資料，一張放畫面直接要用的東西。
--
-- monthly_revenue：每檔每月的單月營收，逐月往回堆。
--   權威在公開資訊觀測站（每月 10 日前申報上月營收），這裡只是查詢副本，
--   掉了重跑 `revenue --backfill` 就能補回來，所以備份刻意不含它的內容。
--   存在的理由是「創幾個月新高」得往回翻歷史，而 Action 裡沒有本機快取可翻。
--
-- revenue_latest：上個月那一格的計算結果，一檔一列，網頁直接讀這張。
--   為什麼不塞進靜態站的 data/*.json：營收在每月 1~10 日之間隨時會多出幾家，
--   靜態站一天只重算一次（18:00 export），中間公告的就要等隔天才看得到。
--   跟 market_flags 同一個理由、同一種做法：會在一天之內變動的東西不放 manifest。
--
-- 「上個月」的定義只有一個地方說了算：今天是 8 月，就只認 7 月。
-- 7 月還沒公告就顯示 —，不會退回去拿 6 月的數字頂替（那會讓人拿舊營收當新的看）。
-- 這張表只放上個月的資料，網頁那邊還會再比對一次月份，跨月當下這張表還沒重算也不會顯示錯的。

create table if not exists monthly_revenue (
    ticker      text not null,
    month       date not null,          -- 該月一號，例如 2026 年 7 月是 2026-07-01
    revenue     bigint not null,        -- 單月營收，單位是元（來源給的是千元，寫入前已經乘開）
    updated_at  timestamptz not null default now(),
    primary key (ticker, month)
);

create index if not exists monthly_revenue_month_idx on monthly_revenue (month);

create table if not exists revenue_latest (
    ticker         text primary key,
    month          date not null,       -- 這一列講的是哪個月，網頁會拿它跟「今天的上個月」比對
    revenue        bigint not null,
    yoy            double precision,    -- 跟去年同月比，沒有去年同月的資料就是 null
    mom            double precision,    -- 跟上一個月比
    high_months    integer,             -- 創幾個月新高；沒創高是 null
    record_high    boolean not null default false,  -- 手上歷史裡最高的一個月
    updated_at     timestamptz not null default now()
);

alter table monthly_revenue enable row level security;
alter table revenue_latest enable row level security;

drop policy if exists "writer all" on monthly_revenue;
drop policy if exists "public read" on revenue_latest;
drop policy if exists "writer all" on revenue_latest;

-- monthly_revenue 是後端算「創幾個月新高」用的原料，網頁不需要整份歷史，所以不開 anon。
create policy "writer all" on monthly_revenue for all to invest_writer using (true) with check (true);

create policy "public read" on revenue_latest for select to anon using (true);
create policy "writer all" on revenue_latest for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on monthly_revenue to invest_writer;

grant select on revenue_latest to anon;
grant select, insert, update, delete on revenue_latest to invest_writer;

insert into schema_migrations (filename) values ('006_revenue.sql')
on conflict (filename) do nothing;
