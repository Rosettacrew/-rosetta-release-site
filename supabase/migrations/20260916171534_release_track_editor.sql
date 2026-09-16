-- Owner API uses service_role; no browser role may invoke this operation.
create or replace function public.save_release_track_order(p_product_id uuid, p_tracks jsonb, p_expected jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare current_tracks jsonb; track_count integer; offset_number bigint;
begin
  -- Serialize against inserts and legacy uploads as well as other reorder requests.
  lock table public.release_tracks in share row exclusive mode;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'track_number', track_number) order by id), '[]'::jsonb)
    into current_tracks from public.release_tracks where product_id = p_product_id;
  if current_tracks <> (select coalesce(jsonb_agg(value order by value->>'id'), '[]'::jsonb) from jsonb_array_elements(p_expected)) then
    raise exception 'Tracks changed in another session. Reload tracks before saving.';
  end if;
  track_count := jsonb_array_length(current_tracks);
  if jsonb_typeof(p_tracks) <> 'array' or jsonb_array_length(p_tracks) <> track_count
    or (select count(distinct value->>'id') from jsonb_array_elements(p_tracks)) <> track_count
    or exists (select 1 from jsonb_array_elements(p_tracks) x where nullif(btrim(x->>'title'), '') is null
      or not exists (select 1 from public.release_tracks t where t.product_id = p_product_id and t.id::text = x->>'id')) then
    raise exception 'Provide every track exactly once with a title.';
  end if;
  select coalesce(max(track_number), 0)::bigint + track_count + 1 into offset_number from public.release_tracks where product_id = p_product_id;
  if offset_number + track_count > 2147483647 then raise exception 'Track numbers exceed supported range.'; end if;
  -- Move to unused positive positions before applying the unique final positions.
  update public.release_tracks t set track_number = (offset_number + x.ordinality)::integer
    from jsonb_array_elements(p_tracks) with ordinality x(value, ordinality)
    where t.product_id = p_product_id and t.id::text = x.value->>'id';
  update public.release_tracks t set track_number = x.ordinality::integer, title = btrim(x.value->>'title')
    from jsonb_array_elements(p_tracks) with ordinality x(value, ordinality)
    where t.product_id = p_product_id and t.id::text = x.value->>'id';
end;
$$;
revoke all on function public.save_release_track_order(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_release_track_order(uuid, jsonb, jsonb) to service_role;
