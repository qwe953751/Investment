-- Frank 台股操作的 Excel 樣式操作表。
--
-- 這張表刻意與 asset_holdings 分開：asset_holdings 是資產市值／成本的
-- canonical source，而這裡保存 Buy 份數、Stock 與族群勾選，不能把兩種
-- 不同語意的資料混在一起。Google Sheet 只作為唯讀參考，不由網站寫回。

create table if not exists asset_operation_rows (
    id           uuid primary key default gen_random_uuid(),
    account_id   uuid not null references asset_accounts (id) on delete cascade,
    buy          integer not null default 0 check (buy >= 0),
    stock        text not null default '',
    cpo          boolean not null default false,
    pcb          boolean not null default false,
    asic         boolean not null default false,
    cooling      boolean not null default false,
    passive      boolean not null default false,
    other        boolean not null default false,
    memory       boolean not null default false,
    abf          boolean not null default false,
    power        boolean not null default false,
    hinge        boolean not null default false,
    pmic         boolean not null default false,
    testing      boolean not null default false,
    leadframe    boolean not null default false,
    bbu          boolean not null default false,
    sort_order   integer not null default 0,
    updated_at   timestamptz not null default now()
);

create table if not exists asset_operation_settings (
    account_id   uuid primary key references asset_accounts (id) on delete cascade,
    column_order jsonb not null default '[]'::jsonb,
    updated_at   timestamptz not null default now()
);

create index if not exists asset_operation_rows_by_account
    on asset_operation_rows (account_id, sort_order, id);

create unique index if not exists asset_operation_rows_stock_by_account
    on asset_operation_rows (account_id, btrim(stock))
    where btrim(stock) <> '';

alter table asset_operation_rows enable row level security;
alter table asset_operation_settings enable row level security;

drop policy if exists "Frank operation rows admin" on asset_operation_rows;
drop policy if exists "Frank operation settings admin" on asset_operation_settings;

create policy "Frank operation rows admin"
    on asset_operation_rows
    for all
    to authenticated
    using (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and exists (
            select 1
            from asset_accounts account
            join asset_owners owner on owner.id = account.owner_id
            where account.id = asset_operation_rows.account_id
              and account.name = '台股操作'
              and account.market = '台股'
              and owner.name = 'Frank'
        )
    )
    with check (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and exists (
            select 1
            from asset_accounts account
            join asset_owners owner on owner.id = account.owner_id
            where account.id = asset_operation_rows.account_id
              and account.name = '台股操作'
              and account.market = '台股'
              and owner.name = 'Frank'
        )
    );

create policy "Frank operation settings admin"
    on asset_operation_settings
    for all
    to authenticated
    using (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and exists (
            select 1
            from asset_accounts account
            join asset_owners owner on owner.id = account.owner_id
            where account.id = asset_operation_settings.account_id
              and account.name = '台股操作'
              and account.market = '台股'
              and owner.name = 'Frank'
        )
    )
    with check (
        (select auth.jwt() -> 'app_metadata' ->> 'access_role') = 'admin'
        and exists (
            select 1
            from asset_accounts account
            join asset_owners owner on owner.id = account.owner_id
            where account.id = asset_operation_settings.account_id
              and account.name = '台股操作'
              and account.market = '台股'
              and owner.name = 'Frank'
        )
    );

revoke all on asset_operation_rows from anon;
revoke all on asset_operation_settings from anon;
grant select, insert, update, delete on asset_operation_rows to authenticated;
grant select, insert, update, delete on asset_operation_settings to authenticated;
grant select, insert, update, delete on asset_operation_rows to invest_writer;
grant select, insert, update, delete on asset_operation_settings to invest_writer;

insert into schema_migrations (filename) values ('051_asset_operation_sheet.sql')
on conflict (filename) do nothing;
