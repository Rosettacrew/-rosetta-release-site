-- The current release date, paid order, and real delivery package gate access.
create or replace function public.unlock_due_release_entitlements()
returns void language sql security invoker set search_path = public as $$
  update public.release_entitlements e
  set status = 'available', available_at = p.release_at, updated_at = now()
  from public.release_products p, public.release_orders o
  where e.product_id = p.id and e.order_id = o.id and o.product_id = p.id
    and e.status = 'locked' and o.payment_status = 'paid'
    and p.release_at <= now() and p.status in ('presale','live')
    and exists(select 1 from storage.objects s where s.bucket_id = p.storage_bucket and s.name = p.storage_object_path);

  update public.release_products p set status = 'live', updated_at = now()
  where p.status = 'presale' and p.release_at <= now()
    and exists(select 1 from storage.objects s where s.bucket_id = p.storage_bucket and s.name = p.storage_object_path);
$$;
revoke execute on function public.unlock_due_release_entitlements() from public, anon, authenticated;
grant execute on function public.unlock_due_release_entitlements() to service_role;

-- Repair stale preorder times without changing the scheduled product release.
update public.release_entitlements e set available_at = p.release_at, updated_at = now()
from public.release_products p
where e.product_id = p.id and e.status = 'locked' and e.available_at is distinct from p.release_at;
