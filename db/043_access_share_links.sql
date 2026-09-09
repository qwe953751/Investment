-- 權限分享連結：網址只帶一次性隨機碼，資料庫只保存 SHA-256 雜湊。
-- Edge Function 以 service_role 建立／兌換／撤銷；瀏覽器不能直接讀寫此表。

create table if not exists public.access_share_links (
    id uuid primary key default gen_random_uuid(),
    token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
    role text not null check (role in ('holdings', 'monitor')),
    target_email text not null,
    expires_at timestamptz not null,
    max_uses integer not null default 1 check (max_uses between 1 and 10),
    use_count integer not null default 0 check (use_count between 0 and max_uses),
    revoked_at timestamptz,
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    last_used_at timestamptz
);

create index if not exists ix_access_share_links_expiry
    on public.access_share_links (expires_at, revoked_at);

alter table public.access_share_links enable row level security;
revoke all on table public.access_share_links from public, anon, authenticated;
grant all on table public.access_share_links to service_role;

create or replace function public.access_share_redeem(p_token_hash text)
returns table (
    id uuid,
    role text,
    target_email text,
    expires_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
    update public.access_share_links
    set use_count = use_count + 1,
        last_used_at = now()
    where token_hash = p_token_hash
      and revoked_at is null
      and expires_at > now()
      and use_count < max_uses
    returning id, role, target_email, expires_at;
$$;

revoke all on function public.access_share_redeem(text) from public, anon, authenticated;
grant execute on function public.access_share_redeem(text) to service_role;

insert into schema_migrations (filename) values ('043_access_share_links.sql')
on conflict (filename) do nothing;
