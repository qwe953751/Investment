-- 私人筆記獨立於公開 anon 模型的 notes 表。
-- 只允許 Frank 的固定最高權限 Auth 身分存取；其他管理員與 anon 均無權讀寫。

create table if not exists public.private_notes (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
    title       text not null check (char_length(btrim(title)) between 1 and 120),
    content     text not null default '',
    updated_at  timestamptz not null default now()
);

create index if not exists private_notes_by_owner_updated
    on public.private_notes (user_id, updated_at desc);

alter table public.private_notes enable row level security;

revoke all privileges on table public.private_notes from public, anon, authenticated;
grant select, insert, update, delete on table public.private_notes to authenticated;

drop policy if exists "frank_private_notes_only" on public.private_notes;
create policy "frank_private_notes_only"
on public.private_notes
for all
to authenticated
using (
    (select auth.uid()) = user_id
    and (select auth.jwt() ->> 'email') = 'admin@investment.local'
)
with check (
    (select auth.uid()) = user_id
    and (select auth.jwt() ->> 'email') = 'admin@investment.local'
);

insert into public.schema_migrations (filename) values ('065_private_notes.sql')
on conflict (filename) do nothing;
