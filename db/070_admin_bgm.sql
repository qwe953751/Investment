-- BGM 音檔放在非公開 Storage；只有最高權限帳號可讀寫 metadata 與物件。
-- Threads／Instagram 網址只記錄來源，不由網站擷取或轉存社群影音。

create table if not exists public.admin_bgm (
    id                  smallint primary key default 1 check (id = 1),
    title               text not null default '夢的翅膀受了傷（DJ 阿智版）',
    audio_path          text,
    audio_name          text,
    audio_mime_type     text,
    audio_size_bytes    bigint,
    source_url          text,
    updated_at          timestamptz not null default now(),
    constraint admin_bgm_audio_path_format
        check (audio_path is null or audio_path ~ '^audio/[0-9a-f-]{36}\.(mp3|m4a|mp4|aac|wav|ogg|oga|webm)$'),
    constraint admin_bgm_audio_metadata_complete
        check (
            (audio_path is null and audio_name is null and audio_mime_type is null and audio_size_bytes is null)
            or
            (audio_path is not null and audio_name is not null and audio_mime_type is not null
                and audio_size_bytes between 1 and 20971520)
        ),
    constraint admin_bgm_audio_mime_type
        check (audio_mime_type is null or audio_mime_type in (
            'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/webm'
        )),
    constraint admin_bgm_source_url_http
        check (source_url is null or source_url ~* '^https?://')
);

alter table public.admin_bgm enable row level security;
revoke all privileges on table public.admin_bgm
    from public, anon, authenticated, invest_writer, service_role;
grant select, insert, update, delete on table public.admin_bgm to authenticated;

drop policy if exists "admin_bgm_admin_only" on public.admin_bgm;
create policy "admin_bgm_admin_only"
    on public.admin_bgm
    for all
    to authenticated
    using (
        ((select auth.jwt()) ->> 'email') in ('admin@investment.local', 'fortune@investment.local')
    )
    with check (
        ((select auth.jwt()) ->> 'email') in ('admin@investment.local', 'fortune@investment.local')
    );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'admin-bgm',
    'admin-bgm',
    false,
    20971520,
    array['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/webm']::text[]
)
on conflict (id) do update set
    name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "admin_bgm_admin_read" on storage.objects;
drop policy if exists "admin_bgm_admin_upload" on storage.objects;
drop policy if exists "admin_bgm_admin_update" on storage.objects;
drop policy if exists "admin_bgm_admin_delete" on storage.objects;

create policy "admin_bgm_admin_read"
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'admin-bgm'
        and (storage.foldername(name))[1] = 'audio'
        and ((select auth.jwt()) ->> 'email') in ('admin@investment.local', 'fortune@investment.local')
    );

create policy "admin_bgm_admin_upload"
    on storage.objects
    for insert
    to authenticated
    with check (
        bucket_id = 'admin-bgm'
        and (storage.foldername(name))[1] = 'audio'
        and ((select auth.jwt()) ->> 'email') in ('admin@investment.local', 'fortune@investment.local')
    );

create policy "admin_bgm_admin_update"
    on storage.objects
    for update
    to authenticated
    using (
        bucket_id = 'admin-bgm'
        and (storage.foldername(name))[1] = 'audio'
        and ((select auth.jwt()) ->> 'email') in ('admin@investment.local', 'fortune@investment.local')
    )
    with check (
        bucket_id = 'admin-bgm'
        and (storage.foldername(name))[1] = 'audio'
        and ((select auth.jwt()) ->> 'email') in ('admin@investment.local', 'fortune@investment.local')
    );

create policy "admin_bgm_admin_delete"
    on storage.objects
    for delete
    to authenticated
    using (
        bucket_id = 'admin-bgm'
        and (storage.foldername(name))[1] = 'audio'
        and ((select auth.jwt()) ->> 'email') in ('admin@investment.local', 'fortune@investment.local')
    );

insert into public.admin_bgm (id, title)
values (1, '夢的翅膀受了傷（DJ 阿智版）')
on conflict (id) do nothing;

insert into public.schema_migrations (filename) values ('070_admin_bgm.sql')
on conflict (filename) do nothing;
