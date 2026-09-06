-- D+ OCR 正式資料邊界：圖片只進私有 bucket，工作只由 Edge Function 的
-- service role 讀寫。瀏覽器與 Worker 都不能直接存取這兩張表或 Storage。

update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('access_role', 'admin')
where lower(email) = 'admin@investment.local';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'ocr-private',
    'ocr-private',
    false,
    10485760,
    array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists ocr_workers (
    id uuid primary key references auth.users(id) on delete cascade,
    name text not null check (char_length(name) between 1 and 100),
    platform text not null default 'unknown' check (char_length(platform) <= 100),
    version text not null default 'unknown' check (char_length(version) <= 100),
    agent_status jsonb not null default '{}'::jsonb,
    last_heartbeat_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists ocr_jobs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    account_id uuid not null references asset_accounts(id) on delete cascade,
    market text not null check (market in ('台股', '美股', '其他')),
    storage_path text unique,
    original_file_name text not null check (char_length(original_file_name) between 1 and 255),
    content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
    size_bytes bigint not null check (size_bytes between 1 and 10485760),
    status text not null default 'queued'
        check (status in (
            'queued', 'leased', 'succeeded', 'fallback_required',
            'failed', 'cancelled', 'expired')),
    result jsonb,
    fallback_reason text,
    error_code text,
    lease_owner uuid references auth.users(id) on delete set null,
    lease_token uuid,
    lease_until timestamptz,
    attempt_count integer not null default 0 check (attempt_count between 0 and 10),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    expires_at timestamptz not null default (now() + interval '60 minutes')
);

create index if not exists ix_ocr_jobs_claim
    on ocr_jobs (status, created_at)
    where status in ('queued', 'leased');

create index if not exists ix_ocr_jobs_owner
    on ocr_jobs (user_id, created_at desc);

create index if not exists ix_ocr_jobs_expiry
    on ocr_jobs (expires_at)
    where storage_path is not null;

alter table ocr_workers enable row level security;
alter table ocr_jobs enable row level security;

revoke all on table ocr_workers from public, anon, authenticated;
revoke all on table ocr_jobs from public, anon, authenticated;
grant all on table ocr_workers to service_role;
grant all on table ocr_jobs to service_role;

-- 單一 SQL transaction 內以 SKIP LOCKED 取件並寫入租約，未來增加第二台
-- Worker 時也不會讓兩台同時處理同一張圖。
create or replace function ocr_claim_job(
    p_worker_id uuid,
    p_lease_seconds integer default 240
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_job_id uuid;
    v_job jsonb;
begin
    if p_lease_seconds < 60 or p_lease_seconds > 600 then
        raise exception 'lease seconds out of range';
    end if;

    select id
    into v_job_id
    from ocr_jobs
    where expires_at > now()
      and attempt_count < 10
      and (
          status = 'queued'
          or (status = 'leased' and lease_until < now())
      )
    order by created_at
    for update skip locked
    limit 1;

    if v_job_id is null then
        return null;
    end if;

    update ocr_jobs
    set status = 'leased',
        lease_owner = p_worker_id,
        lease_token = gen_random_uuid(),
        lease_until = now() + make_interval(secs => p_lease_seconds),
        attempt_count = attempt_count + 1,
        updated_at = now(),
        error_code = null
    where id = v_job_id;

    select to_jsonb(job)
    into v_job
    from ocr_jobs as job
    where job.id = v_job_id;

    return v_job;
end;
$$;

create or replace function ocr_complete_job(
    p_worker_id uuid,
    p_job_id uuid,
    p_lease_token uuid,
    p_status text,
    p_result jsonb default null,
    p_fallback_reason text default null,
    p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_updated integer;
begin
    if p_status not in ('succeeded', 'fallback_required', 'failed') then
        raise exception 'invalid terminal status';
    end if;

    update ocr_jobs
    set status = p_status,
        result = p_result,
        fallback_reason = left(p_fallback_reason, 100),
        error_code = left(p_error_code, 100),
        lease_owner = null,
        lease_token = null,
        lease_until = null,
        completed_at = now(),
        updated_at = now()
    where id = p_job_id
      and status = 'leased'
      and lease_owner = p_worker_id
      and lease_token = p_lease_token
      and lease_until > now()
      and expires_at > now();

    get diagnostics v_updated = row_count;
    return v_updated = 1;
end;
$$;

revoke all on function ocr_claim_job(uuid, integer) from public, anon, authenticated;
revoke all on function ocr_complete_job(uuid, uuid, uuid, text, jsonb, text, text)
    from public, anon, authenticated;
grant execute on function ocr_claim_job(uuid, integer) to service_role;
grant execute on function ocr_complete_job(uuid, uuid, uuid, text, jsonb, text, text)
    to service_role;

insert into schema_migrations (filename) values ('039_ocr_jobs.sql')
on conflict (filename) do nothing;
