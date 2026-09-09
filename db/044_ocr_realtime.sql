-- OCR 佇列的 Realtime 喚醒鈴。工作真相仍在 ocr_jobs／ocr_evaluations；
-- Broadcast 只送 id，不送圖片、signed URL、結果或 JWT。

create or replace function public.ocr_queue_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if tg_table_name = 'ocr_jobs'
       and (tg_op = 'INSERT' or (new.status = 'queued' and old.status is distinct from new.status)) then
        perform realtime.send(
            jsonb_build_object('job_id', new.id),
            'ocr_job_queued',
            'ocr:queue',
            true
        );
    elsif tg_table_name = 'ocr_evaluations'
       and (tg_op = 'INSERT' or (new.low_status = 'queued' and old.low_status is distinct from new.low_status)) then
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
    for each row execute function public.ocr_queue_broadcast();

drop trigger if exists ocr_evaluations_realtime_queue on public.ocr_evaluations;
create trigger ocr_evaluations_realtime_queue
    after insert or update of low_status on public.ocr_evaluations
    for each row execute function public.ocr_queue_broadcast();

drop policy if exists "ocr worker receives queue broadcasts" on realtime.messages;
create policy "ocr worker receives queue broadcasts"
    on realtime.messages
    for select
    to authenticated
    using (
        (select realtime.topic()) = 'ocr:queue'
        and realtime.messages.extension = 'broadcast'
        and (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'ocr_worker'
    );

insert into schema_migrations (filename) values ('044_ocr_realtime.sql')
on conflict (filename) do nothing;
