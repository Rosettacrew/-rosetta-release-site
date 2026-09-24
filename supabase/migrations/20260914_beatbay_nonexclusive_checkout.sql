-- Smallest launchable BeatBay revenue contract: one-time non-exclusive licenses.
-- Exclusive/ownership checkout remains intentionally out of scope.

alter table public.beatbay_beats
  add column if not exists nonexclusive_terms_version text,
  add column if not exists nonexclusive_terms_url text;

alter table public.beatbay_beats
  drop constraint if exists beatbay_beats_nonexclusive_terms_url_https;
alter table public.beatbay_beats
  add constraint beatbay_beats_nonexclusive_terms_url_https
  check (
    nonexclusive_terms_url is null
    or nonexclusive_terms_url ~ '^https://[^[:space:]]+$'
  );

create table if not exists public.beatbay_checkout_attempts (
  request_id uuid primary key,
  beat_id uuid not null references public.beatbay_beats(id) on delete restrict,
  license_type text not null check (license_type = 'nonexclusive'),
  beat_code text not null,
  beat_title text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  terms_version text not null,
  terms_url text not null check (terms_url ~ '^https://[^[:space:]]+$'),
  delivery_bucket text not null,
  delivery_path text not null,
  delivery_filename text not null,
  stripe_checkout_session_id text unique,
  checkout_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.beatbay_orders (
  id uuid primary key default gen_random_uuid(),
  checkout_request_id uuid not null unique references public.beatbay_checkout_attempts(request_id) on delete restrict,
  beat_id uuid not null references public.beatbay_beats(id) on delete restrict,
  license_type text not null check (license_type = 'nonexclusive'),
  stripe_checkout_session_id text not null unique,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  customer_email text not null,
  amount_total_cents integer not null check (amount_total_cents >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  payment_status text not null check (payment_status in ('processing','paid','failed','refunded','disputed')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.beatbay_licenses (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.beatbay_orders(id) on delete restrict,
  beat_id uuid not null references public.beatbay_beats(id) on delete restrict,
  license_number text not null unique,
  license_type text not null check (license_type = 'nonexclusive'),
  customer_email text not null,
  terms_version text not null,
  terms_url text not null check (terms_url ~ '^https://[^[:space:]]+$'),
  delivery_bucket text not null,
  delivery_path text not null,
  delivery_filename text not null,
  status text not null default 'active' check (status in ('active','revoked','refunded','disputed')),
  issued_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.beatbay_download_tokens (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.beatbay_licenses(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  max_downloads integer not null default 5 check (max_downloads between 1 and 20),
  download_count integer not null default 0 check (download_count >= 0),
  email_sent_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.beatbay_delivery_log (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.beatbay_licenses(id) on delete cascade,
  delivery_type text not null check (delivery_type in ('email','download')),
  status text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.beatbay_stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  processing_status text not null check (processing_status in ('received','processed','ignored','failed')),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

alter table public.beatbay_checkout_attempts enable row level security;
alter table public.beatbay_orders enable row level security;
alter table public.beatbay_licenses enable row level security;
alter table public.beatbay_download_tokens enable row level security;
alter table public.beatbay_delivery_log enable row level security;
alter table public.beatbay_stripe_webhook_events enable row level security;

revoke all on table public.beatbay_checkout_attempts, public.beatbay_orders,
  public.beatbay_licenses, public.beatbay_download_tokens,
  public.beatbay_delivery_log, public.beatbay_stripe_webhook_events
  from public, anon, authenticated;
grant select, insert, update, delete on table public.beatbay_checkout_attempts,
  public.beatbay_orders, public.beatbay_licenses, public.beatbay_download_tokens,
  public.beatbay_delivery_log, public.beatbay_stripe_webhook_events
  to service_role;

create or replace function public.consume_beatbay_download_token(p_token_hash text)
returns table (
  token_id uuid,
  license_id uuid,
  download_count integer,
  max_downloads integer
)
language sql
security definer
set search_path = ''
as $$
  update public.beatbay_download_tokens as token
  set download_count = token.download_count + 1
  where token.token_hash = p_token_hash
    and token.revoked_at is null
    and token.expires_at > now()
    and token.download_count < token.max_downloads
  returning token.id, token.license_id, token.download_count, token.max_downloads;
$$;

revoke all on function public.consume_beatbay_download_token(text) from public, anon, authenticated;
grant execute on function public.consume_beatbay_download_token(text) to service_role;

comment on table public.beatbay_checkout_attempts is
  'Server-authoritative snapshot used to validate Stripe BeatBay checkout fulfillment.';
comment on table public.beatbay_licenses is
  'Issued BeatBay licenses. Phase 1 permits non-exclusive licenses only.';
