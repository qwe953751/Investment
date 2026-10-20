-- 將資料表權限限制為 authenticated；明確撤除新表預設授予的工作階段與服務角色權限。
revoke all privileges on table public.private_notes
    from public, anon, authenticated, invest_writer, service_role;
grant select, insert, update, delete on table public.private_notes to authenticated;

-- 只允許固定 Frank 帳號且資料列 owner 相符；auth.jwt() 以 init-plan 方式計算。
drop policy if exists "frank_private_notes_only" on public.private_notes;
create policy "frank_private_notes_only"
    on public.private_notes
    for all
    to authenticated
    using (
        (select auth.uid()) = user_id
        and ((select auth.jwt()) ->> 'email') = 'admin@investment.local'
    )
    with check (
        (select auth.uid()) = user_id
        and ((select auth.jwt()) ->> 'email') = 'admin@investment.local'
    );

insert into public.schema_migrations (filename) values ('066_private_notes_access_hardening.sql')
on conflict (filename) do nothing;
