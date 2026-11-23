-- =============================================================================
-- H06 · M3 · invariantes de DB y cierre de oráculos
--
-- Aditiva. No borra hechos H01..H05. Sin backfill.
--
--   orders.assert_complete_lines  · conjunto completo SOLO en confirmación
--   orders.guard_delivered        · DELIVERED exige dinero SUCCEEDED o
--                                   excepción D22 autorizada y verificable
--   orders.guard_checkout_source  · `order:<uuid-v4>` válido y mismo negocio
--
-- Rollback: drop trigger guard_checkout_source on checkout.checkouts;
--            drop function orders.guard_checkout_source();
--            drop trigger guard_delivered on orders.product_orders;
--            drop function orders.guard_delivered();
--            drop function orders.assert_single_delivery(uuid,uuid),
--                         orders.assert_single_sale(uuid,uuid),
--                         orders.assert_complete_lines(uuid,uuid);
--            (NO revierte H01..H05)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Q13: aserción de conjunto completo en CONFIRMED
-- -----------------------------------------------------------------------------
create or replace function orders.assert_complete_lines(p_order_id uuid, p_business_id uuid)
returns boolean language sql stable as $$
  select (select count(*) from orders.order_lines
           where business_id = p_business_id and order_id = p_order_id) between 1 and 50
     and not exists (
       select 1 from orders.order_lines l
        where l.business_id = p_business_id
          and l.order_id = p_order_id
          and not exists (
            select 1 from inventory.commitments c
             where c.business_id = p_business_id
               and c.source_reference = 'order:' || p_order_id::text
               and c.sku = l.sku
               and c.location_id is not distinct from l.location_id
               and c.quantity = l.quantity
               and c.state = 'ACTIVE'));
$$;

comment on function orders.assert_complete_lines(uuid, uuid) is
  'Q13: dentro de la Tx de order.confirm, toda línea debe tener su compromiso ACTIVO exacto. El resultado se revierte entero si falla una línea.';

-- -----------------------------------------------------------------------------
-- 2. DELIVERED: refuerzo DB del invariante money -> entrega (P0-2 design)
-- -----------------------------------------------------------------------------
create or replace function orders.guard_delivered() returns trigger
language plpgsql as $$
declare
  mstatus text;
  exc     boolean;
begin
  if new.status <> 'DELIVERED' or new.status = old.status then return new; end if;
  if new.sale_id is null or new.checkout_id is null then
    raise exception 'DELIVERED requires Sale and Checkout' using errcode='23514';
  end if;

  select m.status::text into mstatus
    from money.money_operations m
    join checkout.checkouts c
      on c.business_id = m.business_id and c.money_operation_id = m.id
   where c.business_id = new.business_id and c.id = new.checkout_id;

  -- La excepción D22 NO se satisface con la mera existencia de un evento
  -- UNKNOWN: exige autorización registrada y verificable, hecho físico real
  -- y actor que la emitió (F01 §26, cierre P0-2 design).
  select exists (
    select 1 from system.audit_events e
     where e.business_id = new.business_id
       and e.resource_id = new.id
       and e.action = 'order.incident.exception_d22'
       and e.outcome = 'UNKNOWN'
       and e.changes ? 'authorizedBy'
       and e.changes ? 'deliveryMovementId'
       and e.changes ? 'moneyOperationId'
  ) into exc;

  if coalesce(mstatus,'') <> 'SUCCEEDED' and not coalesce(exc, false) then
    raise exception 'DELIVERED requires confirmed money or documented D22 incident' using errcode='23514';
  end if;
  return new;
end $$;

drop trigger if exists guard_delivered on orders.product_orders;
create trigger guard_delivered before update on orders.product_orders
  for each row execute function orders.guard_delivered();

-- -----------------------------------------------------------------------------
-- 3. source_reference: formato exacto y pertenencia al negocio (F01 §17)
-- -----------------------------------------------------------------------------
create or replace function orders.guard_checkout_source() returns trigger
language plpgsql as $$
begin
  -- Los checkouts H05 históricos usan `checkout:<id>` y NO se tocan.
  if new.source_reference is null or new.source_reference not like 'order:%' then
    return new;
  end if;
  -- Validar el formato ANTES de split_part para no convertir un valor
  -- arbitrario en UUID (evita excepción 22P02 y enumeración).
  if new.source_reference !~ '^order:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    raise exception 'Invalid order source_reference format' using errcode='23514';
  end if;
  if not exists (
    select 1 from orders.product_orders o
     where o.business_id = new.business_id
       and o.id = split_part(new.source_reference, ':', 2)::uuid
  ) then
    raise exception 'Order source_reference does not belong to this business' using errcode='23514';
  end if;
  return new;
end $$;

drop trigger if exists guard_checkout_source on checkout.checkouts;
create trigger guard_checkout_source before insert or update of source_reference
  on checkout.checkouts for each row execute function orders.guard_checkout_source();

-- -----------------------------------------------------------------------------
-- 4. Oráculos de causalidad (una Sale / un movimiento por Order)
-- -----------------------------------------------------------------------------
create or replace function orders.assert_single_sale(p_order_id uuid, p_business_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from orders.product_orders o
      join sales.sales s on s.business_id = o.business_id and s.id = o.sale_id
     where o.business_id = p_business_id and o.id = p_order_id and s.source = 'DIRECT'
  );
$$;

create or replace function orders.assert_single_delivery(p_order_id uuid, p_business_id uuid)
returns boolean language sql stable as $$
  select (select count(*) from inventory.movements m
           where m.business_id = p_business_id
             and m.kind = 'DELIVERY'
             and m.source_reference = 'order:' || p_order_id::text) = 1;
$$;

comment on function orders.assert_single_delivery(uuid, uuid) is
  'Q39: exactamente un movimiento físico de entrega por pedido. Nunca entrega parcial.';
