-- OCR 佇列 claim／評估 claim 的 Realtime trigger 修正，以及活躍工作 wake 節流。
-- 044 的共用 trigger 會在另一張表的 UPDATE 上讀取不存在的 NEW 欄位，
-- 造成 ocr_jobs queued -> leased 時 SQLSTATE 42703，整個 claim transaction rollback。
-- 兩張表各自使用明確欄位的 trigger function，避免再跨表解讀 record。

create or replace function public.ocr_jobs_queue_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if tg_op = 'INSERT'
       or (tg_op = 'UPDATE'
           and new.status = 'queued'
           and old.status is distinct from new.status) then
        perform realtime.send(
            jsonb_build_object('job_id', new.id),
            'ocr_job_queued',
            'ocr:queue',
            true
        );
    end if;
    return new;
end;
$$;

create or replace function public.ocr_evaluations_queue_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if tg_op = 'INSERT'
       or (tg_op = 'UPDATE'
           and new.low_status = 'queued'
           and old.low_status is distinct from new.low_status) then
        perform realtime.send(
            jsonb_build_object('evaluation_id', new.id),
            'ocr_evaluation_queued',
            'ocr:queue',
            true
        );
    end if;
    return new;
end;
$$;

drop trigger if exists ocr_jobs_realtime_queue on public.ocr_jobs;
create trigger ocr_jobs_realtime_queue
    after insert or update of status on public.ocr_jobs
    for each row execute function public.ocr_jobs_queue_broadcast();

drop trigger if exists ocr_evaluations_realtime_queue on public.ocr_evaluations;
create trigger ocr_evaluations_realtime_queue
    after insert or update of low_status on public.ocr_evaluations
    for each row execute function public.ocr_evaluations_queue_broadcast();

drop function if exists public.ocr_queue_broadcast();

revoke all on function public.ocr_jobs_queue_broadcast() from public, anon, authenticated;
revoke all on function public.ocr_evaluations_queue_broadcast() from public, anon, authenticated;
grant execute on function public.ocr_jobs_queue_broadcast() to service_role;
grant execute on function public.ocr_evaluations_queue_broadcast() to service_role;

alter table public.ocr_jobs
    add column if not exists last_wake_at timestamptz;

create index if not exists ix_ocr_jobs_last_wake
    on public.ocr_jobs (last_wake_at)
    where status in ('queued', 'leased');

-- 只有仍在等待中的本人工作可以 wake；資料庫 row lock 讓平行的 status poll
-- 不會同時通過節流。Edge Function 成功送出 Broadcast 前先取得這個原子配額，
-- Broadcast 失敗時最多只會延遲下一次 5 秒重送，不會形成無限重試風暴。
create or replace function public.ocr_wake_job(
    p_user_id uuid,
    p_job_id uuid,
    p_min_interval_seconds integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_last_wake_at timestamptz;
    v_retry_after integer;
begin
    if p_min_interval_seconds < 1 or p_min_interval_seconds > 60 then
        raise exception 'wake interval out of range';
    end if;

    select last_wake_at
    into v_last_wake_at
    from public.ocr_jobs
    where id = p_job_id
      and user_id = p_user_id
      and status in ('queued', 'leased')
      and expires_at > now()
    for update;

    if not found then
        return jsonb_build_object('sent', false, 'reason', 'job_not_active');
    end if;

    if v_last_wake_at is not null
       and v_last_wake_at > now() - make_interval(secs => p_min_interval_seconds) then
        v_retry_after := greatest(
            1,
            ceil(extract(epoch from (
                v_last_wake_at + make_interval(secs => p_min_interval_seconds) - now()
            )))::integer
        );
        return jsonb_build_object(
            'sent', false,
            'reason', 'rate_limited',
            'retryAfterSeconds', v_retry_after
        );
    end if;

    update public.ocr_jobs
    set last_wake_at = now()
    where id = p_job_id;

    return jsonb_build_object('sent', true, 'jobId', p_job_id);
end;
$$;

revoke all on function public.ocr_wake_job(uuid, uuid, integer)
    from public, anon, authenticated;
grant execute on function public.ocr_wake_job(uuid, uuid, integer) to service_role;

insert into schema_migrations (filename) values ('047_ocr_realtime_claim_wake.sql')
on conflict (filename) do nothing;
