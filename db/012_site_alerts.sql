-- 自動流程的異常紀錄，給網站上的通知鈴鐺讀。
--
-- 為什麼不寫進 manifest.json：最需要被通知的情況正是「靜態網站沒發佈成功」。
-- 那時候線上那份 HTML 與 manifest 都還是舊的，任何寫進快照裡的訊息都送不出去。
-- 所以異常要放在網站之外、而且前端本來就連得到的地方——盤中頁已經在讀這個資料庫。
--
-- 只記「需要人去看一眼」的事，不記流水帳：心跳有 heartbeat、每一輪的細節有 Actions 日誌。
-- 這張表的每一列都應該對應到一次「畫面上的數字可能不對」。
--
-- 保留 90 天，比 heartbeat 的 180 天短：異常訊息過了三個月就只剩考古價值。

create table if not exists site_alerts (
    id          bigint generated always as identity primary key,
    raised_at   timestamptz not null default now(),

    -- 哪個流程出的事，例如「每日排行快照」「盤中報價收集」。
    -- 同一個 source 的舊警報會在下一次成功時一起解除，所以名字要固定。
    source      text not null,

    -- 只有兩種：error 是畫面上的數字可能不對，warning 是有事發生但數字還可信。
    severity    text not null check (severity in ('error', 'warning')),

    message     text not null,

    -- 通常放 Actions 那次執行的網址，點過去就看得到日誌。
    detail      text,

    -- 同一個流程下一次跑成功時填上，鈴鐺就不再算它。
    -- 不直接刪除：要看得出「上次壞過但已經好了」，跟「從來沒壞過」不一樣。
    resolved_at timestamptz
);

create index if not exists site_alerts_open on site_alerts (raised_at desc) where resolved_at is null;

alter table site_alerts enable row level security;

drop policy if exists "public read" on site_alerts;
drop policy if exists "writer all" on site_alerts;

create policy "public read" on site_alerts for select to anon using (true);
create policy "writer all" on site_alerts for all to invest_writer using (true) with check (true);

grant select on site_alerts to anon;
grant select, insert, update, delete on site_alerts to invest_writer;

insert into schema_migrations (filename) values ('012_site_alerts.sql')
on conflict (filename) do nothing;
