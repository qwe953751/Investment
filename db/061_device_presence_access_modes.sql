-- 筆記 #73：裝置列表記錄目前四種網站模式。
-- 舊 viewer 列保留為該次最後成功登記的模式；裝置下次心跳時會更新成實際模式，
-- 不依舊資料猜測它原先是否為監控者或持倉者。

alter table public.device_sessions
    drop constraint if exists device_sessions_access_level_check;

alter table public.device_sessions
    add constraint device_sessions_access_level_check
    check (access_level in ('admin', 'monitor', 'holdings', 'viewer'));

insert into public.schema_migrations (filename)
values ('061_device_presence_access_modes.sql')
on conflict (filename) do nothing;
