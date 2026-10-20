-- 私人筆記附件使用獨立的私有 bucket；不沿用公開 note-images。
alter table public.private_notes
    add column attachments jsonb not null default '[]'::jsonb,
    add constraint private_notes_attachments_limit
        check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 6);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'private-note-images',
    'private-note-images',
    false,
    5242880,
    array['image/jpeg', 'image/png', 'image/gif', 'image/webp']::text[]
)
on conflict (id) do update set
    name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "frank private note images read" on storage.objects;
drop policy if exists "frank private note images upload" on storage.objects;
drop policy if exists "frank private note images delete" on storage.objects;

create policy "frank private note images read"
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'private-note-images'
        and (storage.foldername(name))[1] = 'private'
        and ((select auth.jwt()) ->> 'email') = 'admin@investment.local'
    );

create policy "frank private note images upload"
    on storage.objects
    for insert
    to authenticated
    with check (
        bucket_id = 'private-note-images'
        and (storage.foldername(name))[1] = 'private'
        and ((select auth.jwt()) ->> 'email') = 'admin@investment.local'
    );

create policy "frank private note images delete"
    on storage.objects
    for delete
    to authenticated
    using (
        bucket_id = 'private-note-images'
        and (storage.foldername(name))[1] = 'private'
        and ((select auth.jwt()) ->> 'email') = 'admin@investment.local'
    );

insert into public.schema_migrations (filename) values ('067_private_note_images.sql')
on conflict (filename) do nothing;
