-- 受保護資料僅能經專用唯讀角色匯出到加密備份，不擴大 invest_writer 權限。
-- 密碼由獨立部署步驟設定，不能寫進 migration 或 repository。
do $$
begin
    if not exists (select from pg_roles where rolname = 'invest_backup_reader') then
        create role invest_backup_reader nologin nosuperuser nocreatedb nocreaterole
            noinherit noreplication nobypassrls;
    end if;
end $$;

alter role invest_backup_reader set default_transaction_read_only = on;
grant usage on schema public to invest_backup_reader;

do $$
declare
    target text;
begin
    foreach target in array array[
        'access_share_links', 'asset_operation_group_columns', 'asset_operation_snapshots',
        'asset_operation_sync_operations', 'asset_operation_sync_state', 'ocr_evaluations',
        'ocr_jobs', 'ocr_user_routing', 'ocr_workers'
    ] loop
        execute format('grant select on public.%I to invest_backup_reader', target);
        execute format('drop policy if exists "protected backup read" on public.%I', target);
        execute format('create policy "protected backup read" on public.%I for select to invest_backup_reader using (true)', target);
    end loop;
end $$;

insert into public.schema_migrations (filename) values ('072_protected_backup.sql')
on conflict (filename) do nothing;
