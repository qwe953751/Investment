-- Supabase database advisor 建議的 RLS 寫法：先初始化 auth.jwt()，再取 metadata 欄位。
-- 這避免 private Realtime channel 的 policy 對每一列重複評估 JWT。

drop policy if exists "ocr worker receives queue broadcasts" on realtime.messages;
create policy "ocr worker receives queue broadcasts"
    on realtime.messages
    for select
    to authenticated
    using (
        (select realtime.topic()) = 'ocr:queue'
        and realtime.messages.extension = 'broadcast'
        and ((select auth.jwt()) -> 'app_metadata' ->> 'access_role') = 'ocr_worker'
    );

insert into schema_migrations (filename) values ('046_ocr_realtime_policy_initplan.sql')
on conflict (filename) do nothing;
