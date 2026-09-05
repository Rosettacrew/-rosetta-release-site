-- Partner Music Studio role + per-release assignment.
-- music_uploader may upload assets only for assigned products.
-- Finance, orders, analytics, delivery, Stripe, and publish remain owner-only.

alter table public.release_admin_users
  drop constraint if exists release_admin_users_role_check;

alter table public.release_admin_users
  add constraint release_admin_users_role_check
  check (role in ('owner', 'admin', 'staff', 'music_uploader'));

create table if not exists public.release_product_assignees (
  product_id uuid not null references public.release_products(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (product_id, user_id)
);

create index if not exists release_product_assignees_user_idx
  on public.release_product_assignees (user_id);

alter table public.release_product_assignees enable row level security;
revoke all on table public.release_product_assignees from public, anon, authenticated;
grant select, insert, update, delete on table public.release_product_assignees to service_role;

comment on table public.release_product_assignees is
  'Maps music_uploader accounts to the release products they may upload assets for. Enforced by studio-manager.';
