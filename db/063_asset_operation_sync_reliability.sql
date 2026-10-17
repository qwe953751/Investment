-- 筆記 #88：讓操作表版本、欄位設定與跨 Google／PostgreSQL 同步結果可追蹤。
-- Google API 呼叫不在資料庫交易內；RPC 只用短交易 claim/finalize。

alter table public.asset_operation_settings
    add column if not exists settings_revision bigint not null default 0;

alter table public.asset_operation_sync_state
    add column if not exists base_google_structure_hash text,
    add column if not exists last_google_structure_hash text,
    add column if not exists google_fingerprint_version integer;

create table if not exists public.asset_operation_sync_operations (
    operation_id uuid primary key,
    account_id uuid not null references public.asset_accounts (id) on delete cascade,
    action text not null check (action in ('import', 'export', 'save-draft', 'save-column-order')),
    protocol_version integer not null check (protocol_version = 2),
    actor_kind text not null check (actor_kind in ('admin', 'cron')),
    actor_id uuid,
    request_hash text not null,
    expected_version bigint not null,
    expected_settings_revision bigint not null,
    expected_pending_snapshot_id uuid,
    input_json jsonb not null default '{}'::jsonb,
    stage text not null default 'claimed',
    status text not null check (status in ('running', 'succeeded', 'failed', 'conflict', 'reconcile_required')),
    google_write_state text not null default 'not_started'
        check (google_write_state in ('not_started', 'unknown', 'confirmed')),
    expected_after_data_hash text,
    expected_after_structure_hash text,
    finalize_json jsonb not null default '{}'::jsonb,
    result jsonb,
    error_code text,
    error_message text,
    started_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz
);

alter table public.asset_operation_sync_operations
    drop constraint if exists asset_operation_sync_operations_action_check;
alter table public.asset_operation_sync_operations
    add constraint asset_operation_sync_operations_action_check
    check (action in (
        'import', 'export', 'save-draft', 'save-column-order',
        'repair-stale-tail', 'bootstrap-metadata', 'repair-metadata'
    ));

create unique index if not exists asset_operation_sync_one_active_operation
    on public.asset_operation_sync_operations (account_id)
    where status in ('running', 'reconcile_required');

create index if not exists asset_operation_sync_operations_account_recent
    on public.asset_operation_sync_operations (account_id, started_at desc);

alter table public.asset_operation_sync_operations enable row level security;
drop policy if exists "Frank operation sync operations admin read"
    on public.asset_operation_sync_operations;
