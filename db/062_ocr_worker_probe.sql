-- 2026-10-11：OCR Worker 在線確認重構——「指名詢問」取代心跳／連線旗標的猜測。
--
-- 問題：Windows／Mac 是否在線，原本靠 last_seen_at（最多 300 秒前的紀錄）與
--      realtime_connected（最後一次心跳時的狀態，關機後不會被清掉）推測。機器關機、停電、
--      睡眠、斷網後仍被當成在線，截圖照樣上傳，要等前端 9 分鐘時限才回退 Tesseract；
--      Windows 關機時 Mac 也拿不到工作（claim 的平台分流以「Windows 還活著」為前提）。
--
-- 解法：readiness 與批次進行中改為指名詢問（Edge 送 ocr_ping，Worker 回 pong 或任何接觸），
--      有回應就是在線（事實），5 次都沒回應就是不在線（事實）。本檔提供：
--      1. ocr_workers 的詢問欄位（last_pong_at／offline_since／last_probe_at／probe_protocol）
--      2. ocr_user_routing：記錄每位使用者「這批交給哪台機器」，不設有效期
--      3. ocr_touch_worker／ocr_begin_probe／ocr_mark_worker_offline／ocr_reroute_jobs 四個函式
--      4. 改寫 ocr_claim_job（移除「猜 Windows 在不在線」）與 ocr_relay_agent_failure
--         （由 Edge 詢問 Mac 後傳入結果）
--      5. 移除 ocr_stall_to_fallback（由批次中的詢問取代）
--      ocr_worker_alive／ocr_available_workers 保留給畫面顯示，不再用於任何閘門。
--
-- 部署順序：先套用本 migration，再部署 ocr-jobs Edge Function（新 Edge 會呼叫本檔的函式）。

alter table public.ocr_workers add column if not exists last_pong_at timestamptz;
alter table public.ocr_workers add column if not exists offline_since timestamptz;
alter table public.ocr_workers add column if not exists last_probe_at timestamptz;
-- 0＝舊版 Worker（三條處理線都忙時答不出詢問）；1＝新版（接收訊號的那一段獨立回應 pong，忙碌時也答得出來）。
alter table public.ocr_workers add column if not exists probe_protocol smallint not null default 0;

-- 每位使用者目前這批的路由決定。不設有效期：整批可能 10～40 分鐘以上，只會被下一次 readiness
-- 或批次中的改派覆寫。target_platform：windows＝照一般流程交給 Windows；other＝交給非 Windows
-- （Mac），送出時就標記 windows_attempt_failed_at；null＝沒有可用機器，submit 一律回 409。
create table if not exists public.ocr_user_routing (
    user_id uuid primary key references auth.users(id) on delete cascade,
    target_worker_id uuid references public.ocr_workers(id) on delete set null,
    target_platform text check (target_platform in ('windows', 'other')),
    decided_at timestamptz not null default now()
);

alter table public.ocr_user_routing enable row level security;
revoke all on table public.ocr_user_routing from public, anon, authenticated;
grant all on table public.ocr_user_routing to service_role;

