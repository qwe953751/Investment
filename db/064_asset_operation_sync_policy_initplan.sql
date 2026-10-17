-- 筆記 #88：將管理者 JWT 先算成 init-plan，避免操作紀錄逐列呼叫 auth.jwt()。
drop policy if exists "Frank operation sync operations admin read"
    on public.asset_operation_sync_operations;
create policy "Frank operation sync operations admin read"
    on public.asset_operation_sync_operations
    for select to authenticated
    using (
        ((select auth.jwt()) -> 'app_metadata' ->> 'access_role') = 'admin'
        and exists (
            select 1
            from public.asset_accounts account
            join public.asset_owners owner on owner.id = account.owner_id
            where account.id = asset_operation_sync_operations.account_id
              and account.name = '台股操作'
              and account.market = '台股'
              and owner.name = 'Frank'
        )
    );

insert into public.schema_migrations (filename) values ('064_asset_operation_sync_policy_initplan.sql')
on conflict (filename) do nothing;
