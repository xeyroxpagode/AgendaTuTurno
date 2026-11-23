-- =============================================================================
-- H06 · CAP-06-01..07 · Pedidos de productos para retiro
-- M1 · esquema `orders`, 2 tablas, 3 vistas, triggers de transición y línea
-- confirmada, RLS y grants de defense-in-depth.
--
-- Migración ADITIVA y no destructiva. No altera ni borra hechos de H01..H05.
-- Sin backfill: no existen ProductOrder en el baseline 116148f.
--
-- Invariantes materializados:
--   D01/D03  · catálogo sin stock; confirmación all-or-none de 1..50 líneas.
--   D13/D16  · snapshot REQUESTED inmutable; confirmed_snapshot congelado.
--   D23/D26  · estados terminales inmutables; sin TTL del pedido.
--   D28      · como máximo una Sale y un Checkout por pedido.
--   T-02     · historial, incidencias y comprobante de receptor son VISTAS
--              sobre `system.audit_events`, nunca tablas propias.
--
-- Rollback: drop trigger guard_confirmed_line; drop function orders.guard_confirmed_line();
--            drop trigger guard_order_transition; drop function orders.guard_transition();
--            drop view orders.order_delivery_receipts, orders.order_incidents,
--                       orders.order_transitions;
--            drop table orders.order_lines, orders.product_orders;
--            drop schema orders;
--            (NO revierte H01..H05)
-- =============================================================================

create schema if not exists orders;

-- -----------------------------------------------------------------------------
-- 1. orders.product_orders
-- -----------------------------------------------------------------------------
create table if not exists orders.product_orders (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references business.businesses(id) on delete restrict,
  operation_id          uuid not null,
  status                text not null default 'REQUESTED'
    check (status in ('REQUESTED','CONFIRMED','PREPARING','READY','DELIVERED','REJECTED','CANCELLED')),
  customer_kind         text not null check (customer_kind in ('CLIENT','GUEST')),
  client_profile_id     uuid,
  customer_account_id   uuid,
  credential_id         uuid,
  sale_id               uuid,
  checkout_id           uuid,
  currency              text not null default 'ARS' check (currency = 'ARS'),
  requested_snapshot    jsonb not null,
  confirmed_snapshot    jsonb,
  total_requested_minor integer not null check (total_requested_minor > 0),
  total_confirmed_minor integer,
  rejection_reason      text,
  cancellation_reason   text,
  revision              bigint not null default 1 check (revision between 1 and 9007199254740991),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by_account_id uuid,

  unique (business_id, id),
  unique (business_id, operation_id),
  -- D28: una Sale causal por ProductOrder; un checkout por Order.
  unique (business_id, sale_id),
  unique (business_id, checkout_id),
  constraint product_orders_attempt_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict,
  constraint product_orders_client_fk foreign key (business_id, client_profile_id)
    references clients.client_profiles(business_id, id) on delete restrict,
  -- customer_account_id es identidad GLOBAL de H03: FK simple, nunca
  -- una FK cross-business construida con un UUID conocido (Q29).
  constraint product_orders_account_fk foreign key (customer_account_id)
    references iam.user_accounts(id) on delete restrict,
  constraint product_orders_sale_fk foreign key (business_id, sale_id)
    references sales.sales(business_id, id) on delete restrict,
  constraint product_orders_checkout_fk foreign key (business_id, checkout_id)
    references checkout.checkouts(business_id, id) on delete restrict,
  -- Sin auto-merge por teléfono/nombre (D08/H03). El sufijo `_consistency`
  -- evita colisionar con el nombre automático del CHECK de `customer_kind`.
  constraint product_orders_customer_consistency_check check (
    (customer_kind = 'CLIENT' and client_profile_id is not null and credential_id is null)
    or (customer_kind = 'GUEST' and client_profile_id is null and customer_account_id is null)
  ),
  constraint product_orders_rejection_reason_check
    check ((status <> 'REJECTED') or (rejection_reason is not null and length(trim(rejection_reason)) between 3 and 500)),
  constraint product_orders_cancellation_reason_check
    check ((status <> 'CANCELLED') or (cancellation_reason is not null and length(trim(cancellation_reason)) between 3 and 500)),
  constraint product_orders_snapshot_check
    check ((status in ('REQUESTED','REJECTED','CANCELLED')) = (confirmed_snapshot is null))
);

create index if not exists product_orders_business_status
  on orders.product_orders(business_id, status, created_at desc, id desc);
create index if not exists product_orders_business_client
  on orders.product_orders(business_id, client_profile_id, created_at desc)
  where client_profile_id is not null;
create index if not exists product_orders_sale
  on orders.product_orders(business_id, sale_id) where sale_id is not null;

comment on table orders.product_orders is
  'H06: intencion comercial de retiro, sin stock prometido, sin pago online y sin TTL. La fuente de verdad del pedido es su snapshot.';

