-- 只供 restore-test.yml 的拋棄式容器。這不是正式 Auth 備份／migration。
-- 保留外鍵與 policy 的真實依賴；UUID 從加密備份取出，沒有登入憑證。
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
    $$ select (auth.jwt()->>'sub')::uuid $$;
