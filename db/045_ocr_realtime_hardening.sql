-- OCR Realtime trigger 只由 service_role 寫入的 ocr_jobs／ocr_evaluations 觸發。
-- 不把 trigger function 暴露成 anon／authenticated 的 RPC，並讓 private channel
-- policy 的 JWT 判斷只初始化一次；分享連結建立者索引則支援撤銷／稽核查詢。

revoke all on function public.ocr_queue_broadcast() from public, anon, authenticated;
grant execute on function public.ocr_queue_broadcast() to service_role;

drop policy if exists "ocr worker receives queue broadcasts" on realtime.messages;
create policy "ocr worker receives queue broadcasts"
    on realtime.messages
    for select
    to authenticated
    using (
        (select realtime.topic()) = 'ocr:queue'
        and realtime.messages.extension = 'broadcast'
        and (select (auth.jwt() -> 'app_metadata' ->> 'access_role')) = 'ocr_worker'
    );

create index if not exists ix_access_share_links_created_by
    on public.access_share_links (created_by);

insert into schema_migrations (filename) values ('045_ocr_realtime_hardening.sql')
on conflict (filename) do nothing;