-- -----------------------------------------------------------------------------
-- 2. orders.order_lines
-- -----------------------------------------------------------------------------
create table if not exists orders.order_lines (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null,
  order_id               uuid not null,
  position               integer not null check (position between 1 and 50),
  sku                    text not null,
  location_id            uuid,
  name_snapshot          text not null check (length(trim(name_snapshot)) between 1 and 200),
  category_snapshot      text not null default '',
  image_url_snapshot     text,
  quantity               integer not null check (quantity between 1 and 1000000000),
  unit_price_minor       integer not null check (unit_price_minor between 1 and 1000000000),
  currency               text not null default 'ARS' check (currency = 'ARS'),
  conditions_snapshot    jsonb not null default '{}'::jsonb,
  confirmed_price_minor  integer,
  confirmed_quantity     integer,
  confirmed_at           timestamptz,
  revision               bigint not null default 1 check (revision between 1 and 9007199254740991),

  unique (business_id, id),
  unique (business_id, order_id, position),
  constraint order_lines_order_fk foreign key (business_id, order_id)
    references orders.product_orders(business_id, id) on delete restrict,
  constraint order_lines_item_fk foreign key (business_id, sku)
    references inventory.items(business_id, sku) on delete restrict,
  constraint order_lines_location_fk foreign key (business_id, location_id)
    references inventory.locations(business_id, id) on delete restrict,
  -- Precio y cantidad confirmados aparecen juntos o no aparecen.
  constraint order_lines_confirmed_price_check
    check ((confirmed_price_minor is null) = (confirmed_at is null)),
  constraint order_lines_confirmed_quantity_check
    check ((confirmed_quantity is null) = (confirmed_at is null))
);

create index if not exists order_lines_order
  on orders.order_lines(business_id, order_id, position);

comment on table orders.order_lines is
  'H06: lineas con precio historico. `location_id` nullable: el catalogo publico no revela ubicaciones; H04 resuelve la ubicacion vendible al confirmar.';

-- -----------------------------------------------------------------------------
-- 3. Vistas sobre system.audit_events (T-02: sin tablas de historial)
-- -----------------------------------------------------------------------------
create or replace view orders.order_transitions as
select e.id,
       e.business_id,
       e.resource_id as "orderId",
       e.changes->>'fromStatus' as "fromStatus",
       e.changes->>'toStatus' as "toStatus",
       e.operation_id as "operationId",
       e.actor_account_id as "actorAccountId",
       e.changes,
       e.occurred_at
  from system.audit_events e
 where e.resource_type = 'PRODUCT_ORDER'
   and e.action like 'order.%'
   and e.changes ? 'toStatus';

create or replace view orders.order_incidents as
select e.id,
       e.business_id,
       e.resource_id as "orderId",
       e.changes->>'kind' as kind,
       coalesce(e.changes->>'status','OPEN') as status,
       e.changes->>'moneyOperationId' as "moneyOperationId",
       e.changes->>'deliveryMovementId' as "deliveryMovementId",
       e.changes->>'authorityAccountId' as "authorityAccountId",
       e.changes->>'reason' as reason,
       e.changes as evidence,
       e.operation_id as "operationId",
       e.occurred_at as "createdAt"
  from system.audit_events e
 where e.resource_type = 'PRODUCT_ORDER'
   and e.action like 'order.incident.%';

create or replace view orders.order_delivery_receipts as
select e.id,
       e.business_id,
       e.resource_id as "orderId",
       e.changes->>'receiverKind' as "receiverKind",
       e.changes->>'receiverName' as "receiverName",
       e.changes->>'verificationMethod' as "verificationMethod",
       e.actor_account_id as "verifiedByAccountId",
       e.changes->>'saleId' as "saleId",
       e.changes->>'checkoutId' as "checkoutId",
       e.changes->>'deliveryMovementId' as "deliveryMovementId",
       e.operation_id as "operationId",
       e.occurred_at as "createdAt"
  from system.audit_events e
 where e.resource_type = 'PRODUCT_ORDER'
   and e.action in ('order.delivered','order.delivered_to_third_party');

-- -----------------------------------------------------------------------------
-- 4. Triggers de integridad comercial
-- -----------------------------------------------------------------------------
create or replace function orders.guard_transition() returns trigger
language plpgsql as $$
declare allowed text[];
begin
  if tg_op <> 'UPDATE' or new.status = old.status then return new; end if;
  allowed := case old.status
    when 'REQUESTED' then array['CONFIRMED','REJECTED','CANCELLED']
    when 'CONFIRMED' then array['PREPARING','CANCELLED']
    when 'PREPARING' then array['READY','CANCELLED']
    when 'READY'     then array['DELIVERED','CANCELLED']
    else array[]::text[] end;
  if not (new.status = any(allowed)) then
    raise exception 'Invalid order transition % -> %', old.status, new.status using errcode='23514';
  end if;
  if old.status in ('DELIVERED','REJECTED','CANCELLED') then
    raise exception 'Terminal order state is immutable' using errcode='23514';
  end if;
  -- CAS: toda mutación de estado incrementa exactamente una revisión.
  if new.revision <> old.revision + 1 then
    raise exception 'Stale order revision' using errcode='23514';
  end if;
  return new;
end $$;

drop trigger if exists guard_order_transition on orders.product_orders;
create trigger guard_order_transition before update on orders.product_orders
  for each row execute function orders.guard_transition();

create or replace function orders.guard_confirmed_line() returns trigger
language plpgsql as $$
begin
  -- D13: corrección = cancelar + nueva solicitud; nunca edición silenciosa.
  if old.confirmed_at is not null then
    raise exception 'Confirmed order line is immutable' using errcode='23514';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists guard_confirmed_line on orders.order_lines;
create trigger guard_confirmed_line before update or delete on orders.order_lines
  for each row execute function orders.guard_confirmed_line();

-- -----------------------------------------------------------------------------
-- 5. RLS y grants (defense-in-depth; enforcement real = WHERE business_id)
-- -----------------------------------------------------------------------------
alter table orders.product_orders enable row level security;
alter table orders.order_lines     enable row level security;

revoke all on schema orders from public, anon, authenticated;
revoke all on all tables in schema orders from public, anon, authenticated;
grant usage on schema orders to service_role;
-- Sin DELETE: la historia es inmutable (D26).
grant select, insert, update on orders.product_orders, orders.order_lines to service_role;
