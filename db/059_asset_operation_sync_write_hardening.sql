-- 操作表的正式寫入只走 asset-operation-sync Edge Function。
-- authenticated 前端仍可讀取目前列與同步狀態，但不能直接改表繞過
-- Google hash 衝突檢查、版本控制、刪除同步與營收創高計算。

drop policy if exists "Frank operation rows admin" on public.asset_operation_rows;
create policy "Frank operation rows admin read"
    on public.asset_operation_rows
    for select
    to authenticated
    using (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and exists (
            select 1
            from public.asset_accounts account
            join public.asset_owners owner on owner.id = account.owner_id
            where account.id = asset_operation_rows.account_id
              and account.name = '台股操作'
              and account.market = '台股'
              and owner.name = 'Frank'
        )
    );

drop policy if exists "Frank operation settings admin" on public.asset_operation_settings;
create policy "Frank operation settings admin read"
    on public.asset_operation_settings
    for select
    to authenticated
    using (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and exists (
            select 1
            from public.asset_accounts account
            join public.asset_owners owner on owner.id = account.owner_id
            where account.id = asset_operation_settings.account_id
              and account.name = '台股操作'
              and account.market = '台股'
              and owner.name = 'Frank'
        )
    );

revoke insert, update, delete on public.asset_operation_rows from authenticated;
revoke insert, update, delete on public.asset_operation_settings from authenticated;
grant select on public.asset_operation_rows to authenticated;
grant select on public.asset_operation_settings to authenticated;

insert into public.schema_migrations (filename) values ('059_asset_operation_sync_write_hardening.sql')
on conflict (filename) do nothing;
