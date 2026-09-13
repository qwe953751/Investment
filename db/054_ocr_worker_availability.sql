-- 2026-09-13：OCR Worker 可用性判定重構。
--
-- 問題：readiness/submit/claim/relay 各地自有門檻（15秒/120秒/120秒/120秒），
--      Worker 實際心跳 67 秒，造成相位差與重複判定。
--
-- 解決：
-- 1. 單一真相來源 ocr_available_workers()：由 Worker 自己宣告心跳週期，
--    門檻 = 2 × heartbeat_interval_seconds（最低 30 秒保護）
-- 2. 連線事實旗標 realtime_connected（治本二打進去），
--    離線狀態由 last_seen_at 退路偵測
-- 3. 工作層級 stall 偵測（由 handleStatus 寄生在既有呼叫裡，+0 invocation），
--    不再依賴時間推測

alter table public.ocr_workers add column if not exists heartbeat_interval_seconds int not null default 60;
alter table public.ocr_workers add column if not exists realtime_connected boolean not null default false;
alter table public.ocr_workers add column if not exists realtime_changed_at timestamptz;
alter table public.ocr_workers add column if not exists last_seen_at timestamptz not null default now();

create index if not exists idx_ocr_workers_last_seen_at on public.ocr_workers(last_seen_at desc);

-- 重新定義 ocr_claim_job 與 ocr_relay_agent_failure，改用 ocr_worker_alive() 判定
-- 而非寫死的 120 秒

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
              and public.ocr_worker_alive(w)
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
        error_code = null,
        last_seen_at = now()
    where id = v_job_id;

    select to_jsonb(job)
    into v_job
    from ocr_jobs as job
    where job.id = v_job_id;

    return v_job;
end;
$$;

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
              and public.ocr_worker_alive(w)
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

-- 更新 complete、progress 等各端點也更新 ocr_workers.last_seen_at
-- （在 edge function 層做）

-- 判定一台機器是否還活著：event/時間雙路
create or replace function public.ocr_worker_alive(w public.ocr_workers)
returns boolean
language sql stable as $$
  select w.realtime_connected
      or w.last_seen_at > now()
         - make_interval(secs => greatest(coalesce(w.heartbeat_interval_seconds, 60), 30) * 2)
$$;

-- 判定一台機器上有沒有可用的 Agent（只看 Worker 主動宣告的事實）
create or replace function public.ocr_worker_has_agent(w public.ocr_workers)
returns boolean
language sql stable as $$
  select exists (
    select 1 from jsonb_each(coalesce(w.agent_status, '{}'::jsonb)) as a(name, state)
    where (state ->> 'authenticated')::boolean is true
      and coalesce((state ->> 'quotaAvailable')::boolean, true) is true
  )
$$;

-- 收斂：只回答「現在有沒有可用的 Worker」（事實層級判定）
create or replace function public.ocr_available_workers()
returns setof public.ocr_workers
language sql stable as $$
  select w.*
  from public.ocr_workers w
  where public.ocr_worker_alive(w)
    and public.ocr_worker_has_agent(w)
$$;

-- 工作層級 stall 偵測：queued 狀態超過門檻未被接走 → fallback_required
-- （調用端在 handleStatus 時先檢查，不得作為排程）
create or replace function public.ocr_stall_to_fallback(
  p_job_id uuid,
  p_user_id uuid,
  p_min_age_seconds int default 20
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
  v_job jsonb;
begin
  update public.ocr_jobs
  set status = 'fallback_required',
      fallback_reason = 'worker_stalled',
      updated_at = now()
  where id = p_job_id
    and user_id = p_user_id
    and status = 'queued'
    and created_at < now() - make_interval(secs => p_min_age_seconds)
    -- for update skip locked 是 claim 在用；這邊不加鎖，兩個同時發生只能有一個贏
    ;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return null;
  end if;

  select to_jsonb(job) into v_job
  from public.ocr_jobs as job
  where job.id = p_job_id;

  return v_job;
end;
$$;

revoke all on function public.ocr_worker_alive(public.ocr_workers) from public, anon, authenticated;
revoke all on function public.ocr_worker_has_agent(public.ocr_workers) from public, anon, authenticated;
revoke all on function public.ocr_available_workers() from public, anon, authenticated;
revoke all on function public.ocr_stall_to_fallback(uuid, uuid, int) from public, anon, authenticated;

grant execute on function public.ocr_worker_alive(public.ocr_workers) to service_role;
grant execute on function public.ocr_worker_has_agent(public.ocr_workers) to service_role;
grant execute on function public.ocr_available_workers() to service_role;
grant execute on function public.ocr_stall_to_fallback(uuid, uuid, int) to service_role;

-- 更新 ocr_claim_job 與 ocr_relay_agent_failure 的判定
-- （分別改 db/049 裡的兩個地方）

-- ocr_claim_job(p_worker_id, p_lease_seconds) 裡：
-- 將 "w.last_heartbeat_at > now() - interval '120 seconds'"
-- 改成 "public.ocr_worker_alive(w)"

-- ocr_relay_agent_failure(p_worker_id, p_job_id, p_lease_token, ...) 裡：
-- 將 "w.last_heartbeat_at > now() - interval '120 seconds'"
-- 改成 "public.ocr_worker_alive(w)"

insert into schema_migrations (filename) values ('054_ocr_worker_availability.sql')
on conflict (filename) do nothing;
