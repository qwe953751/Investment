-- 固定每筆原幣金流的參考匯率，避免目前匯率改寫歷史投入。
-- 沿用專案 db/NNN migration 與既有資產表 RLS；不增加角色權限。
begin;

alter table public.asset_cash_flows
    add column if not exists currency text,
    add column if not exists fx_rate numeric,
    add column if not exists fx_date date,
    add column if not exists fx_source text,
    add column if not exists fx_captured_at timestamptz,
    add column if not exists fx_history jsonb not null default '[]'::jsonb;

-- Generated from AssetPerformanceFormulas.ExchangeSql; C# 測試核對此表示式。
alter table public.asset_cash_flows
    add column if not exists amount_twd numeric generated always as (round((amount*fx_rate), 2)) stored;

create or replace function public.asset_capture_cash_flow_fx()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
    account_market text;
    reference record;
    changed boolean := false;
begin
    if tg_op = 'UPDATE' then
        changed := row(new.account_id,new.flow_date,new.direction,new.amount)
            is distinct from row(old.account_id,old.flow_date,old.direction,old.amount);
        new.fx_history := old.fx_history;
        if not changed and old.fx_rate is not null then
            new.currency := old.currency;
            new.fx_rate := old.fx_rate;
            new.fx_date := old.fx_date;
            new.fx_source := old.fx_source;
            new.fx_captured_at := old.fx_captured_at;
            return new;
        end if;
        if changed then
            new.fx_history := old.fx_history || jsonb_build_array(jsonb_build_object(
                'account_id',old.account_id,'flow_date',old.flow_date,'direction',old.direction,
                'amount',old.amount,'currency',old.currency,'fx_rate',old.fx_rate,'fx_date',old.fx_date,
                'fx_source',old.fx_source,'amount_twd',old.amount_twd,'captured_at',old.fx_captured_at,
                'replaced_at',now()));
        end if;
    else
        new.fx_history := '[]'::jsonb;
    end if;

    if tg_op = 'INSERT' or changed or new.currency is null then
        select market into account_market from public.asset_accounts where id=new.account_id;
        new.currency := case when account_market='美股' then 'USD' else 'TWD' end;
    else
        new.currency := old.currency;
    end if;
    new.fx_rate := null; new.fx_date := null; new.fx_source := null; new.fx_captured_at := null;
    if new.currency='TWD' then
        new.fx_rate := 1; new.fx_date := new.flow_date; new.fx_source := 'TWD'; new.fx_captured_at := now();
    elsif new.flow_date <= (now() at time zone 'Asia/Taipei')::date then
        select rate_date,rate,source into reference from public.exchange_rates
        where base_currency='USD' and quote_currency='TWD' and rate_date<=new.flow_date and rate>0
        order by rate_date desc limit 1;
        if found then
            new.fx_rate := reference.rate; new.fx_date := reference.rate_date;
            new.fx_source := reference.source; new.fx_captured_at := now();
        end if;
    end if;
    return new;
end;
$$;
revoke all on function public.asset_capture_cash_flow_fx() from public;

drop trigger if exists asset_capture_cash_flow_fx on public.asset_cash_flows;
create trigger asset_capture_cash_flow_fx before insert or update on public.asset_cash_flows
for each row execute function public.asset_capture_cash_flow_fx();

-- 已完成的估值不更新；缺值才允許在官方歷史匯率補齊後計算一次。
create or replace function public.asset_resolve_missing_cash_flow_fx()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
    if new.base_currency='USD' and new.quote_currency='TWD' then
        update public.asset_cash_flows set fx_rate=fx_rate
        where currency='USD' and fx_rate is null and flow_date>=new.rate_date
            and flow_date<=(now() at time zone 'Asia/Taipei')::date;
    end if;
    return new;
end;
$$;
revoke all on function public.asset_resolve_missing_cash_flow_fx() from public;
drop trigger if exists asset_resolve_missing_cash_flow_fx on public.exchange_rates;
create trigger asset_resolve_missing_cash_flow_fx after insert or update on public.exchange_rates
for each row execute function public.asset_resolve_missing_cash_flow_fx();

update public.asset_cash_flows set fx_rate=fx_rate where fx_rate is null;
alter table public.asset_cash_flows alter column currency set not null;
alter table public.asset_cash_flows add constraint asset_cash_flow_fx_currency check(currency in ('USD','TWD'));
alter table public.asset_cash_flows add constraint asset_cash_flow_fx_date check(fx_date is null or fx_date<=flow_date);
alter table public.asset_cash_flows add constraint asset_cash_flow_fx_positive check(fx_rate is null or fx_rate>0);

insert into public.schema_migrations(filename) values ('075_asset_cash_flow_fx_snapshots.sql') on conflict do nothing;
notify pgrst, 'reload schema';
commit;
