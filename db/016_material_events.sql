-- 重大訊息。上市櫃公司依法要在公開資訊觀測站公告的那些事：併購、取得處分資產、
-- 法說會、董事會決議、澄清媒體報導……這是「催化事件」唯一一個免費而且權威的來源。
--
-- 為什麼要自己存一份：兩個來源都拿不到完整歷史。
--   openapi 的 t187ap04_L／mopsfin_t187ap04_O 是「滾動快照」，只給最近一個發言日，
--     但欄位最齊（有符合條款、有說明全文）。
--   觀測站的 t05st01 可以指定日期回查，但一列只有主旨，沒有條款也沒有說明。
-- 所以每天抓的那一份是資料最好的一份，錯過了就只能用主旨補回來。這張表就是那份累積。
--
-- 主鍵刻意不含發言時間：同一家公司同一天發同一則主旨就是同一件事。
-- 更正重發會改時間、觀測站回補跟當日抓取也會對不上秒數，含進去只會變成兩列一樣的事件。
--
-- 反過來說，回補進來的舊資料不可以把當日抓到的條款與說明蓋成 null，
-- 所以下面的 upsert 一律 coalesce(excluded.x, 舊值)：有值的那一邊贏，跟誰後寫無關。
--
-- 不設保留期。一年約三萬多列，留著不痛，而「這個族群上次有事件是什麼時候」
-- 本來就要往回翻很久才答得出來。
--
-- 備份要含這張表的內容——這點跟 daily_quotes、monthly_revenue 相反。
-- 那兩張掉了都能重抓，這張不行：條款與說明只有當天的 OpenAPI 給，
-- 事後回補只補得回主旨，掉了就是真的掉了。

create table if not exists material_events (
    ticker          text not null,
    announced_on    date not null,       -- 發言日期
    announced_time  time,                -- 發言時間，觀測站回補的那批沒有這欄
    subject         text not null,       -- 主旨
    subject_key     text generated always as (md5(subject)) stored,
    clause          text,                -- 符合條款，例如「第20款」。只有當日抓取那批有
    occurred_on     date,                -- 事實發生日，同上
    detail          text,                -- 說明全文，同上
    updated_at      timestamptz not null default now(),
    primary key (ticker, announced_on, subject_key)
);

create index if not exists material_events_announced_on_idx on material_events (announced_on);

alter table material_events enable row level security;

drop policy if exists "writer all" on material_events;

-- 網頁不直接讀這張表：事件是匯出靜態站時整批讀出來、分類、掛到族群上再寫進 topics.json，
-- 跟 monthly_revenue 一樣是後端原料，所以不開 anon。
create policy "writer all" on material_events for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on material_events to invest_writer;

insert into schema_migrations (filename) values ('016_material_events.sql')
on conflict (filename) do nothing;
