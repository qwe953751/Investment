-- 替換曾把 service_role JWT 直接寫進函式定義的舊 webhook。
-- Vault 的值由獨立管理程序設定；migration、備份函式定義與 log 都不含金鑰或端點。
create or replace function public.dispatch_us_watchlist_webhook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    endpoint text;
    webhook_secret text;
begin
    select decrypted_secret into endpoint from vault.decrypted_secrets
        where name = 'us_watchlist_webhook_url';
    select decrypted_secret into webhook_secret from vault.decrypted_secrets
        where name = 'us_watchlist_webhook_secret';
    if endpoint is null or webhook_secret is null then
        raise exception 'US watchlist webhook configuration missing';
    end if;
    perform net.http_post(
        url := endpoint,
        headers := jsonb_build_object('Content-Type', 'application/json',
            'x-watchlist-webhook-secret', webhook_secret),
        body := jsonb_build_object('type', 'INSERT', 'table', 'asset_holdings', 'record', to_jsonb(new)),
        timeout_milliseconds := 5000
    );
    return new;
end;
$$;

-- 只供既有 trigger 執行，不能由公開 RPC 呼叫 SECURITY DEFINER。
revoke all on function public.dispatch_us_watchlist_webhook()
    from public, anon, authenticated, invest_writer, invest_backup_reader;

insert into public.schema_migrations (filename) values ('073_watchlist_webhook_secret.sql')
on conflict (filename) do nothing;
