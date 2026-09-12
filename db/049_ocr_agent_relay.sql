-- OCR Agent 跨機接力：使用者要求固定順序「先確認 Windows 的 Codex→Claude，都不行才確認
-- Mac 的 Codex→Claude，都不行才回退瀏覽器 Tesseract」，取代原本「誰先搶到 job 就誰做」的
-- 競速制。只有兩層（Windows／非 Windows），沿用既有 platform ilike '%windows%' 判斷慣例
-- （與 ocr-jobs/index.js 的 isWindowsWorker() 一致），不要求 platform 字串精確等於 'Mac'，
-- 避免 macOS 的 RuntimeInformation.OSDescription 沒有固定包含 'Mac' 字樣時誤判。

alter table public.ocr_jobs
    add column if not exists windows_attempt_failed_at timestamptz;

-- claim 依呼叫端平台分流：
-- * Windows 只能拿「Windows 還沒試過」的工作（queued 且未標記 windows_attempt_failed_at）。
-- * 非 Windows 只能拿「Windows 已確認失敗」或「目前沒有新鮮 Windows 心跳」的工作；後者讓
--   Windows 離線時 Mac 可以直接當唯一可用機器，不必空等一台不在線的機器「輪到」。
-- 既有的「lease 逾時回收」分支（worker 中途當機）刻意不套用這個平台限制，維持任何在線
-- Worker 都能接手逾期租約的既有可靠度，不因這次改動而降低故障復原能力。
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
    v_worker_platform text;
    v_is_windows boolean;
    v_other_fresh boolean;
    v_job_id uuid;
    v_job jsonb;
begin
    if p_lease_seconds < 60 or p_lease_seconds > 600 then
        raise exception 'lease seconds out of range';
    end if;

    select platform into v_worker_platform from ocr_workers where id = p_worker_id;
    v_is_windows := coalesce(v_worker_platform, '') ilike '%windows%';
    v_other_fresh := false;

    if not v_is_windows then
        select exists (
            select 1
            from ocr_workers as w
            where w.id <> p_worker_id
              and w.platform ilike '%windows%'
              and w.last_heartbeat_at > now() - interval '120 seconds'
        )
        into v_other_fresh;
    end if;

    select id
    into v_job_id
    from ocr_jobs
    where expires_at > now()
      and attempt_count < 10
      and (
          (status = 'leased' and lease_until < now())
          or (
              status = 'queued'
              and (
                  (v_is_windows and windows_attempt_failed_at is null)
                  or (not v_is_windows and (windows_attempt_failed_at is not null or not v_other_fresh))
              )
          )
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

-- 兩個 Agent 都確認不可用時呼叫；決定「交給另一個平台的 Worker 重試」還是「已經是最後一站，
-- 直接回退 Tesseract」。只有呼叫端是 Windows、且當下有新鮮的非 Windows Worker 在線，才會
-- 接力；其餘情況（非 Windows 失敗、或 Windows 失敗但沒有其他機器可接）一律終結為
-- fallback_required，避免工作在沒有第二台機器時卡在 queued 裡永遠等不到人接手。
create or replace function ocr_relay_agent_failure(
    p_worker_id uuid,
    p_job_id uuid,
    p_lease_token uuid,
    p_fallback_reason text default null,
    p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_worker_platform text;
    v_is_windows boolean;
    v_other_fresh boolean;
    v_updated integer;
begin
    select platform into v_worker_platform from ocr_workers where id = p_worker_id;
    v_is_windows := coalesce(v_worker_platform, '') ilike '%windows%';
    v_other_fresh := false;

    if v_is_windows then
        select exists (
            select 1
            from ocr_workers as w
            where w.id <> p_worker_id
              and w.platform not ilike '%windows%'
              and w.last_heartbeat_at > now() - interval '120 seconds'
        )
        into v_other_fresh;
    end if;

    if v_is_windows and v_other_fresh then
        update ocr_jobs
        set status = 'queued',
            windows_attempt_failed_at = now(),
            lease_owner = null,
            lease_token = null,
            lease_until = null,
            error_code = left(p_error_code, 100),
            updated_at = now()
        where id = p_job_id
          and status = 'leased'
          and lease_owner = p_worker_id
          and lease_token = p_lease_token
          and lease_until > now()
          and expires_at > now();

        get diagnostics v_updated = row_count;
        if v_updated = 1 then
            return jsonb_build_object('relayed', true);
        end if;

        return jsonb_build_object('relayed', false, 'completed', false);
    end if;

    update ocr_jobs
    set status = 'fallback_required',
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
    return jsonb_build_object('relayed', false, 'completed', v_updated = 1);
end;
$$;

revoke all on function ocr_claim_job(uuid, integer) from public, anon, authenticated;
revoke all on function ocr_relay_agent_failure(uuid, uuid, uuid, text, text)
    from public, anon, authenticated;
grant execute on function ocr_claim_job(uuid, integer) to service_role;
grant execute on function ocr_relay_agent_failure(uuid, uuid, uuid, text, text)
    to service_role;

insert into schema_migrations (filename) values ('049_ocr_agent_relay.sql')
on conflict (filename) do nothing;
