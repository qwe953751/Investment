-- 2026-09-13：ocr_stall_to_fallback 加上 Worker 可用性守衛條件。
--
-- 問題：stall 偵測只檢查「queued 超過 N 秒」，分不出「沒有 Worker」與
--      「Worker 活著但 3 個並行槽全滿、排隊合理等候」兩種情況。
--      Worker 每張 AI 辨識 47-100 秒，第 4 張開始就會等超過 20 秒 →
--      誤觸 worker_stalled → 改走 Tesseract，即使 Worker 明明活著且正在幹活。
--
-- 解決：加一個守衛：有任何可用 Worker（ocr_available_workers 回傳至少一筆）
--      就不標 fallback_required。只有「時間超過且真的沒有可用 Worker」才降級。

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
    and not exists (select 1 from public.ocr_available_workers());

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

revoke all on function public.ocr_stall_to_fallback(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.ocr_stall_to_fallback(uuid, uuid, int) to service_role;

insert into schema_migrations (filename) values ('055_ocr_stall_guard.sql')
on conflict (filename) do nothing;
