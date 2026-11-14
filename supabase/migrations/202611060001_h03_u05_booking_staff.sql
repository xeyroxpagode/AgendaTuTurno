-- H03.U05 · Operación de Agenda Staff — estado NO_SHOW y marca temporal de no-show.
--
-- Migración ADITIVA y NO destructiva sobre datos históricos:
--   · No altera ni borra filas existentes de booking.reservations.
--   · Sólo amplía el dominio de `status` y agrega una columna nullable.
--   · Las 296 reservas históricas (CONFIRMED/CANCELLED) siguen satisfaciendo
--     las nuevas constraints (validadas por PostgreSQL al crearse).
--
-- Correcciones técnicas respecto de C01 §02 (documentadas en el handoff D-01):
--   1) Los NOMBRES REALES de las constraints existentes en la base son
--      `reservations_status_check` (check de status) y un check autogenerado
--      `reservations_check5` (status ↔ cancelled_at). La migración propuesta en
--      C01 §02.4 usaba `booking_reservations_status_check`, nombre que NO existe
--      en la base: el `DROP CONSTRAINT` habría sido un no-op silencioso y el
--      `ADD CONSTRAINT` habría dejado la constraint antigua activa, que
--      seguiría rechazando `NO_SHOW`. Aquí se localizan y eliminan por
--      DEFINICIÓN (no por nombre autogenerado) para ser robustas ante cualquier
--      orden de creación de constraints.
--   2) El trigger diferible `booking.assert_reservation_allocation_integrity`
--      sólo contemplaba CONFIRMED (exige 1 allocation ACTIVE) y CANCELLED
--      (exige 0 allocations ACTIVE). NO_SHOW debe quedar igualmente cubierto
--      (0 allocations ACTIVE), por lo que se reemplaza la función del trigger.

-- ─────────────────────────── 1. Columna de marca de no-show ───────────────────────────
-- Nullable y sin default: las filas históricas quedan con no_show_at IS NULL.
alter table booking.reservations
  add column if not exists no_show_at timestamptz;

-- ─────────────────────────── 2. Reemplazo de constraints de estado ───────────────────────────
-- Se eliminan por definición para no depender de nombres autogenerados.
do $$
declare
  c record;
begin
  -- Check de consistencia status ↔ cancelled_at (contiene 'cancelled_at').
  for c in
    select conname from pg_constraint
    where conrelid = 'booking.reservations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%cancelled_at%'
  loop
    execute format('alter table booking.reservations drop constraint %I', c.conname);
  end loop;

  -- Check de dominio de status (CONFIRMED/CANCELLED, sin 'cancelled_at').
  for c in
    select conname from pg_constraint
    where conrelid = 'booking.reservations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%CONFIRMED%'
      and pg_get_constraintdef(oid) like '%CANCELLED%'
      and pg_get_constraintdef(oid) not like '%cancelled_at%'
  loop
    execute format('alter table booking.reservations drop constraint %I', c.conname);
  end loop;
end
$$;

-- Dominio de estado ampliado. NO_SHOW es terminal (B01 §B4.1, RB-04).
alter table booking.reservations
  add constraint booking_reservations_status_check
  check (status in ('CONFIRMED','CANCELLED','NO_SHOW'));

-- Consistencia estado ↔ cancelación: NO_SHOW no está cancelada.
alter table booking.reservations
  add constraint booking_reservations_status_consistency
  check (
    (status = 'CONFIRMED' and cancelled_at is null)
    or (status = 'CANCELLED' and cancelled_at is not null)
    or (status = 'NO_SHOW'   and cancelled_at is null)
  );

-- Consistencia estado ↔ no_show_at: la marca existe si y sólo si es NO_SHOW.
alter table booking.reservations
  add constraint booking_reservations_no_show_consistency
  check (
    (status = 'NO_SHOW' and no_show_at is not null)
    or (status <> 'NO_SHOW' and no_show_at is null)
  );