-- 記錄「這台機器剛剛有接觸」（pong、heartbeat、progress、complete 都走這裡）：last_seen_at 用 DB 時間，
-- 與 ocr_begin_probe 回傳的詢問起點是同一個時鐘（Edge 與 DB 的時鐘差不會讓
-- last_seen_at >= 詢問起點 的比較出錯），並清掉離線標記。
-- p_pong：回答「你在嗎」時為 true，記錄 last_pong_at；p_agent_status／p_probe_protocol 為 null 時不更新。
create or replace function public.ocr_touch_worker(
    p_worker_id uuid,
    p_agent_status jsonb default null,
    p_pong boolean default false,
    p_probe_protocol smallint default null
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
    update public.ocr_workers
    set last_seen_at = now(),
        offline_since = null,
        last_pong_at = case when p_pong then now() else last_pong_at end,
        agent_status = coalesce(p_agent_status, agent_status),
        probe_protocol = coalesce(p_probe_protocol, probe_protocol)
    where id = p_worker_id
$$;

-- 原子地登記一次詢問並回傳詢問起點（DB 時間）。p_min_interval_seconds > 0 時做節流：
-- 距離上次詢問不足這個秒數就回 null（呼叫端視為「已有人在問」，不重複詢問）。
-- readiness 傳 0（每批都要真的問）；批次中的詢問傳 30。單一 UPDATE 的 WHERE 在列鎖下重新求值，
-- 兩個並行呼叫只會有一個拿到起點。
create or replace function public.ocr_begin_probe(
    p_worker_id uuid,
    p_min_interval_seconds integer default 0
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_now timestamptz := now();
    v_updated integer;
begin
    update public.ocr_workers
    set last_probe_at = v_now
    where id = p_worker_id
      and (p_min_interval_seconds <= 0
           or last_probe_at is null
           or last_probe_at < v_now - make_interval(secs => p_min_interval_seconds));

    get diagnostics v_updated = row_count;
    return case when v_updated = 1 then v_now else null end;
end;
$$;

-- 詢問 5 次都沒有回應時標記離線。p_since 是這輪詢問的起點：如果標記前機器剛好有了任何接觸
-- （last_seen_at >= p_since），就不標記，避免把剛醒來的機器誤標成離線。
create or replace function public.ocr_mark_worker_offline(
    p_worker_id uuid,
    p_since timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    update public.ocr_workers
    set offline_since = coalesce(offline_since, now())
    where id = p_worker_id
      and (p_since is null or last_seen_at < p_since);
end;
$$;

-- 把原本路由到 p_from_worker_id 那個平台、尚未結束的工作改派出去。
--   p_to_worker_id 不是 null：交給非 Windows 平台（Mac）——工作回到 queued 並標記 windows_attempt_failed_at。
--   p_to_worker_id 是 null：沒有機器可接——工作改為 fallback_required（手機仍保有原圖，改跑 Tesseract）。
--   p_include_leased：連同「正由這台機器處理（leased）」的工作一起處理；機器確定離線時才傳 true。
-- 同時把路由指向這台機器的使用者改指向新目標。鎖定方式與 ocr_claim_job 相同（for update skip locked），
-- 同一件工作不可能同時被 claim 又被改派；被別人鎖住的列這一輪略過，下一次輪詢再處理。
-- 回傳實際改派的筆數。
create or replace function public.ocr_reroute_jobs(
    p_from_worker_id uuid,
    p_from_is_windows boolean,
    p_to_worker_id uuid default null,
    p_include_leased boolean default false,
    p_fallback_reason text default 'worker_offline'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_to_other boolean := p_to_worker_id is not null;
    v_reason text := left(coalesce(nullif(trim(p_fallback_reason), ''), 'worker_offline'), 100);
    v_moved integer := 0;
    v_job_id uuid;
begin
    with target as (
        select id
        from public.ocr_jobs
        where expires_at > now()
          and (
              (status = 'queued'
               and ((p_from_is_windows and windows_attempt_failed_at is null)
                    or (not p_from_is_windows and windows_attempt_failed_at is not null)))
              or (p_include_leased
                  and status = 'leased'
                  and lease_owner = p_from_worker_id)
          )
        order by created_at
        for update skip locked
    ), moved as (
        update public.ocr_jobs as job
        set status = case when v_to_other then 'queued' else 'fallback_required' end,
            windows_attempt_failed_at = case
                when v_to_other then coalesce(job.windows_attempt_failed_at, now())
                else job.windows_attempt_failed_at end,
            fallback_reason = case when v_to_other then job.fallback_reason else v_reason end,
            error_code = case when v_to_other then job.error_code else v_reason end,
            completed_at = case when v_to_other then job.completed_at else now() end,
            lease_owner = null,
            lease_token = null,
            lease_until = null,
            updated_at = now()
        from target
        where job.id = target.id
        returning job.id
    )
    select count(*), min(id::text)::uuid into v_moved, v_job_id from moved;

    update public.ocr_user_routing
    set target_worker_id = p_to_worker_id,
        target_platform = case when v_to_other then 'other' else null end,
        decided_at = now()
    where target_worker_id = p_from_worker_id;

    -- queued→queued 的列不會觸發 ocr_jobs_queue_broadcast（trigger 只在狀態「變成」queued 時廣播），
    -- 所以改派給 Mac 後要自己喚醒一次；leased→queued 的列 trigger 已經廣播過，多一則無妨。
    if v_to_other and v_moved > 0 then
        begin
            perform realtime.send(
                jsonb_build_object('job_id', v_job_id, 'source', 'reroute'),
                'ocr_job_queued',
                'ocr:queue',
                true);
        exception when others then
            null;
        end;
    end if;

    return v_moved;
end;
$$;

-- claim 依呼叫端平台分流（沿用 db/049、db/054），差別只有兩處：
-- 1. 呼叫 claim 本身就是「這台機器還活著」的事實：更新 last_seen_at 並清掉 offline_since。
-- 2. 移除「猜 Windows 在不在線」的判斷：非 Windows 只能拿 windows_attempt_failed_at 已標記的工作；
--    標記由 readiness（交給 Mac 時送出就標記）、relay、批次中改派負責，不再由 claim 自己猜。
-- lease 逾時回收分支不套用平台限制，維持既有的故障復原能力。
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
    v_job_id uuid;
    v_job jsonb;
begin
    if p_lease_seconds < 60 or p_lease_seconds > 600 then
        raise exception 'lease seconds out of range';
    end if;

    update ocr_workers
    set last_seen_at = now(),
        offline_since = null
    where id = p_worker_id;

    select platform into v_worker_platform from ocr_workers where id = p_worker_id;
    v_is_windows := coalesce(v_worker_platform, '') ilike '%windows%';

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
                  or (not v_is_windows and windows_attempt_failed_at is not null)
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

-- 兩個 Agent 都確認不可用時呼叫。Windows 呼叫時是否交給 Mac，由 Edge 先詢問 Mac 後以
-- p_other_available 傳入（true＝Mac 有回應且有可用 Agent），SQL 內不再猜。
-- p_other_available 是 null（舊版 Edge 沒傳）時採保守行為：不交給 Mac，直接 fallback_required。
-- 先 drop 舊的 5 參數版本，否則會留下兩個 overload。
drop function if exists ocr_relay_agent_failure(uuid, uuid, uuid, text, text);

create or replace function ocr_relay_agent_failure(
    p_worker_id uuid,
    p_job_id uuid,
    p_lease_token uuid,
    p_fallback_reason text default null,
    p_error_code text default null,
    p_other_available boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_worker_platform text;
    v_is_windows boolean;
    v_updated integer;
begin
    update ocr_workers
    set last_seen_at = now(),
        offline_since = null
    where id = p_worker_id;

    select platform into v_worker_platform from ocr_workers where id = p_worker_id;
    v_is_windows := coalesce(v_worker_platform, '') ilike '%windows%';

    if v_is_windows and coalesce(p_other_available, false) then
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

-- stall 偵測改由批次中的指名詢問取代（ocr-jobs handleStatus），不再需要。
drop function if exists public.ocr_stall_to_fallback(uuid, uuid, integer);

revoke all on function public.ocr_touch_worker(uuid, jsonb, boolean, smallint) from public, anon, authenticated;
revoke all on function public.ocr_begin_probe(uuid, integer) from public, anon, authenticated;
revoke all on function public.ocr_mark_worker_offline(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.ocr_reroute_jobs(uuid, boolean, uuid, boolean, text) from public, anon, authenticated;
revoke all on function ocr_claim_job(uuid, integer) from public, anon, authenticated;
revoke all on function ocr_relay_agent_failure(uuid, uuid, uuid, text, text, boolean) from public, anon, authenticated;

grant execute on function public.ocr_touch_worker(uuid, jsonb, boolean, smallint) to service_role;
grant execute on function public.ocr_begin_probe(uuid, integer) to service_role;
grant execute on function public.ocr_mark_worker_offline(uuid, timestamptz) to service_role;
grant execute on function public.ocr_reroute_jobs(uuid, boolean, uuid, boolean, text) to service_role;
grant execute on function ocr_claim_job(uuid, integer) to service_role;
grant execute on function ocr_relay_agent_failure(uuid, uuid, uuid, text, text, boolean) to service_role;

insert into schema_migrations (filename) values ('062_ocr_worker_probe.sql')
on conflict (filename) do nothing;
