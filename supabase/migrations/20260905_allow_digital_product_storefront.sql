-- Allow digital_product on the storefront. Existing live rows (Come Here / EP)
-- are not updated. Only widen checks that already enumerate product types
-- but omit digital_product.

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
    execute $c$
      comment on constraint release_products_product_type_check on public.release_products is
        'Release Station product types, including digital_product so draft sandbox items can be published.'
    $c$;
  end if;
end
$$;
