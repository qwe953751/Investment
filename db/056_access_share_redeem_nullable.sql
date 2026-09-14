-- 2026-09-14：筆記 #59 —— access_share_redeem 補上 null-safe 條件。
--
-- db/050 把 access_share_links.expires_at／max_uses 改成 nullable（null = 永久／不限次數），
-- 但新的 WHERE 條件只寫成註解，函式本體從未更新。結果：
--   expires_at is null → `expires_at > now()` 為 NULL → 不成立
--   max_uses   is null → `use_count < max_uses` 為 NULL → 不成立
-- 永久或不限次數的連結因此永遠兌換不了，回 410 invite_expired_or_used。
--
-- 同時補 db/050 沒生效的那段：fortune@investment.local 的 admin access_role
-- （沒有它，「財神」帳號按分享連結會被 handleCreate 擋成 403）。

create or replace function public.access_share_redeem(p_token_hash text)
returns table(id uuid, role text, target_email text, expires_at timestamptz)
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
    update public.access_share_links
    set use_count = use_count + 1,
        last_used_at = now()
    where token_hash = p_token_hash
      and revoked_at is null
      and (expires_at is null or expires_at > now())
      and (max_uses is null or use_count < max_uses)
    returning id, role, target_email, expires_at;
$$;

revoke all on function public.access_share_redeem(text) from public, anon, authenticated;
grant execute on function public.access_share_redeem(text) to service_role;

-- 財神也要能建立分享連結。
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('access_role', 'admin')
where lower(email) = 'fortune@investment.local';

insert into schema_migrations (filename) values ('056_access_share_redeem_nullable.sql')
on conflict (filename) do nothing;
