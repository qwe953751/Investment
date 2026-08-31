-- 筆記 #43：網站裝置使用狀況。
--
-- 靜態網站無法可靠取得訪客 IP，也不能把 service_role 放進瀏覽器，
-- 所以由 Supabase Edge Function 以伺服器端轉送標頭寫入這張表。
-- anon／authenticated 完全沒有表格權限；列表只能透過 function，且 function
-- 只接受最高權限入口的請求。真正抵抗偽造仍要等 Supabase Auth／白名單完成。
--
-- last_seen_at 是即時活動來源，status 由心跳與每天台北 07:00 的 pg_cron 維護。
-- 這張表不做自動刪除，保留完整紀錄供最高權限追查；若日後要加保留期限，
-- 需另行確認期限與清理方式。

create table if not exists public.device_sessions (
    device_id      text primary key check (length(device_id) between 16 and 128),
    device_name    text not null default '未知裝置' check (length(device_name) between 1 and 120),
    ip_address     text not null default '' check (length(ip_address) <= 80),
    access_level   text not null check (access_level in ('admin', 'viewer')),
    user_agent     text not null default '' check (length(user_agent) <= 500),
    status         text not null default 'online' check (status in ('online', 'offline')),
    first_seen_at  timestamptz not null default now(),
    last_seen_at   timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

create index if not exists device_sessions_last_seen
    on public.device_sessions (last_seen_at desc);

alter table public.device_sessions enable row level security;

drop policy if exists "backup read" on public.device_sessions;
create policy "backup read" on public.device_sessions
    for select to invest_writer using (true);

-- 這張表不對瀏覽器公開；Edge Function 以 service_role 在伺服器端存取。
revoke all on public.device_sessions from anon, authenticated;
grant select on public.device_sessions to invest_writer;
grant select, insert, update, delete on public.device_sessions to service_role;

-- Supabase 資料庫預設以 UTC 執行 cron；23:00 UTC 就是台北隔天 07:00。
-- 重新套用 migration 時先移除同名 job，避免建立重複排程。
do $migration$
declare
    existing_job_id bigint;
begin
    select jobid
      into existing_job_id
      from cron.job
     where jobname = 'device-presence-maintenance';

    if existing_job_id is not null then
        perform cron.unschedule(existing_job_id);
    end if;

    perform cron.schedule(
        'device-presence-maintenance',
        '0 23 * * *',
        $cron$
            update public.device_sessions
               set status = case
                                when last_seen_at >= now() - interval '10 minutes' then 'online'
                                else 'offline'
                            end,
                   updated_at = now()
             where status is distinct from case
                                when last_seen_at >= now() - interval '10 minutes' then 'online'
                                else 'offline'
                            end;
        $cron$
    );
end
$migration$;

insert into schema_migrations (filename) values ('031_device_sessions.sql')
on conflict (filename) do nothing;
