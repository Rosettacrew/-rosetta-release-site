-- LOCAL-ONLY assertions after applying the Issue #91 migration twice (idempotency) on the stub.
\set ON_ERROR_STOP on
do $$
declare
  v_mimes text[];
  v_used bigint; v_reserved bigint;
  v_user uuid := gen_random_uuid();
  v_beat uuid;
  v_sid uuid := gen_random_uuid();
  v_old uuid := gen_random_uuid();
  r record;
begin
  -- config row + defaults
  if (select count(*) from public.upload_limits) <> 1 then raise exception 'expected one config row'; end if;
  perform 1 from public.upload_limits where max_file_bytes = 943718400 and chunk_bytes = 16777216 and single_object_threshold = 47185920
    and session_ttl_seconds = 86400 and max_attempts = 5 and max_total_upload_bytes = 1006632960;
  if not found then raise exception 'defaults wrong'; end if;
  -- chunk_bytes < 50 MiB CHECK
  begin
    update public.upload_limits set chunk_bytes = 52428800;
    raise exception 'chunk CHECK missing';
  exception when check_violation then null; end;
  begin
    insert into public.upload_limits (id) values (2);
    raise exception 'single-row CHECK missing';
  exception when check_violation then null; end;
  begin
    update public.upload_limits set allowed = '{"exe": {"exe": "x"}}'::jsonb;
    raise exception 'allowed kinds CHECK missing';
  exception when check_violation then null; end;
  -- mime allowlist (idempotent, both added once)
  select allowed_mime_types into v_mimes from storage.buckets where id = 'release-private';
  if not (v_mimes @> array['video/mp4','application/json','audio/wav']) then raise exception 'mime not added: %', v_mimes; end if;
  if (select count(*) from unnest(v_mimes) m where m = 'video/mp4') <> 1 then raise exception 'duplicate mp4'; end if;
  if (select allowed_mime_types from storage.buckets where id = 'release-public') is not null then raise exception 'public bucket touched'; end if;
  -- grants: anon/authenticated have nothing, RLS on
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname in ('upload_limits','upload_sessions','upload_chunks','beatbay_beat_assets') loop
    if has_table_privilege('anon', 'public.' || r.relname, 'select') or has_table_privilege('authenticated', 'public.' || r.relname, 'select')
       or has_table_privilege('authenticated', 'public.' || r.relname, 'insert') then
      raise exception 'anon/authenticated can touch %', r.relname;
    end if;
    if not has_table_privilege('service_role', 'public.' || r.relname, 'select') then raise exception 'service_role missing on %', r.relname; end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || r.relname)::regclass) then raise exception 'RLS off on %', r.relname; end if;
  end loop;
  if has_function_privilege('anon', 'public.upload_storage_usage(text[])', 'execute') then raise exception 'anon can run usage'; end if;
  if has_function_privilege('authenticated', 'public.upload_sessions_expire()', 'execute') then raise exception 'authenticated can run expire'; end if;

  -- session guards + usage + expire
  insert into auth.users values (v_user);
  insert into public.beatbay_beats (status) values ('draft') returning id into v_beat;
  insert into storage.objects (bucket_id, name, metadata) values
    ('release-private', 'uploads/x/0.part', '{"size": 1000}'), ('release-public', 'a.png', '{"size": 24}');
  insert into public.upload_sessions (id, origin, beat_id, created_by, kind, filename, ext, declared_mime, total_bytes, chunk_bytes, chunk_count,
    hash_mode, head_sha256, storage_prefix, expires_at)
  values (v_sid, 'beatbay_manager', v_beat, v_user, 'full', 'a.wav', 'wav', 'audio/wav', 3000, 1024, 3, 'deferred', repeat('a', 64),
    'uploads/' || v_sid || '/', now() + interval '1 hour');
  insert into public.upload_chunks (session_id, idx, bytes, sha256, status) values
    (v_sid, 0, 1024, repeat('a', 64), 'verified'), (v_sid, 1, 1024, null, 'pending'), (v_sid, 2, 952, null, 'pending');
  begin
    insert into public.upload_chunks (session_id, idx, bytes, status) values (v_sid, 3, 10, 'verified');
    raise exception 'verified-without-hash CHECK missing';
  exception when check_violation then null; end;
  begin
    insert into public.upload_sessions (origin, beat_id, created_by, kind, filename, ext, declared_mime, total_bytes, chunk_bytes, chunk_count,
      hash_mode, head_sha256, storage_prefix, expires_at)
    values ('beatbay_manager', v_beat, v_user, 'full', 'b.wav', 'wav', 'audio/wav', 10, 5, 2, 'deferred', repeat('b', 64), 'beatbay/evil/', now());
    raise exception 'prefix guard missing';
  exception when check_violation then null; end;
  begin
    insert into public.upload_sessions (id, origin, beat_id, created_by, kind, filename, ext, declared_mime, total_bytes, chunk_bytes, chunk_count,
      hash_mode, head_sha256, storage_prefix, expires_at)
    values (v_old, 'beatbay_manager', v_beat, v_user, 'full', 'b.wav', 'wav', 'audio/wav', 10, 5, 3, 'deferred', repeat('b', 64), 'uploads/' || v_old || '/', now());
    raise exception 'chunk math CHECK missing';
  exception when check_violation then null; end;
  begin
    insert into public.upload_sessions (origin, beat_id, created_by, kind, filename, ext, declared_mime, total_bytes, chunk_bytes, chunk_count,
      hash_mode, head_sha256, storage_prefix, expires_at, id)
    values ('beatbay_manager', v_beat, v_user, 'full', 'a.wav', 'wav', 'audio/wav', 3000, 1024, 3, 'deferred', repeat('a', 64), 'uploads/' || v_old || '/', now(), v_old);
    raise exception 'resume unique index missing';
  exception when unique_violation then null; end;

  select used_bytes, reserved_bytes into v_used, v_reserved from public.upload_storage_usage(null);
  if v_used <> 1024 or v_reserved <> 3000 - 1024 then raise exception 'usage wrong: % %', v_used, v_reserved; end if;
  select used_bytes into v_used from public.upload_storage_usage(array['release-private']);
  if v_used <> 1000 then raise exception 'bucket-scoped usage wrong: %', v_used; end if;

  -- expire: live past TTL -> expired; attached never touched; purged >7d rows deleted
  update public.upload_sessions set expires_at = now() - interval '1 minute' where id = v_sid;
  insert into public.upload_sessions (id, origin, beat_id, created_by, kind, filename, ext, declared_mime, total_bytes, chunk_bytes, chunk_count,
    hash_mode, head_sha256, storage_prefix, expires_at, status)
  values (v_old, 'beatbay_manager', v_beat, v_user, 'full', 'c.wav', 'wav', 'audio/wav', 10, 5, 2, 'deferred', repeat('c', 64), 'uploads/' || v_old || '/', now() - interval '9 days', 'attached');
  select * into r from public.upload_sessions_expire();
  if r.expired_count <> 1 then raise exception 'expire count %', r.expired_count; end if;
  if (select status from public.upload_sessions where id = v_old) <> 'attached' then raise exception 'attached touched'; end if;
  update public.upload_sessions set parts_purged_at = now() - interval '8 days' where id = v_sid;
  select * into r from public.upload_sessions_expire();
  if r.deleted_count <> 1 or exists (select 1 from public.upload_chunks where session_id = v_sid) then raise exception 'purged row not deleted'; end if;
  if (select count(*) from storage.objects) <> 2 then raise exception 'storage touched'; end if;
  raise notice 'issue91 local SQL assertions passed';
end $$;
