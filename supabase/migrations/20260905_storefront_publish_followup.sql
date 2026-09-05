-- Follow-up after 20260905_allow_digital_product_storefront.sql.
-- Sandbox Test publish can still fail if:
--   1) stripe_payment_link_id is uuid (Stripe ids look like plink_xxx)
--   2) a leftover CHECK still omits digital_product when storefront_enabled is true
-- Existing live rows (Come Here / EP) are not updated.

do $$
declare
  col_type text;
begin
  select t.typname
    into col_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  where n.nspname = 'public'
    and c.relname = 'release_products'
    and a.attname = 'stripe_payment_link_id'
    and not a.attisdropped
    and a.attnum > 0;

  if col_type is not null and col_type not in ('text', 'varchar', 'bpchar') then
    execute $c$
      alter table public.release_products
        alter column stripe_payment_link_id type text
        using stripe_payment_link_id::text
    $c$;
  end if;

  if col_type is not null then
    execute $c$
      comment on column public.release_products.stripe_payment_link_id is
        'Stripe Payment Link id (plink_...). Must be text; uuid cannot store Stripe ids.'
    $c$;
  end if;
end
$$;

do $$
declare
  rec record;
  allowed text;
begin
  select string_agg(quote_literal(t), ', ' order by t)
    into allowed
  from (
    select unnest(array['single', 'ep', 'album', 'beat', 'digital_product']) as t
    union
    select distinct product_type
    from public.release_products
    where product_type is not null
  ) types;

  for rec in
    select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'release_products'
      and c.contype = 'c'
  loop
    if rec.def ~* 'product_type'
      and rec.def ~* 'single'
      and rec.def !~* 'digital_product'
    then
      execute format('alter table public.release_products drop constraint %I', rec.conname);
    end if;
  end loop;

  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'release_products'
      and c.conname = 'release_products_product_type_check'
  ) then
    execute format(
      'alter table public.release_products add constraint release_products_product_type_check check (product_type is null or product_type in (%s))',
      allowed
    );
  end if;
end
$$;
