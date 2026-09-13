-- 2026-09-13：OCR Worker 可用性判定重構。
--
-- 問題：readiness/submit/claim/relay 各地自有門檻（15秒/120秒/120秒/120秒），
--      Worker 實際心跳 67 秒，造成相位差與重複判定；readiness 的 15 秒門檻更是
--      Number(null)=0 被 clamp 出來的 bug，只有落在心跳後 15/67≈22% 的相位才判定在線，
--      導致上傳截圖時 78% 機率整批誤判 worker_offline、全部改走 Tesseract。
--
-- 解決：
-- 1. 單一真相來源 ocr_available_workers()：由 Worker 自己宣告心跳週期，
--    門檻 = 2 × heartbeat_interval_seconds（最低 30 秒保護），不再有第二份寫死的秒數
-- 2. 連線事實旗標 realtime_connected（治本二 Worker 重 build 後才會真的回報 true；
--    治本一先建欄位、缺省 false，不影響現有行為），離線判定改用 last_seen_at 退路
-- 3. 工作層級 stall 偵測 ocr_stall_to_fallback()：由 edge function 的 handleStatus
--    寄生在既有輪詢呼叫裡（+0 invocation），取代機器層級的心跳猜測——
--    「這件工作 N 秒內沒被接走」是事實，不是推測

alter table public.ocr_workers add column if not exists heartbeat_interval_seconds int not null default 60;
alter table public.ocr_workers add column if not exists realtime_connected boolean not null default false;
alter table public.ocr_workers add column if not exists realtime_changed_at timestamptz;
alter table public.ocr_workers add column if not exists last_seen_at timestamptz not null default now();

create index if not exists idx_ocr_workers_last_seen_at on public.ocr_workers(last_seen_at desc);

-- === 先定義被依賴的函式，後定義呼叫它們的函式 ===

-- 判定一台機器是否還活著：連線事實優先，時間退路其次。
-- 門檻用該機器自己宣告的心跳週期換算，改心跳週期不需要同步修改任何其他地方——
-- 這是本次重構要根治的「五處判定各自維護一份門檻常數」問題。
create or replace function public.ocr_worker_alive(w public.ocr_workers)
returns boolean
language sql stable as $$
  select w.realtime_connected
      or w.last_seen_at > now()
         - make_interval(secs => greatest(coalesce(w.heartbeat_interval_seconds, 60), 30) * 2)
$$;

-- 判定一台機器上有沒有可用的 Agent（只看 Worker 主動宣告的事實，不推測）
create or replace function public.ocr_worker_has_agent(w public.ocr_workers)
returns boolean
language sql stable as $$
  select exists (
    select 1 from jsonb_each(coalesce(w.agent_status, '{}'::jsonb)) as a(name, state)
    where (state ->> 'authenticated')::boolean is true
      and coalesce((state ->> 'quotaAvailable')::boolean, true) is true
  )
$$;

-- 收斂：只回答「現在有沒有可用的 Worker」（事實層級判定，供 SQL 端其他函式共用）
create or replace function public.ocr_available_workers()
returns setof public.ocr_workers
language sql stable as $$
  select w.*
  from public.ocr_workers w
  where public.ocr_worker_alive(w)
    and public.ocr_worker_has_agent(w)
$$;

-- 工作層級 stall 偵測：queued 狀態超過門檻仍未被接走 → fallback_required。
-- 呼叫端（edge function 的 handleStatus）必須寄生在既有輪詢呼叫裡，不得另開排程。
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
    -- 不加鎖（for update skip locked 是 claim 在用）：與 claim 同時發生只能有一個贏，
    -- 兩者都只用 where status = 'queued' 當守衛條件，天生互斥。
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

-- === 重新定義 ocr_claim_job 與 ocr_relay_agent_failure（原定義於 db/049），===
-- === 改用 ocr_worker_alive() 取代寫死的 120 秒；其餘分流語意完全不變 ===

-- claim 依呼叫端平台分流（語意沿用 db/049，不變）：
-- * Windows 只能拿「Windows 還沒試過」的工作（queued 且未標記 windows_attempt_failed_at）。
-- * 非 Windows 只能拿「Windows 已確認失敗」或「目前沒有活著的 Windows」的工作。
-- * 既有的「lease 逾時回收」分支（worker 中途當機）不套用平台限制，維持既有可靠度。
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

    -- 呼叫 claim 本身（包含落空、回傳 null 的情況）就是「這台機器還活著」的事實。
    -- claim 是 Worker 常駐槽最頻繁的呼叫，用它更新 last_seen_at 比等下一次心跳更即時，
    -- 讓事實層級的證據盡量新鮮。
    update ocr_workers set last_seen_at = now() where id = p_worker_id;

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
        error_code = null
    where id = v_job_id;

    select to_jsonb(job)
    into v_job
    from ocr_jobs as job
    where job.id = v_job_id;

    return v_job;
end;
$$;

-- 兩個 Agent 都確認不可用時呼叫；決定「交給另一個平台的 Worker 重試」還是「已經是
-- 最後一站，直接回退 Tesseract」（語意沿用 db/049，不變）。
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
    -- 呼叫這個 RPC 本身就是「這個 worker id 還活著」的事實，不管後面走哪個分支、
    -- 結果如何都先更新一次，避免每個 return 分支各自維護、漏掉其中之一。
    update ocr_workers set last_seen_at = now() where id = p_worker_id;

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

-- complete／progress 兩個端點的 last_seen_at 更新在 edge function 層做
-- （ocr_update_progress／ocr_complete_job 這兩個既有 RPC 定義在 db/041、db/039，
--  不在本檔重新定義；改由 supabase/functions/ocr-jobs/index.js 的
--  touchWorkerLastSeen() 各自呼叫後額外打一次 PATCH /rest/v1/ocr_workers）

revoke all on function public.ocr_worker_alive(public.ocr_workers) from public, anon, authenticated;
revoke all on function public.ocr_worker_has_agent(public.ocr_workers) from public, anon, authenticated;
revoke all on function public.ocr_available_workers() from public, anon, authenticated;
revoke all on function public.ocr_stall_to_fallback(uuid, uuid, int) from public, anon, authenticated;
revoke all on function ocr_claim_job(uuid, integer) from public, anon, authenticated;
revoke all on function ocr_relay_agent_failure(uuid, uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.ocr_worker_alive(public.ocr_workers) to service_role;
grant execute on function public.ocr_worker_has_agent(public.ocr_workers) to service_role;
grant execute on function public.ocr_available_workers() to service_role;
grant execute on function public.ocr_stall_to_fallback(uuid, uuid, int) to service_role;
grant execute on function ocr_claim_job(uuid, integer) to service_role;
grant execute on function ocr_relay_agent_failure(uuid, uuid, uuid, text, text) to service_role;

insert into schema_migrations (filename) values ('054_ocr_worker_availability.sql')
on conflict (filename) do nothing;
