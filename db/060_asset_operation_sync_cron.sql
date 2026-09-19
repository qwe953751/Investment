-- 每日自動把 Google Sheet 主檔匯入 Supabase。
--
-- 台北 18:30 = UTC 10:30。這個排程只做 Google -> Supabase import；網站草稿
-- status=dirty 時 Edge Function 會拒絕自動覆蓋，避免吃掉尚未匯出的網站修改。
-- ASSET_OPERATION_CRON_SECRET 必須先以 Supabase Vault secret 名稱
-- `asset_operation_cron_secret` 建立；沒有 secret 時不建立排程，避免留下未保護的
-- HTTP 呼叫。migration 套用後若才補 secret，需重新執行本檔的 cron 區段。

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $migration$
declare
    existing_job_id bigint;
    has_secret boolean;
begin
    select exists (
        select 1
        from vault.decrypted_secrets
        where name = 'asset_operation_cron_secret'
          and decrypted_secret is not null
          and decrypted_secret <> ''
    ) into has_secret;

    select jobid
      into existing_job_id
      from cron.job
     where jobname = 'asset-operation-sheet-import';

    if existing_job_id is not null then
        perform cron.unschedule(existing_job_id);
    end if;

    if has_secret then
        perform cron.schedule(
            'asset-operation-sheet-import',
            '30 10 * * *',
            $cron$
                select net.http_post(
                    url := 'https://dehzxlxyfvtnylwgbmqy.supabase.co/functions/v1/asset-operation-sync',
                    headers := jsonb_build_object(
                        'Content-Type', 'application/json',
                        'x-asset-operation-cron-secret',
                        (select decrypted_secret
                           from vault.decrypted_secrets
                          where name = 'asset_operation_cron_secret'
                          limit 1)
                    ),
                    body := jsonb_build_object(
                        'action', 'import',
                        'accountId', (
                            select account.id
                              from public.asset_accounts account
                              join public.asset_owners owner on owner.id = account.owner_id
                             where account.name = '台股操作'
                               and account.market = '台股'
                               and owner.name = 'Frank'
                             limit 1
                        )
                    )
                );
            $cron$
        );
    else
        raise notice '未建立 asset-operation-sheet-import：請先設定 Vault secret asset_operation_cron_secret。';
    end if;
end
$migration$;

insert into public.schema_migrations (filename) values ('060_asset_operation_sync_cron.sql')
on conflict (filename) do nothing;
