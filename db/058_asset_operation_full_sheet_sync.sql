-- Google Sheet「操作(台)」雙向同步。
--
-- Google Sheet 是受控資料區的正式主檔；Supabase 保存完整 48 族群快照、網站草稿
-- 與同步狀態。前端只讀取／呼叫 Edge Function，不直接持有 Google 憑證。

alter table public.asset_operation_rows
    add column if not exists stock_code text,
    add column if not exists stock_name text,
    add column if not exists group_flags jsonb not null default '{}'::jsonb,
    add column if not exists snapshot_id uuid;

update public.asset_operation_rows
set stock_code = nullif(split_part(btrim(stock), ' ', 1), ''),
    stock_name = nullif(regexp_replace(btrim(stock), '^\S+\s*', ''), '')
where stock_code is null or stock_name is null;

update public.asset_operation_rows
set group_flags = jsonb_build_object(
    'legacy:cpo', cpo,
    'legacy:pcb', pcb,
    'legacy:asic', asic,
    'legacy:cooling', cooling,
    'legacy:passive', passive,
    'legacy:other', other,
    'legacy:memory', memory,
    'legacy:abf', abf,
    'legacy:power', power,
    'legacy:hinge', hinge,
    'legacy:pmic', pmic,
    'legacy:testing', testing,
    'legacy:leadframe', leadframe,
    'legacy:bbu', bbu)
where group_flags = '{}'::jsonb;

create table if not exists public.asset_operation_group_columns (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references public.asset_accounts (id) on delete cascade,
    label text not null,
    metadata_key text not null,
    sheet_column_index integer not null check (sheet_column_index >= 5),
    display_order integer not null default 0,
    active boolean not null default true,
    legacy_key text,
    updated_at timestamptz not null default now(),
    unique (account_id, metadata_key),
    unique (account_id, sheet_column_index)
);

create index if not exists asset_operation_group_columns_account_order
    on public.asset_operation_group_columns (account_id, display_order, id);

create table if not exists public.asset_operation_snapshots (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references public.asset_accounts (id) on delete cascade,
    source text not null check (source in ('google_import', 'web_draft', 'google_export')),
    status text not null check (status in ('pending', 'active', 'failed', 'needs_reconcile', 'superseded')),
    base_google_hash text,
    content_hash text not null,
    row_count integer not null check (row_count >= 0),
    payload jsonb not null,
    idempotency_key text,
    created_by uuid,
    error_code text,
    error_message text,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (account_id, idempotency_key)
);

create index if not exists asset_operation_snapshots_account_created
    on public.asset_operation_snapshots (account_id, created_at desc);

create table if not exists public.asset_operation_sync_state (
    account_id uuid primary key references public.asset_accounts (id) on delete cascade,
    version bigint not null default 0,
    active_snapshot_id uuid references public.asset_operation_snapshots (id),
    base_google_hash text,
    last_google_hash text,
    status text not null default 'never_imported'
        check (status in ('never_imported', 'clean', 'dirty', 'conflict', 'syncing', 'failed', 'needs_reconcile')),
    last_checked_at timestamptz,
    last_imported_at timestamptz,
    last_exported_at timestamptz,
    last_error_code text,
    last_error_message text,
    updated_at timestamptz not null default now()
);

alter table public.asset_operation_group_columns enable row level security;
alter table public.asset_operation_snapshots enable row level security;
alter table public.asset_operation_sync_state enable row level security;

drop policy if exists "Frank operation groups admin read" on public.asset_operation_group_columns;
create policy "Frank operation groups admin read"
    on public.asset_operation_group_columns
    for select
    to authenticated
    using (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and exists (
            select 1
            from public.asset_accounts account
            join public.asset_owners owner on owner.id = account.owner_id
            where account.id = asset_operation_group_columns.account_id
              and account.name = '台股操作'
              and account.market = '台股'
              and owner.name = 'Frank'
        )
    );

drop policy if exists "Frank operation snapshots admin read" on public.asset_operation_snapshots;
create policy "Frank operation snapshots admin read"
    on public.asset_operation_snapshots
    for select
    to authenticated
    using (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and exists (
            select 1
            from public.asset_accounts account
            join public.asset_owners owner on owner.id = account.owner_id
            where account.id = asset_operation_snapshots.account_id
              and account.name = '台股操作'
              and account.market = '台股'
              and owner.name = 'Frank'
        )
    );

drop policy if exists "Frank operation sync state admin read" on public.asset_operation_sync_state;
create policy "Frank operation sync state admin read"
    on public.asset_operation_sync_state
    for select
    to authenticated
    using (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and exists (
            select 1
            from public.asset_accounts account
            join public.asset_owners owner on owner.id = account.owner_id
            where account.id = asset_operation_sync_state.account_id
              and account.name = '台股操作'
              and account.market = '台股'
              and owner.name = 'Frank'
        )
    );

revoke all on public.asset_operation_group_columns from anon, authenticated;
revoke all on public.asset_operation_snapshots from anon, authenticated;
revoke all on public.asset_operation_sync_state from anon, authenticated;
grant select on public.asset_operation_group_columns to authenticated;
grant select on public.asset_operation_snapshots to authenticated;
grant select on public.asset_operation_sync_state to authenticated;
grant select, insert, update, delete on public.asset_operation_group_columns to invest_writer;
grant select, insert, update, delete on public.asset_operation_snapshots to invest_writer;
grant select, insert, update, delete on public.asset_operation_sync_state to invest_writer;

