-- =============================================================================
-- H06 · M4 (CORRECTIVO FINAL) — constraints de estados terminales
--
-- Defecto detectado en el cierre final: el constraint de M1 exigía
-- `confirmed_snapshot is null` para CANCELLED. Una cancelación legítima en fase
-- CONFIRMED/PREPARING/READY conserva el snapshot confirmado como historia, por
-- lo que la transición era rechazada por SQL (23514).
--
-- Este cambio es ADITIVO y no destructivo: sólo reemplaza un CHECK por su
-- versión corregida. No altera hechos, no hace backfill y no toca H01..H05.
--
-- Rollback: alter table orders.product_orders drop constraint if exists
--            product_orders_snapshot_check;
--            alter table orders.product_orders add constraint
--            product_orders_snapshot_check check (
--              (status in ('REQUESTED','REJECTED','CANCELLED')) = (confirmed_snapshot is null));
-- =============================================================================

alter table orders.product_orders
  drop constraint if exists product_orders_snapshot_check;

alter table orders.product_orders
  add constraint product_orders_snapshot_check check (
    (status in ('CONFIRMED','PREPARING','READY','DELIVERED') = (confirmed_snapshot is not null))
    or status = 'CANCELLED'
  );

comment on constraint product_orders_snapshot_check on orders.product_orders is
  'M4: CONFIRMED..DELIVERED exigen snapshot; REQUESTED/REJECTED no lo tienen; CANCELLED puede conservarlo como historia.';
