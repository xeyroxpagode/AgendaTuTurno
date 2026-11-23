-- =============================================================================
-- H06 · M2 · `clients.order_credentials` (EXTENSIÓN H03, propiedad H03)
--
-- Aditiva: crea la tabla de credenciales de recurso y AÑADE la FK diferida
-- desde `orders.product_orders.credential_id`, rota la circularidad M1↔M2.
-- No modifica `booking.guest_credentials` ni `iam.client_access_sessions`.
--
-- Ciclo de vida: token de un solo uso, guardado SOLO como digest; una
-- credencial ACTIVA por pedido; generación monotonicamente creciente;
-- `expires_at` nullable (D26: sin TTL por reloj en V1).
--
-- Rollback: alter table orders.product_orders drop constraint if exists
--            product_orders_credential_fk;
--            drop table clients.order_credentials;
--            (NO revierte H01..H05)
-- =============================================================================

create table if not exists clients.order_credentials (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references business.businesses(id) on delete restrict,
  order_id          uuid not null,
  token_digest      text not null unique,
  generation        integer not null default 1 check (generation > 0),
  status            text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED','EXPIRED')),
  expires_at        timestamptz,
  issued_at         timestamptz not null default now(),
  revoked_at        timestamptz,
  revoked_reason    text,
  reissued_from_id  uuid,
  revision          bigint not null default 1 check (revision > 0),

  unique (business_id, id),
  constraint order_credentials_reissued_fk foreign key (business_id, reissued_from_id)
    references clients.order_credentials(business_id, id) on delete restrict,
  constraint order_credentials_revoked_check check ((status = 'ACTIVE') = (revoked_at is null)),
  constraint order_credentials_reason_check check ((revoked_at is null) = (revoked_reason is null))
);

create index if not exists order_credentials_order
  on clients.order_credentials(business_id, order_id, status);

-- one-active-per-order: índice parcial (no es sintaxis de tabla).
create unique index if not exists order_credentials_one_active
  on clients.order_credentials(business_id, order_id) where status = 'ACTIVE';

-- FK diferida: M1 creó la columna sin restricción para romper la circularidad.
alter table orders.product_orders
  drop constraint if exists product_orders_credential_fk;
alter table orders.product_orders
  add constraint product_orders_credential_fk foreign key (business_id, credential_id)
  references clients.order_credentials(business_id, id) on delete restrict;

alter table clients.order_credentials enable row level security;

revoke all on clients.order_credentials from public, anon, authenticated;
grant select, insert, update on clients.order_credentials to service_role;

comment on table clients.order_credentials is
  'H03/H06: credencial por recurso. El token en claro nunca se persiste; solo su digest SHA-256 base64url.';
