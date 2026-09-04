alter table public.release_products
  add column if not exists artist_type text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'release_products_artist_type_check'
      and conrelid = 'public.release_products'::regclass
  ) then
    alter table public.release_products
      add constraint release_products_artist_type_check
      check (artist_type is null or artist_type in ('actual', 'ai'));
  end if;
end
$$;

create table if not exists public.release_artist_contacts (
  release_product_id uuid primary key
    references public.release_products(id) on delete cascade,
  contact_name text,
  contact_email text,
  contact_phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint release_artist_contacts_has_detail check (
    contact_name is not null
    or contact_email is not null
    or contact_phone is not null
    or notes is not null
  )
);

alter table public.release_artist_contacts enable row level security;
revoke all on table public.release_artist_contacts from public, anon, authenticated;
grant select, insert, update, delete on table public.release_artist_contacts to service_role;

comment on table public.release_artist_contacts is
  'Private admin-only booking contacts. Public storefronts must route inquiries through Rosetta Crew.';
comment on column public.release_products.artist_type is
  'Release Station identity classification: actual, ai, or null for legacy/unclassified releases.';
