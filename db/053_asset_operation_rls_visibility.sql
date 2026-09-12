-- 2026-09-13：`db/051_asset_operation_sheet.sql` 首次部署後的權限補強。
--
-- 051 的操作表 policy 會以 asset_accounts／asset_owners 驗證 Frank／台股／台股操作。
-- 但既有資產表只有 anon policy，authenticated 執行這個 exists 子查詢時看不到父列，
-- 造成合法管理者也讀不到操作表。這份 migration 只開放管理者讀取必要的兩個父列，
-- 不改既有資產、筆記的 anon 讀寫模型；invest_writer 則維持備份／同步所需的操作表存取。

grant select on public.asset_owners to authenticated;
grant select on public.asset_accounts to authenticated;

drop policy if exists "Frank asset owners admin read" on public.asset_owners;
create policy "Frank asset owners admin read"
    on public.asset_owners
    for select
    to authenticated
    using (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and name = 'Frank'
    );

drop policy if exists "Frank asset accounts admin read" on public.asset_accounts;
create policy "Frank asset accounts admin read"
    on public.asset_accounts
    for select
    to authenticated
    using (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and name = '台股操作'
        and market = '台股'
        and exists (
            select 1
            from public.asset_owners owner
            where owner.id = asset_accounts.owner_id
              and owner.name = 'Frank'
        )
    );

drop policy if exists "operation rows writer" on public.asset_operation_rows;
create policy "operation rows writer"
    on public.asset_operation_rows
    for all
    to invest_writer
    using (true)
    with check (true);

drop policy if exists "operation settings writer" on public.asset_operation_settings;
create policy "operation settings writer"
    on public.asset_operation_settings
    for all
    to invest_writer
    using (true)
    with check (true);

insert into schema_migrations (filename) values ('053_asset_operation_rls_visibility.sql')
on conflict (filename) do nothing;
