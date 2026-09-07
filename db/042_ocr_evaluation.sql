-- D+ OCR 評估資料：正式結果維持 Max；抽樣工作在背景補跑 Low，並保存人工確認答案。
-- 表與 RPC 僅供 Edge Function／service_role 使用，瀏覽器不能直接讀寫持倉截圖或評估內容。

create table if not exists public.ocr_evaluations (
    id uuid primary key default gen_random_uuid(),
    source_job_id uuid not null unique references public.ocr_jobs(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    account_id uuid not null references public.asset_accounts(id) on delete cascade,
    market text not null check (market in ('台股', '美股', '其他')),
    input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
    max_result jsonb not null,
    max_metadata jsonb not null default '{}'::jsonb,
    low_status text not null default 'queued'
        check (low_status in ('queued', 'leased', 'succeeded', 'failed', 'expired')),
    low_result jsonb,
    low_metadata jsonb not null default '{}'::jsonb,
    low_error_code text,
    low_attempt_count integer not null default 0 check (low_attempt_count between 0 and 3),
    low_lease_owner uuid references auth.users(id) on delete set null,
    low_lease_token uuid,
    low_lease_until timestamptz,
    human_truth jsonb,
    human_truth_complete boolean not null default false,
    human_confirmed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists ix_ocr_evaluations_low_claim
    on public.ocr_evaluations (low_status, created_at)
    where low_status in ('queued', 'leased');

create index if not exists ix_ocr_evaluations_user
    on public.ocr_evaluations (user_id, created_at desc);

alter table public.ocr_evaluations enable row level security;
revoke all on table public.ocr_evaluations from public, anon, authenticated;
grant all on table public.ocr_evaluations to service_role;

create or replace function public.ocr_claim_evaluation(
    p_worker_id uuid,
    p_lease_seconds integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_evaluation_id uuid;
    v_evaluation jsonb;
begin
    if p_lease_seconds < 60 or p_lease_seconds > 600 then
        raise exception 'lease seconds out of range';
    end if;

    select evaluation.id
    into v_evaluation_id
    from public.ocr_evaluations as evaluation
    join public.ocr_jobs as job on job.id = evaluation.source_job_id
    where evaluation.low_attempt_count < 3
      and job.status = 'succeeded'
      and job.storage_path is not null
      and job.expires_at > now()
      and (
          evaluation.low_status = 'queued'
          or (evaluation.low_status = 'leased' and evaluation.low_lease_until < now())
      )
    order by evaluation.created_at
    for update of evaluation skip locked
    limit 1;

    if v_evaluation_id is null then
        return null;
    end if;

    update public.ocr_evaluations
    set low_status = 'leased',
        low_lease_owner = p_worker_id,
        low_lease_token = gen_random_uuid(),
        low_lease_until = now() + make_interval(secs => p_lease_seconds),
        low_attempt_count = low_attempt_count + 1,
        updated_at = now()
    where id = v_evaluation_id;

    select jsonb_build_object(
        'id', evaluation.id,
        'sourceJobId', evaluation.source_job_id,
        'market', evaluation.market,
        'contentType', job.content_type,
        'originalFileName', job.original_file_name,
        'storagePath', job.storage_path,
        'leaseToken', evaluation.low_lease_token
    )
    into v_evaluation
    from public.ocr_evaluations as evaluation
    join public.ocr_jobs as job on job.id = evaluation.source_job_id
    where evaluation.id = v_evaluation_id;

    return v_evaluation;
end;
$$;

create or replace function public.ocr_complete_evaluation(
    p_worker_id uuid,
    p_evaluation_id uuid,
    p_lease_token uuid,
    p_status text,
    p_result jsonb default null,
    p_metadata jsonb default '{}'::jsonb,
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
    if p_status not in ('succeeded', 'failed') then
        raise exception 'invalid evaluation status';
    end if;

    if p_status = 'succeeded' and p_result is null then
        raise exception 'successful evaluation requires result';
    end if;

    update public.ocr_evaluations
    set low_status = p_status,
        low_result = case when p_status = 'succeeded' then p_result else null end,
        low_metadata = coalesce(p_metadata, '{}'::jsonb),
        low_error_code = left(p_error_code, 100),
        low_lease_owner = null,
        low_lease_token = null,
        low_lease_until = null,
        updated_at = now()
    where id = p_evaluation_id
      and low_status = 'leased'
      and low_lease_owner = p_worker_id
      and low_lease_token = p_lease_token
      and low_lease_until > now();

    get diagnostics v_updated = row_count;
    return v_updated = 1;
end;
$$;

revoke all on function public.ocr_claim_evaluation(uuid, integer)
    from public, anon, authenticated;
revoke all on function public.ocr_complete_evaluation(uuid, uuid, uuid, text, jsonb, jsonb, text)
    from public, anon, authenticated;
grant execute on function public.ocr_claim_evaluation(uuid, integer) to service_role;
grant execute on function public.ocr_complete_evaluation(uuid, uuid, uuid, text, jsonb, jsonb, text)
    to service_role;

insert into schema_migrations (filename) values ('042_ocr_evaluation.sql')
on conflict (filename) do nothing;
