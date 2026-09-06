-- D+ OCR 硬化：同一張圖片的重送必須冪等，且到期清理要有可觀測欄位。
-- 真正的 Storage object 刪除仍由 Edge Function 以 service role 執行；
-- SQL 不直接把 service role 暴露給瀏覽器或 Worker。

alter table public.ocr_jobs
    add column if not exists idempotency_key text,
    add column if not exists input_hash text,
    add column if not exists cleanup_attempts integer not null default 0,
    add column if not exists cleanup_last_error text;

alter table public.ocr_jobs
    drop constraint if exists ocr_jobs_idempotency_key_length;

alter table public.ocr_jobs
    add constraint ocr_jobs_idempotency_key_length
    check (idempotency_key is null or char_length(idempotency_key) between 16 and 128);

alter table public.ocr_jobs
    drop constraint if exists ocr_jobs_input_hash_format;

alter table public.ocr_jobs
    add constraint ocr_jobs_input_hash_format
    check (input_hash is null or input_hash ~ '^[0-9a-f]{64}$');

create unique index if not exists ux_ocr_jobs_user_idempotency
    on public.ocr_jobs (user_id, idempotency_key)
    where idempotency_key is not null;

create index if not exists ix_ocr_jobs_expired_cleanup
    on public.ocr_jobs (expires_at, cleanup_attempts)
    where storage_path is not null;

insert into schema_migrations (filename) values ('040_ocr_hardening.sql')
on conflict (filename) do nothing;
