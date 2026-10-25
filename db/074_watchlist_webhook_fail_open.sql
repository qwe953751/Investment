-- 美股新持倉的即時回補只是「加速」，不是持倉能不能寫入的條件。
--
-- 073 讀不到 Vault 的端點或 secret 時 raise exception。但觸發器是
-- AFTER INSERT ON public.asset_holdings FOR EACH ROW，沒有 WHEN 條件，是不是美股要到 Edge Function 才判斷，
-- 所以 Vault 一缺（換專案或還原後還沒補設、輪替到一半、被誤刪），任何市場的持倉新增——手動新增、
-- OCR 匯入、台股、現金——都會整筆失敗，資產頁寫不進去。每日的 us-daily-snapshot 本來就會補漏
-- （UsWatchlistStore.SyncFromHoldingsAsync），這條路徑壞掉的代價只該是「新美股持倉晚一天才有報價」。
--
-- 改成：讀不到設定，或 Vault／pg_net 出任何錯，都只記一則 warning，持倉照常寫入。
-- warning 只帶 SQLSTATE：原始錯誤訊息可能含端點網址或 secret 的片段，不能進資料庫 log。
-- 其餘不變：仍從 Vault 讀 url 與 secret、同一組 header 與 body、SECURITY DEFINER 與空的 search_path、
-- 公開／一般資料角色不能直接呼叫。
--
-- 代價：Vault 缺設定時畫面不再出現「新增失敗」這個症狀。檢查方式見 Doc/開發環境.md
-- 「美股新持倉即時觸發」：看資料庫 log 的 "US watchlist webhook" warning，或 net._http_response 的 status_code。
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
    begin
        select decrypted_secret into endpoint from vault.decrypted_secrets
            where name = 'us_watchlist_webhook_url';
        select decrypted_secret into webhook_secret from vault.decrypted_secrets
            where name = 'us_watchlist_webhook_secret';
        if endpoint is null or webhook_secret is null then
            raise warning 'US watchlist webhook configuration missing; holding saved without dispatch';
            return new;
        end if;
        perform net.http_post(
            url := endpoint,
            headers := jsonb_build_object('Content-Type', 'application/json',
                'x-watchlist-webhook-secret', webhook_secret),
            body := jsonb_build_object('type', 'INSERT', 'table', 'asset_holdings', 'record', to_jsonb(new)),
            timeout_milliseconds := 5000
        );
    exception when others then
        raise warning 'US watchlist webhook dispatch skipped (SQLSTATE %); holding saved', sqlstate;
    end;
    return new;
end;
$$;

-- create or replace 會保留原本的權限；這裡再明講一次，讓這支 migration 單獨看也自洽。
-- 只供既有 trigger 執行，不能由公開 RPC 呼叫 SECURITY DEFINER。
revoke all on function public.dispatch_us_watchlist_webhook()
    from public, anon, authenticated, invest_writer, invest_backup_reader;

insert into public.schema_migrations (filename) values ('074_watchlist_webhook_fail_open.sql')
on conflict (filename) do nothing;