-- ─────────────────────────── 3. Índices de agenda ───────────────────────────
-- Índice compuesto para la consulta de agenda por profesional + fecha + estado.
-- `booking_reservations_staff_date` (U04) ya cubre (business_id, staff_member_id,
-- business_local_date); este añade el discriminante de estado para la agenda.
create index if not exists booking_reservations_staff_date_status
  on booking.reservations (business_id, staff_member_id, business_local_date, status);

-- Agenda compartida del Business por fecha y estado (sin filtro de profesional).
create index if not exists booking_reservations_business_date_status
  on booking.reservations (business_id, business_local_date, status);

-- ─────────────────────────── 4. Integridad Reservation ↔ Allocation con NO_SHOW ───────────────────────────
-- Misma semántica que la función de U04, extendida para que NO_SHOW sea
-- terminal sin allocations ACTIVE (el no-show libera su allocation).
create or replace function booking.assert_reservation_allocation_integrity()
returns trigger language plpgsql set search_path = '' as $$
declare
  reservation booking.reservations%ROWTYPE;
  allocation availability.resource_allocations%ROWTYPE;
  active_count bigint;
begin
  if TG_TABLE_NAME = 'reservations' then
    if TG_OP = 'DELETE' then
      raise exception 'reservations cannot be deleted' using errcode = '55000';
    end if;
    reservation := NEW;
    if reservation.status = 'CONFIRMED' then
      select count(*) into active_count
        from availability.resource_allocations a
       where a.business_id = reservation.business_id
         and a.source_type = 'RESERVATION'
         and a.source_id = reservation.id
         and a.status = 'ACTIVE';
      if active_count <> 1 then
        raise exception 'CONFIRMED reservation % requires exactly one ACTIVE Allocation (found %)', reservation.id, active_count
          using errcode = '23514';
      end if;
      select * into allocation
        from availability.resource_allocations a
       where a.business_id = reservation.business_id
         and a.source_type = 'RESERVATION'
         and a.source_id = reservation.id
         and a.status = 'ACTIVE';
      if allocation.staff_member_id <> reservation.staff_member_id
         or allocation.occupied_start_at <> reservation.occupied_starts_at
         or allocation.occupied_end_at   <> reservation.occupied_ends_at
         or allocation.visible_start_at  <> reservation.starts_at
         or allocation.visible_end_at    <> reservation.ends_at
         or allocation.local_date        <> reservation.business_local_date then
        raise exception 'Allocation for reservation % does not match Business/Staff/interval/local_date', reservation.id
          using errcode = '23514';
      end if;
    elsif reservation.status in ('CANCELLED','NO_SHOW') then
      select count(*) into active_count
        from availability.resource_allocations a
       where a.business_id = reservation.business_id
         and a.source_type = 'RESERVATION'
         and a.source_id = reservation.id
         and a.status = 'ACTIVE';
      if active_count <> 0 then
        raise exception '% reservation % must not retain ACTIVE Allocations (found %)', reservation.status, reservation.id, active_count
          using errcode = '23514';
      end if;
    end if;
    return NEW;
  else
    -- availability.resource_allocations
    if TG_OP = 'DELETE' then
      raise exception 'resource_allocations cannot be deleted' using errcode = '55000';
    end if;
    allocation := NEW;
    if allocation.source_type = 'RESERVATION' and allocation.status = 'ACTIVE' then
      select * into reservation
        from booking.reservations r
       where r.business_id = allocation.business_id
         and r.id = allocation.source_id;
      if not found or reservation.status <> 'CONFIRMED'
         or reservation.staff_member_id <> allocation.staff_member_id
         or reservation.occupied_starts_at <> allocation.occupied_start_at
         or reservation.occupied_ends_at   <> allocation.occupied_end_at then
        raise exception 'ACTIVE RESERVATION Allocation % requires a matching CONFIRMED reservation', allocation.id
          using errcode = '23514';
      end if;
    end if;
    return NEW;
  end if;
end;
$$;

-- ─────────────────────────── 5. Grants ───────────────────────────
-- La columna nueva y las constraints nuevas quedan cubiertas por los grants
-- existentes de service_role sobre la tabla (grant all on all tables).
grant usage on schema booking to service_role;
grant all on all tables in schema booking to service_role;
