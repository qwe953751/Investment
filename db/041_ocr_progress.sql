-- D+ OCR 階段進度與安全用量彙總。
-- 仍維持 ocr_jobs private／service_role-only；Worker 只能透過 ocr-jobs progress RPC 更新自己
-- 持有且未過期的 lease，不開放瀏覽器直接寫入。

alter table public.ocr_jobs
    add column if not exists progress_stage text not null default 'queued',
    add column if not exists progress_percent integer not null default 5,
    add column if not exists progress_updated_at timestamptz not null default now(),
    add column if not exists usage_summary jsonb;

alter table public.ocr_jobs
    drop constraint if exists ocr_jobs_progress_stage,
    drop constraint if exists ocr_jobs_progress_percent;

alter table public.ocr_jobs
    add constraint ocr_jobs_progress_stage
        check (progress_stage in (
            'uploading', 'queued', 'claiming', 'downloading', 'extraction',
            'audit', 'validating', 'fallback', 'completed', 'failed')),
    add constraint ocr_jobs_progress_percent
        check (progress_percent between 0 and 100);

create or replace function public.ocr_update_progress(
    p_worker_id uuid,
    p_job_id uuid,
    p_lease_token uuid,
    p_progress_stage text,
    p_progress_percent integer,
    p_usage_summary jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_updated integer;
begin
    if p_progress_stage not in (
        'uploading', 'queued', 'claiming', 'downloading', 'extraction',
        'audit', 'validating', 'fallback', 'completed', 'failed')
        or p_progress_percent < 0 or p_progress_percent > 100 then
        raise exception 'invalid OCR progress';
    end if;

    update public.ocr_jobs
    set progress_stage = p_progress_stage,
        progress_percent = p_progress_percent,
        progress_updated_at = now(),
        usage_summary = case
            when p_usage_summary is null then usage_summary
            else p_usage_summary
        end,
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

revoke all on function public.ocr_update_progress(uuid, uuid, uuid, text, integer, jsonb)
    from public, anon, authenticated;
grant execute on function public.ocr_update_progress(uuid, uuid, uuid, text, integer, jsonb)
    to service_role;

insert into schema_migrations (filename) values ('041_ocr_progress.sql')
on conflict (filename) do nothing;