create policy "Frank operation sync operations admin read"
    on public.asset_operation_sync_operations
    for select to authenticated
    using (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
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

revoke all on public.asset_operation_sync_operations from anon, authenticated;
grant select on public.asset_operation_sync_operations to authenticated;
grant all on public.asset_operation_sync_operations to service_role;

create or replace function public.assert_asset_operation_account_v2(p_account_id uuid)
returns void
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
    if not exists (
        select 1
        from public.asset_accounts account
        join public.asset_owners owner on owner.id = account.owner_id
        where account.id = p_account_id
          and account.name = '台股操作'
          and account.market = '台股'
          and owner.name = 'Frank'
    ) then
        raise exception using errcode = '42501', message = 'invalid_asset_operation_account';
    end if;
end;
$$;

create or replace function public.assert_asset_operation_column_order_v2(
    p_account_id uuid,
    p_column_order jsonb)
returns void
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
    expected_count integer;
    actual_count integer;
    unique_count integer;
begin
    if jsonb_typeof(p_column_order) <> 'array' then
        raise exception using errcode = '22023', message = 'invalid_column_order';
    end if;

    select count(*) + 4 into expected_count
    from public.asset_operation_group_columns
    where account_id = p_account_id and active;

    select count(*), count(distinct value)
      into actual_count, unique_count
      from jsonb_array_elements_text(p_column_order) as item(value);

    if actual_count <> expected_count or unique_count <> actual_count then
        raise exception using errcode = '22023', message = 'invalid_column_order';
    end if;

    if exists (
        select 1
        from jsonb_array_elements_text(p_column_order) as item(value)
        where item.value not in ('weight', 'buy', 'stock', 'revenueHigh')
          and not exists (
              select 1
              from public.asset_operation_group_columns group_column
              where group_column.account_id = p_account_id
                and group_column.active
                and item.value = 'group:' || group_column.id::text
          )
    ) or exists (
        select 1
        from unnest(array['weight', 'buy', 'stock', 'revenueHigh']) fixed(key)
        where not exists (
            select 1
            from jsonb_array_elements_text(p_column_order) as item(value)
            where item.value = fixed.key
        )
    ) or exists (
        select 1
        from public.asset_operation_group_columns group_column
        where group_column.account_id = p_account_id
          and group_column.active
          and not exists (
              select 1
              from jsonb_array_elements_text(p_column_order) as item(value)
              where item.value = 'group:' || group_column.id::text
          )
    ) then
        raise exception using errcode = '22023', message = 'invalid_column_order';
    end if;
end;
$$;

create or replace function public.assert_asset_operation_group_columns_v2(p_group_columns jsonb)
returns void
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
    item_count integer;
    id_count integer;
    column_count integer;
    minimum_column integer;
    maximum_column integer;
begin
    if jsonb_typeof(p_group_columns) <> 'array' then
        raise exception using errcode = '22023', message = 'invalid_group_columns';
    end if;
    select count(*), count(distinct item.id), count(distinct item.sheet_column_index),
           min(item.sheet_column_index), max(item.sheet_column_index)
      into item_count, id_count, column_count, minimum_column, maximum_column
      from jsonb_to_recordset(p_group_columns) as item(
          id uuid, sheet_column_index integer, metadata_key text, label text);
    if item_count <> 48 or id_count <> 48 or column_count <> 48
       or minimum_column <> 5 or maximum_column <> 52
       or exists (
           select 1 from jsonb_to_recordset(p_group_columns) as item(
               id uuid, sheet_column_index integer, metadata_key text, label text)
           where item.id is null or item.metadata_key <> 'group:' || item.id::text
              or item.label is null
       ) then
        raise exception using errcode = '22023', message = 'invalid_group_columns';
    end if;
end;
$$;

create or replace function public.asset_operation_read_state_v2(p_account_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
    select jsonb_build_object(
        'rows', coalesce((
            select jsonb_agg(to_jsonb(operation_row) order by operation_row.sort_order, operation_row.id)
            from public.asset_operation_rows operation_row
            where operation_row.account_id = p_account_id
        ), '[]'::jsonb),
        'groups', coalesce((
            select jsonb_agg(to_jsonb(group_column) order by group_column.display_order, group_column.id)
            from public.asset_operation_group_columns group_column
            where group_column.account_id = p_account_id and group_column.active
        ), '[]'::jsonb),
        'settings', coalesce((
            select to_jsonb(settings_row)
            from public.asset_operation_settings settings_row
            where settings_row.account_id = p_account_id
        ), jsonb_build_object('account_id', p_account_id, 'column_order', '[]'::jsonb, 'settings_revision', 0)),
        'syncState', coalesce((
            select to_jsonb(sync_state)
            from public.asset_operation_sync_state sync_state
            where sync_state.account_id = p_account_id
        ), jsonb_build_object('account_id', p_account_id, 'version', 0, 'status', 'never_imported')),
        'pending', (
            select jsonb_build_object(
                'id', snapshot.id,
                'content_hash', snapshot.content_hash,
                'base_google_hash', snapshot.base_google_hash,
                'row_count', snapshot.row_count,
                'created_at', snapshot.created_at
            )
            from public.asset_operation_snapshots snapshot
            where snapshot.account_id = p_account_id and snapshot.status = 'pending'
            order by snapshot.created_at desc, snapshot.id desc
            limit 1
        ),
        'activeOperation', (
            select jsonb_build_object(
                'operationId', operation.operation_id,
                'action', operation.action,
                'status', operation.status,
                'stage', operation.stage,
                'googleWriteState', operation.google_write_state,
                'errorCode', operation.error_code
            )
            from public.asset_operation_sync_operations operation
            where operation.account_id = p_account_id
              and operation.status in ('running', 'reconcile_required')
            order by operation.started_at desc
            limit 1
        )
    );
$$;

create or replace function public.asset_operation_begin_v2(
    p_operation_id uuid,
    p_account_id uuid,
    p_action text,
    p_protocol_version integer,
    p_actor_kind text,
    p_actor_id uuid,
    p_request_hash text,
    p_expected_version bigint,
    p_expected_settings_revision bigint,
    p_expected_pending_snapshot_id uuid,
    p_input_json jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    existing_operation public.asset_operation_sync_operations%rowtype;
    current_version bigint;
    current_settings_revision bigint;
    current_pending uuid;
    current_status text;
begin
    perform public.assert_asset_operation_account_v2(p_account_id);
    if p_action not in ('import', 'export', 'repair-stale-tail', 'bootstrap-metadata', 'repair-metadata')
       or p_protocol_version <> 2
       or p_actor_kind not in ('admin', 'cron') or p_request_hash is null then
        raise exception using errcode = '22023', message = 'invalid_operation_request';
    end if;

    select * into existing_operation
    from public.asset_operation_sync_operations
    where operation_id = p_operation_id;
    if found then
        if existing_operation.account_id <> p_account_id
           or existing_operation.action <> p_action
           or existing_operation.request_hash <> p_request_hash then
            raise exception using errcode = '22023', message = 'idempotency_key_reused';
        end if;
        return jsonb_build_object(
            'operationId', existing_operation.operation_id,
            'status', existing_operation.status,
            'stage', existing_operation.stage,
            'googleWriteState', existing_operation.google_write_state,
            'result', existing_operation.result,
            'errorCode', existing_operation.error_code,
            'errorMessage', existing_operation.error_message,
            'existing', true
        );
    end if;

    insert into public.asset_operation_sync_state (account_id)
    values (p_account_id) on conflict (account_id) do nothing;
    insert into public.asset_operation_settings (account_id)
    values (p_account_id) on conflict (account_id) do nothing;

    select version, status into current_version, current_status
    from public.asset_operation_sync_state
    where account_id = p_account_id
    for update;
    select settings_revision into current_settings_revision
    from public.asset_operation_settings
    where account_id = p_account_id
    for update;

    if current_version <> p_expected_version then
        raise exception using errcode = '40001', message = 'data_version_conflict';
    end if;
    if current_settings_revision <> p_expected_settings_revision then
        raise exception using errcode = '40001', message = 'settings_conflict';
    end if;

    select id into current_pending
    from public.asset_operation_snapshots
    where account_id = p_account_id and status = 'pending'
    order by created_at desc, id desc
    limit 1;
    if p_action = 'import' and current_pending is not null
       and (coalesce((p_input_json ->> 'overwriteDraft')::boolean, false) is false
            or p_actor_kind <> 'admin') then
        raise exception using errcode = 'P0001', message = 'draft_pending';
    end if;
    if current_pending is distinct from p_expected_pending_snapshot_id then
        raise exception using errcode = '40001', message = 'data_version_conflict';
    end if;
    if p_action = 'export' and current_status = 'never_imported' then
        raise exception using errcode = 'P0001', message = 'baseline_required';
    end if;
    if p_action = 'export' and exists (
        select 1 from public.asset_operation_sync_state state
        where state.account_id = p_account_id and state.base_google_structure_hash is null
    ) then
        raise exception using errcode = 'P0001', message = 'baseline_required';
    end if;
    if exists (
        select 1 from public.asset_operation_sync_operations operation
        where operation.account_id = p_account_id
          and operation.status in ('running', 'reconcile_required')
    ) then
        raise exception using errcode = '55P03', message = 'sync_in_progress';
    end if;

    insert into public.asset_operation_sync_operations (
        operation_id, account_id, action, protocol_version, actor_kind, actor_id,
        request_hash, expected_version, expected_settings_revision,
        expected_pending_snapshot_id, input_json, stage, status)
    values (
        p_operation_id, p_account_id, p_action, p_protocol_version, p_actor_kind, p_actor_id,
        p_request_hash, p_expected_version, p_expected_settings_revision,
        p_expected_pending_snapshot_id, coalesce(p_input_json, '{}'::jsonb), 'claimed', 'running');

    return jsonb_build_object('operationId', p_operation_id, 'status', 'running', 'stage', 'claimed',
                              'googleWriteState', 'not_started', 'existing', false);
exception
    when unique_violation then
        raise exception using errcode = '55P03', message = 'sync_in_progress';
end;
$$;

create or replace function public.asset_operation_set_stage_v2(
    p_operation_id uuid,
    p_account_id uuid,
    p_stage text,
    p_google_write_state text,
    p_expected_after_data_hash text default null,
    p_expected_after_structure_hash text default null,
    p_finalize_json jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    operation public.asset_operation_sync_operations%rowtype;
begin
    select * into operation
    from public.asset_operation_sync_operations
    where operation_id = p_operation_id and account_id = p_account_id
    for update;
    if not found then
        raise exception using errcode = 'P0002', message = 'operation_not_found';
    end if;
    if operation.status = 'succeeded' then
        return jsonb_build_object('status', operation.status, 'result', operation.result);
    end if;
    if operation.status not in ('running', 'reconcile_required')
       or p_google_write_state not in ('not_started', 'unknown', 'confirmed') then
        raise exception using errcode = '55000', message = 'invalid_operation_transition';
    end if;
    update public.asset_operation_sync_operations
    set stage = p_stage,
        google_write_state = p_google_write_state,
        expected_after_data_hash = coalesce(p_expected_after_data_hash, expected_after_data_hash),
        expected_after_structure_hash = coalesce(p_expected_after_structure_hash, expected_after_structure_hash),
        finalize_json = case when p_finalize_json = '{}'::jsonb then finalize_json else p_finalize_json end,
        status = case when p_google_write_state in ('unknown', 'confirmed') then 'reconcile_required' else 'running' end,
        updated_at = now()
    where operation_id = p_operation_id;
    return jsonb_build_object('status', case when p_google_write_state in ('unknown', 'confirmed') then 'reconcile_required' else 'running' end,
                              'stage', p_stage, 'googleWriteState', p_google_write_state);
end;
$$;

create or replace function public.asset_operation_fail_v2(
    p_operation_id uuid,
    p_account_id uuid,
    p_status text,
    p_code text,
    p_message text,
    p_google_write_state text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    operation public.asset_operation_sync_operations%rowtype;
    next_status text;
begin
    if p_status not in ('failed', 'conflict', 'reconcile_required')
       or p_google_write_state not in ('not_started', 'unknown', 'confirmed') then
        raise exception using errcode = '22023', message = 'invalid_operation_transition';
    end if;
    select * into operation from public.asset_operation_sync_operations
    where operation_id = p_operation_id and account_id = p_account_id for update;
    if not found then raise exception using errcode = 'P0002', message = 'operation_not_found'; end if;
    if operation.status = 'succeeded' then
        return jsonb_build_object('status', operation.status, 'result', operation.result);
    end if;
    next_status := case
        when p_google_write_state in ('unknown', 'confirmed') then 'reconcile_required'
        else p_status end;
    update public.asset_operation_sync_operations
    set status = next_status,
        stage = coalesce(operation.stage, 'failed'),
        google_write_state = p_google_write_state,
        error_code = left(coalesce(p_code, 'sync_failed'), 100),
        error_message = left(coalesce(p_message, '同步失敗。'), 500),
        updated_at = now(),
        completed_at = case when next_status in ('failed', 'conflict') then now() else null end
    where operation_id = p_operation_id;
    return jsonb_build_object('status', next_status, 'operationId', p_operation_id,
                              'googleWriteState', p_google_write_state, 'errorCode', p_code);
end;
$$;

create or replace function public.asset_operation_save_column_order_v2(
    p_operation_id uuid,
    p_account_id uuid,
    p_actor_id uuid,
    p_request_hash text,
    p_expected_version bigint,
    p_expected_settings_revision bigint,
    p_column_order jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    state_version bigint;
    state_status text;
    settings_row public.asset_operation_settings%rowtype;
    operation public.asset_operation_sync_operations%rowtype;
    result_json jsonb;
begin
    perform public.assert_asset_operation_account_v2(p_account_id);
    select * into operation from public.asset_operation_sync_operations
    where operation_id = p_operation_id;
    if found then
        if operation.account_id <> p_account_id or operation.action <> 'save-column-order'
           or operation.request_hash <> p_request_hash then
            raise exception using errcode = '22023', message = 'idempotency_key_reused';
        end if;
        return coalesce(operation.result, jsonb_build_object('operationId', p_operation_id, 'outcome', operation.status));
    end if;

    insert into public.asset_operation_sync_state (account_id) values (p_account_id) on conflict do nothing;
    insert into public.asset_operation_settings (account_id) values (p_account_id) on conflict do nothing;
    select version, status into state_version, state_status
    from public.asset_operation_sync_state where account_id = p_account_id for update;
    select * into settings_row from public.asset_operation_settings where account_id = p_account_id for update;
    if state_version <> p_expected_version then
        raise exception using errcode = '40001', message = 'data_version_conflict';
    end if;
    if settings_row.settings_revision <> p_expected_settings_revision then
        raise exception using errcode = '40001', message = 'settings_conflict';
    end if;
    if exists (
        select 1 from public.asset_operation_sync_operations
        where account_id = p_account_id and status in ('running', 'reconcile_required')
    ) then raise exception using errcode = '55P03', message = 'sync_in_progress'; end if;
    perform public.assert_asset_operation_column_order_v2(p_account_id, p_column_order);

    update public.asset_operation_settings
    set column_order = p_column_order,
        settings_revision = settings_revision + case when column_order is distinct from p_column_order then 1 else 0 end,
        updated_at = case when column_order is distinct from p_column_order then now() else updated_at end
    where account_id = p_account_id
    returning * into settings_row;
    result_json := jsonb_build_object('ok', true, 'protocolVersion', 2, 'operationId', p_operation_id,
        'action', 'save-column-order', 'outcome', 'succeeded', 'version', state_version,
        'settingsRevision', settings_row.settings_revision, 'columnOrder', settings_row.column_order);
    insert into public.asset_operation_sync_operations (
        operation_id, account_id, action, protocol_version, actor_kind, actor_id, request_hash,
        expected_version, expected_settings_revision, input_json, status, result, completed_at)
    values (p_operation_id, p_account_id, 'save-column-order', 2, 'admin', p_actor_id, p_request_hash,
        p_expected_version, p_expected_settings_revision,
        jsonb_build_object('columnOrder', p_column_order), 'succeeded', result_json, now());
    return result_json;
exception when unique_violation then
    raise exception using errcode = '55P03', message = 'sync_in_progress';
end;
$$;

create or replace function public.asset_operation_save_draft_v2(
    p_operation_id uuid,
    p_account_id uuid,
    p_actor_id uuid,
    p_request_hash text,
    p_expected_version bigint,
    p_expected_settings_revision bigint,
    p_snapshot_id uuid,
    p_rows jsonb,
    p_group_columns jsonb,
    p_column_order jsonb,
    p_content_hash text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    state_version bigint;
    settings_row public.asset_operation_settings%rowtype;
    operation public.asset_operation_sync_operations%rowtype;
    rpc_result jsonb;
    result_json jsonb;
begin
    perform public.assert_asset_operation_account_v2(p_account_id);
    select * into operation from public.asset_operation_sync_operations where operation_id = p_operation_id;
    if found then
        if operation.account_id <> p_account_id or operation.action <> 'save-draft'
           or operation.request_hash <> p_request_hash then
            raise exception using errcode = '22023', message = 'idempotency_key_reused';
        end if;
        return coalesce(operation.result, jsonb_build_object('operationId', p_operation_id, 'outcome', operation.status));
    end if;
    if jsonb_typeof(p_rows) <> 'array' or jsonb_typeof(p_group_columns) <> 'array' then
        raise exception using errcode = '22023', message = 'invalid_draft_payload';
    end if;

    insert into public.asset_operation_sync_state (account_id) values (p_account_id) on conflict do nothing;
    insert into public.asset_operation_settings (account_id) values (p_account_id) on conflict do nothing;
    select version into state_version from public.asset_operation_sync_state where account_id = p_account_id for update;
    select * into settings_row from public.asset_operation_settings where account_id = p_account_id for update;
    if state_version <> p_expected_version then
        raise exception using errcode = '40001', message = 'data_version_conflict';
    end if;
    if settings_row.settings_revision <> p_expected_settings_revision then
        raise exception using errcode = '40001', message = 'settings_conflict';
    end if;
    if exists (
        select 1 from public.asset_operation_sync_operations
        where account_id = p_account_id and status in ('running', 'reconcile_required')
    ) then raise exception using errcode = '55P03', message = 'sync_in_progress'; end if;
    perform public.assert_asset_operation_column_order_v2(p_account_id, p_column_order);

    update public.asset_operation_snapshots
    set status = 'superseded', completed_at = now(), error_code = 'replaced_by_newer_draft'
    where account_id = p_account_id and status = 'pending';
    rpc_result := public.replace_asset_operation_snapshot(
        p_account_id, p_snapshot_id, state_version, p_rows, p_group_columns,
        (select base_google_hash from public.asset_operation_sync_state where account_id = p_account_id),
        p_content_hash, 'pending', 'web_draft');
    update public.asset_operation_settings
    set column_order = p_column_order,
        settings_revision = settings_revision + case when column_order is distinct from p_column_order then 1 else 0 end,
        updated_at = case when column_order is distinct from p_column_order then now() else updated_at end
    where account_id = p_account_id
    returning * into settings_row;
    result_json := jsonb_build_object('ok', true, 'protocolVersion', 2, 'operationId', p_operation_id,
        'action', 'save-draft', 'outcome', 'succeeded', 'version', (rpc_result ->> 'version')::bigint,
        'settingsRevision', settings_row.settings_revision, 'snapshotId', p_snapshot_id,
        'rowCount', jsonb_array_length(p_rows), 'contentHash', p_content_hash);
    insert into public.asset_operation_sync_operations (
        operation_id, account_id, action, protocol_version, actor_kind, actor_id, request_hash,
        expected_version, expected_settings_revision, expected_pending_snapshot_id,
        input_json, status, result, completed_at)
    values (p_operation_id, p_account_id, 'save-draft', 2, 'admin', p_actor_id, p_request_hash,
        p_expected_version, p_expected_settings_revision, null,
        jsonb_build_object('snapshotId', p_snapshot_id), 'succeeded', result_json, now());
    return result_json;
exception when unique_violation then
    raise exception using errcode = '55P03', message = 'sync_in_progress';
end;
$$;

create or replace function public.asset_operation_commit_import_v2(
    p_operation_id uuid,
    p_account_id uuid,
    p_snapshot_id uuid,
    p_rows jsonb,
    p_group_columns jsonb,
    p_column_order jsonb,
    p_data_hash text,
    p_structure_hash text,
    p_overwritten_drafts integer)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    operation public.asset_operation_sync_operations%rowtype;
    state_version bigint;
    settings_row public.asset_operation_settings%rowtype;
    actual_pending uuid;
    result_json jsonb;
    rpc_result jsonb;
begin
    select * into operation from public.asset_operation_sync_operations
    where operation_id = p_operation_id and account_id = p_account_id for update;
    if not found then raise exception using errcode = 'P0002', message = 'operation_not_found'; end if;
    if operation.status = 'succeeded' then return operation.result; end if;
    if operation.action <> 'import' or operation.status <> 'running' then
        raise exception using errcode = '55000', message = 'invalid_operation_transition';
    end if;
    perform public.assert_asset_operation_account_v2(p_account_id);

    select version into state_version from public.asset_operation_sync_state
    where account_id = p_account_id for update;
    select * into settings_row from public.asset_operation_settings
    where account_id = p_account_id for update;
    if state_version <> operation.expected_version then
        raise exception using errcode = '40001', message = 'data_version_conflict';
    end if;
    if settings_row.settings_revision <> operation.expected_settings_revision then
        raise exception using errcode = '40001', message = 'settings_conflict';
    end if;
    select id into actual_pending from public.asset_operation_snapshots
    where account_id = p_account_id and status = 'pending'
    order by created_at desc, id desc limit 1;
    if actual_pending is distinct from operation.expected_pending_snapshot_id then
        raise exception using errcode = '40001', message = 'data_version_conflict';
    end if;
    if actual_pending is not null then
        if operation.actor_kind <> 'admin'
           or coalesce((operation.input_json ->> 'overwriteDraft')::boolean, false) is false then
            raise exception using errcode = 'P0001', message = 'draft_pending';
        end if;
        update public.asset_operation_snapshots
        set status = 'superseded', completed_at = now(), error_code = 'overwritten_by_google_import'
        where account_id = p_account_id and status = 'pending';
    end if;
    perform public.assert_asset_operation_group_columns_v2(p_group_columns);

    rpc_result := public.replace_asset_operation_snapshot(
        p_account_id, p_snapshot_id, state_version, p_rows, p_group_columns,
        p_data_hash, p_data_hash, 'active', 'google_import');
    perform public.assert_asset_operation_column_order_v2(p_account_id, p_column_order);
    update public.asset_operation_settings
    set column_order = p_column_order,
        settings_revision = settings_revision + case when column_order is distinct from p_column_order then 1 else 0 end,
        updated_at = case when column_order is distinct from p_column_order then now() else updated_at end
    where account_id = p_account_id
    returning * into settings_row;
    update public.asset_operation_sync_state
    set base_google_structure_hash = p_structure_hash,
        last_google_structure_hash = p_structure_hash,
        google_fingerprint_version = 1,
        status = 'clean',
        last_error_code = null,
        last_error_message = null,
        updated_at = now()
    where account_id = p_account_id;

    result_json := jsonb_build_object('ok', true, 'protocolVersion', 2, 'operationId', p_operation_id,
        'action', 'import', 'outcome', 'succeeded', 'version', (rpc_result ->> 'version')::bigint,
        'settingsRevision', settings_row.settings_revision, 'snapshotId', p_snapshot_id,
        'rowCount', jsonb_array_length(p_rows), 'hash', p_data_hash,
        'structureHash', p_structure_hash, 'overwrittenDrafts', p_overwritten_drafts);
    update public.asset_operation_sync_operations
    set status = 'succeeded', stage = 'finalized', google_write_state = 'not_started',
        result = result_json, error_code = null, error_message = null,
        updated_at = now(), completed_at = now()
    where operation_id = p_operation_id;
    return result_json;
end;
$$;

create or replace function public.asset_operation_commit_export_v2(
    p_operation_id uuid,
    p_account_id uuid,
    p_snapshot_id uuid,
    p_rows jsonb,
    p_group_columns jsonb,
    p_column_order jsonb,
    p_data_hash text,
    p_structure_hash text,
    p_result jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    operation public.asset_operation_sync_operations%rowtype;
    state_version bigint;
    settings_row public.asset_operation_settings%rowtype;
    actual_pending uuid;
    pending_snapshot public.asset_operation_snapshots%rowtype;
    result_json jsonb;
    rpc_result jsonb;
begin
    select * into operation from public.asset_operation_sync_operations
    where operation_id = p_operation_id and account_id = p_account_id for update;
    if not found then raise exception using errcode = 'P0002', message = 'operation_not_found'; end if;
    if operation.status = 'succeeded' then return operation.result; end if;
    if operation.action <> 'export' or operation.status not in ('running', 'reconcile_required')
       or operation.google_write_state not in ('unknown', 'confirmed') then
        raise exception using errcode = '55000', message = 'invalid_operation_transition';
    end if;
    perform public.assert_asset_operation_account_v2(p_account_id);

    select version into state_version from public.asset_operation_sync_state
    where account_id = p_account_id for update;
    select * into settings_row from public.asset_operation_settings
    where account_id = p_account_id for update;
    if state_version <> operation.expected_version then
        raise exception using errcode = '40001', message = 'data_version_conflict';
    end if;
    if settings_row.settings_revision <> operation.expected_settings_revision then
        raise exception using errcode = '40001', message = 'settings_conflict';
    end if;
    select id into actual_pending from public.asset_operation_snapshots
    where account_id = p_account_id and status = 'pending'
    order by created_at desc, id desc limit 1;
    if actual_pending is distinct from operation.expected_pending_snapshot_id
       or p_snapshot_id is distinct from operation.expected_pending_snapshot_id then
        raise exception using errcode = '40001', message = 'data_version_conflict';
    end if;
    perform public.assert_asset_operation_column_order_v2(p_account_id, p_column_order);
    perform public.assert_asset_operation_group_columns_v2(p_group_columns);

    if p_snapshot_id is not null then
        select * into pending_snapshot from public.asset_operation_snapshots
        where id = p_snapshot_id and account_id = p_account_id and status = 'pending' for update;
        if not found or pending_snapshot.content_hash <> p_data_hash
           or pending_snapshot.payload is distinct from p_rows then
            raise exception using errcode = '40001', message = 'data_version_conflict';
        end if;
        update public.asset_operation_snapshots
        set status = 'superseded', completed_at = now(), error_code = 'replaced_by_google_export'
        where account_id = p_account_id and status = 'pending' and id <> p_snapshot_id;
        rpc_result := public.replace_asset_operation_snapshot(
            p_account_id, p_snapshot_id, state_version, p_rows, p_group_columns,
            p_data_hash, p_data_hash, 'active', 'google_export');
    else
        delete from public.asset_operation_group_columns where account_id = p_account_id;
        insert into public.asset_operation_group_columns
            (id, account_id, label, metadata_key, sheet_column_index, display_order, active, legacy_key)
        select group_data.id, p_account_id, group_data.label, group_data.metadata_key,
               group_data.sheet_column_index, group_data.display_order,
               coalesce(group_data.active, true), group_data.legacy_key
        from jsonb_to_recordset(p_group_columns) as group_data(
            id uuid, label text, metadata_key text, sheet_column_index integer,
            display_order integer, active boolean, legacy_key text);
        update public.asset_operation_sync_state
        set base_google_hash = p_data_hash, last_google_hash = p_data_hash,
            status = 'clean', last_exported_at = now(), updated_at = now()
        where account_id = p_account_id;
        rpc_result := jsonb_build_object('version', state_version, 'rowCount', 0);
    end if;

    update public.asset_operation_settings
    set column_order = p_column_order,
        settings_revision = settings_revision + case when column_order is distinct from p_column_order then 1 else 0 end,
        updated_at = case when column_order is distinct from p_column_order then now() else updated_at end
    where account_id = p_account_id
    returning * into settings_row;
    update public.asset_operation_sync_state
    set base_google_hash = p_data_hash,
        last_google_hash = p_data_hash,
        base_google_structure_hash = p_structure_hash,
        last_google_structure_hash = p_structure_hash,
        google_fingerprint_version = 1,
        status = 'clean',
        last_exported_at = now(),
        last_error_code = null,
        last_error_message = null,
        updated_at = now()
    where account_id = p_account_id;

    result_json := coalesce(p_result, '{}'::jsonb) || jsonb_build_object(
        'ok', true, 'protocolVersion', 2, 'operationId', p_operation_id,
        'action', 'export', 'outcome', 'succeeded',
        'version', (rpc_result ->> 'version')::bigint,
        'settingsRevision', settings_row.settings_revision,
        'snapshotId', p_snapshot_id,
        'rowCount', case when p_snapshot_id is null then coalesce((p_result ->> 'rowCount')::integer, 0)
                         else jsonb_array_length(p_rows) end,
        'dataHash', p_data_hash, 'structureHash', p_structure_hash);
    update public.asset_operation_sync_operations
    set status = 'succeeded', stage = 'finalized', google_write_state = 'confirmed',
        result = result_json, error_code = null, error_message = null,
        updated_at = now(), completed_at = now()
    where operation_id = p_operation_id;
    return result_json;
end;
$$;

create or replace function public.asset_operation_get_operation_v2(
    p_account_id uuid,
    p_operation_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
    select jsonb_build_object(
        'operationId', operation.operation_id,
        'action', operation.action,
        'status', operation.status,
        'stage', operation.stage,
        'googleWriteState', operation.google_write_state,
        'expectedVersion', operation.expected_version,
        'expectedSettingsRevision', operation.expected_settings_revision,
        'expectedPendingSnapshotId', operation.expected_pending_snapshot_id,
        'expectedAfterDataHash', operation.expected_after_data_hash,
        'expectedAfterStructureHash', operation.expected_after_structure_hash,
        'input', operation.input_json,
        'finalize', operation.finalize_json,
        'result', operation.result,
        'errorCode', operation.error_code,
        'errorMessage', operation.error_message
    )
    from public.asset_operation_sync_operations operation
    where operation.account_id = p_account_id and operation.operation_id = p_operation_id
$$;

create or replace function public.asset_operation_complete_maintenance_v2(
    p_operation_id uuid,
    p_account_id uuid,
    p_result jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    operation public.asset_operation_sync_operations%rowtype;
    result_json jsonb;
begin
    select * into operation from public.asset_operation_sync_operations
    where operation_id = p_operation_id and account_id = p_account_id for update;
    if not found then raise exception using errcode = 'P0002', message = 'operation_not_found'; end if;
    if operation.status = 'succeeded' then return operation.result; end if;
    if operation.action not in ('repair-stale-tail', 'bootstrap-metadata', 'repair-metadata')
       or operation.status not in ('running', 'reconcile_required') then
        raise exception using errcode = '55000', message = 'invalid_operation_transition';
    end if;
    if operation.google_write_state not in ('confirmed', 'not_started') then
        raise exception using errcode = '55000', message = 'reconcile_required';
    end if;
    perform public.assert_asset_operation_account_v2(p_account_id);
    result_json := coalesce(p_result, '{}'::jsonb) || jsonb_build_object(
        'ok', true,
        'protocolVersion', 2,
        'operationId', p_operation_id,
        'action', operation.action,
        'outcome', 'succeeded'
    );
    update public.asset_operation_sync_operations
    set status = 'succeeded', stage = 'finalized', google_write_state = 'confirmed',
        result = result_json, error_code = null, error_message = null,
        updated_at = now(), completed_at = now()
    where operation_id = p_operation_id;
    return result_json;
end;
$$;

revoke all on function public.assert_asset_operation_account_v2(uuid) from public, anon, authenticated;
revoke all on function public.assert_asset_operation_column_order_v2(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.assert_asset_operation_group_columns_v2(jsonb) from public, anon, authenticated;
revoke all on function public.asset_operation_read_state_v2(uuid) from public, anon, authenticated;
revoke all on function public.asset_operation_begin_v2(uuid, uuid, text, integer, text, uuid, text, bigint, bigint, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.asset_operation_set_stage_v2(uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.asset_operation_fail_v2(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.asset_operation_save_column_order_v2(uuid, uuid, uuid, text, bigint, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.asset_operation_save_draft_v2(uuid, uuid, uuid, text, bigint, bigint, uuid, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.asset_operation_commit_import_v2(uuid, uuid, uuid, jsonb, jsonb, jsonb, text, text, integer) from public, anon, authenticated;
revoke all on function public.asset_operation_commit_export_v2(uuid, uuid, uuid, jsonb, jsonb, jsonb, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.asset_operation_get_operation_v2(uuid, uuid) from public, anon, authenticated;
revoke all on function public.asset_operation_complete_maintenance_v2(uuid, uuid, jsonb) from public, anon, authenticated;

grant execute on function public.assert_asset_operation_account_v2(uuid) to service_role;
grant execute on function public.assert_asset_operation_column_order_v2(uuid, jsonb) to service_role;
grant execute on function public.assert_asset_operation_group_columns_v2(jsonb) to service_role;
grant execute on function public.asset_operation_read_state_v2(uuid) to service_role;
grant execute on function public.asset_operation_begin_v2(uuid, uuid, text, integer, text, uuid, text, bigint, bigint, uuid, jsonb) to service_role;
grant execute on function public.asset_operation_set_stage_v2(uuid, uuid, text, text, text, text, jsonb) to service_role;
grant execute on function public.asset_operation_fail_v2(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.asset_operation_save_column_order_v2(uuid, uuid, uuid, text, bigint, bigint, jsonb) to service_role;
grant execute on function public.asset_operation_save_draft_v2(uuid, uuid, uuid, text, bigint, bigint, uuid, jsonb, jsonb, jsonb, text) to service_role;
grant execute on function public.asset_operation_commit_import_v2(uuid, uuid, uuid, jsonb, jsonb, jsonb, text, text, integer) to service_role;
grant execute on function public.asset_operation_commit_export_v2(uuid, uuid, uuid, jsonb, jsonb, jsonb, text, text, jsonb) to service_role;
grant execute on function public.asset_operation_get_operation_v2(uuid, uuid) to service_role;
grant execute on function public.asset_operation_complete_maintenance_v2(uuid, uuid, jsonb) to service_role;

insert into public.schema_migrations (filename) values ('063_asset_operation_sync_reliability.sql')
on conflict (filename) do nothing;
