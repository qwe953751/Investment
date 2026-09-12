-- 2026-09-13：OcrWorkerRunner 送出的 "ai_recognition" 進度階段，從這個階段名稱存在
-- 以來就不在 041 訂的合法清單裡（CHECK constraint 與 ocr_update_progress() 內部驗證
-- 都沒有），每次都被 Edge Function／RPC 回 409/400 拒絕；UpdateProgressSafeAsync 又把
-- 這個失敗吞掉只印一行 log，所以每件工作在真正呼叫 AI 之前的這次進度回報，一直以來
-- 都沒有成功過，只是排程沒有 log 可看才沒被發現（見 AI OCR.md 0.4 節）。
--
-- 這次要修的原因不只是把它補進清單：0.4 節之後新增的「強制停止＝伺服器端也要真的
-- 停手」（Worker 在 ai_recognition 進度回報收到 409 時放棄呼叫 AI）必須先能正確送出
-- 這個階段的進度，否則 409 永遠分不清是「使用者真的取消」還是「這個階段名稱本來就
-- 不合法」，會讓每一件工作都在呼叫 AI 前被誤判成已取消。

alter table public.ocr_jobs
    drop constraint if exists ocr_jobs_progress_stage;

alter table public.ocr_jobs
    add constraint ocr_jobs_progress_stage
        check (progress_stage in (
            'uploading', 'queued', 'claiming', 'downloading', 'ai_recognition',
            'extraction', 'audit', 'validating', 'fallback', 'completed', 'failed'));

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
security invoker
set search_path = ''
as $$
declare
    v_updated integer;
begin
    if p_progress_stage not in (
        'uploading', 'queued', 'claiming', 'downloading', 'ai_recognition',
        'extraction', 'audit', 'validating', 'fallback', 'completed', 'failed')
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

insert into schema_migrations (filename) values ('052_ocr_progress_ai_recognition_stage.sql')
on conflict (filename) do nothing;