-- 由 Edge Function 以 service_role 呼叫。SECURITY INVOKER 保持 RLS 語意；
-- 不把高權限函式變成 public 可呼叫的 SECURITY DEFINER 端點。
create or replace function public.replace_asset_operation_snapshot(
    p_account_id uuid,
    p_snapshot_id uuid,
    p_version bigint,
    p_rows jsonb,
    p_group_columns jsonb,
    p_base_google_hash text,
    p_content_hash text,
    p_status text default 'active',
    p_source text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    current_version bigint;
    target_is_valid boolean;
    row_count integer;
    snapshot_source text;
begin
    select exists (
        select 1
        from public.asset_accounts account
        join public.asset_owners owner on owner.id = account.owner_id
        where account.id = p_account_id
          and account.name = '台股操作'
          and account.market = '台股'
          and owner.name = 'Frank'
    ) into target_is_valid;

    if not target_is_valid then
        raise exception 'invalid asset operation account' using errcode = '42501';
    end if;

    snapshot_source := coalesce(
        p_source,
        case when p_status = 'active' then 'google_import' else 'web_draft' end);
    if p_status not in ('active', 'pending')
       or snapshot_source not in ('google_import', 'web_draft', 'google_export') then
        raise exception 'invalid asset operation snapshot status/source' using errcode = '22023';
    end if;

    select version into current_version
    from public.asset_operation_sync_state
    where account_id = p_account_id
    for update;

    if current_version is not null and current_version <> p_version then
        raise exception 'asset operation version conflict' using errcode = '40001';
    end if;

    row_count := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));

    insert into public.asset_operation_snapshots
        (id, account_id, source, status, base_google_hash, content_hash, row_count, payload, completed_at)
    values
        (p_snapshot_id, p_account_id,
         snapshot_source,
         p_status, p_base_google_hash, p_content_hash, row_count, p_rows,
         case when p_status = 'active' then now() else null end)
    on conflict (id) do update set
        source = excluded.source,
        status = excluded.status,
        base_google_hash = excluded.base_google_hash,
        content_hash = excluded.content_hash,
        row_count = excluded.row_count,
        payload = excluded.payload,
        completed_at = excluded.completed_at;

    delete from public.asset_operation_group_columns where account_id = p_account_id;
    insert into public.asset_operation_group_columns
        (id, account_id, label, metadata_key, sheet_column_index, display_order, active, legacy_key)
    select id, p_account_id, label, metadata_key, sheet_column_index, display_order, active, legacy_key
    from jsonb_to_recordset(coalesce(p_group_columns, '[]'::jsonb)) as groups(
        id uuid,
        label text,
        metadata_key text,
        sheet_column_index integer,
        display_order integer,
        active boolean,
        legacy_key text);

    if p_status = 'active' then
        delete from public.asset_operation_rows where account_id = p_account_id;
        insert into public.asset_operation_rows
            (account_id, buy, stock, stock_code, stock_name, group_flags, sort_order, snapshot_id, updated_at)
        select p_account_id,
               row_data.buy,
               row_data.stock,
               row_data.stock_code,
               row_data.stock_name,
               coalesce(row_data.group_flags, '{}'::jsonb),
               row_data.sort_order,
               p_snapshot_id,
               now()
        from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row_data(
            buy integer,
            stock text,
            stock_code text,
            stock_name text,
            group_flags jsonb,
            sort_order integer);
    end if;

    insert into public.asset_operation_sync_state
        (account_id, version, active_snapshot_id, base_google_hash, last_google_hash, status,
         last_imported_at, last_exported_at, updated_at)
    values
        (p_account_id, coalesce(current_version, 0) + 1, p_snapshot_id,
         p_base_google_hash,
         case when p_status = 'active' then p_content_hash else null end,
         case when p_status = 'active' then 'clean' else 'dirty' end,
         case when snapshot_source = 'google_import' then now() else null end,
         case when snapshot_source = 'google_export' then now() else null end,
         now())
    on conflict (account_id) do update set
        version = public.asset_operation_sync_state.version + 1,
        active_snapshot_id = case when p_status = 'active' then excluded.active_snapshot_id
                                  else public.asset_operation_sync_state.active_snapshot_id end,
        base_google_hash = case when p_status = 'active' then excluded.base_google_hash
                                else public.asset_operation_sync_state.base_google_hash end,
        last_google_hash = case when p_status = 'active' then excluded.last_google_hash
                                else public.asset_operation_sync_state.last_google_hash end,
        status = excluded.status,
        last_imported_at = case when snapshot_source = 'google_import' then now()
                               else public.asset_operation_sync_state.last_imported_at end,
        last_exported_at = case when snapshot_source = 'google_export' then now()
                               else public.asset_operation_sync_state.last_exported_at end,
        updated_at = now();

    return jsonb_build_object('version', coalesce(current_version, 0) + 1, 'rowCount', row_count);
end;
$$;

revoke all on function public.replace_asset_operation_snapshot(uuid, uuid, bigint, jsonb, jsonb, text, text, text, text)
    from public, anon, authenticated;
grant execute on function public.replace_asset_operation_snapshot(uuid, uuid, bigint, jsonb, jsonb, text, text, text, text)
    to service_role, invest_writer;

insert into public.schema_migrations (filename) values ('058_asset_operation_full_sheet_sync.sql')
on conflict (filename) do nothing;
