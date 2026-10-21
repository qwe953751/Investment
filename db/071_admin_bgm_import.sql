-- 管理員可送出單一 BGM 匯入工作；既有音檔直到新檔驗證完成才切換。
alter table public.admin_bgm
    add column if not exists import_id uuid,
    add column if not exists import_url text,
    add column if not exists import_status text,
    add column if not exists import_error text,
    add column if not exists import_requested_at timestamptz,
    add column if not exists import_started_at timestamptz,
    add column if not exists import_finished_at timestamptz;

alter table public.admin_bgm
    drop constraint if exists admin_bgm_import_state;
alter table public.admin_bgm
    add constraint admin_bgm_import_state check (
        (import_id is null and import_url is null and import_status is null)
        or (import_id is not null and import_url ~ '^https://' and length(import_url) <= 2048
            and import_status in ('pending', 'processing', 'done', 'failed'))
    );

-- Actions 已有的 Storage secret 僅能讀取此列、回寫轉檔結果；一般管理員仍受原 RLS 限制。
grant select on public.admin_bgm to service_role;
grant update (
    title, audio_path, audio_name, audio_mime_type, audio_size_bytes, source_url,
    updated_at, import_status, import_error, import_started_at, import_finished_at
) on public.admin_bgm to service_role;

insert into public.schema_migrations (filename) values ('071_admin_bgm_import.sql')
on conflict (filename) do nothing;
