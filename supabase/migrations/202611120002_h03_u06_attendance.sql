-- H03.U06 (D01) - CAP-03-08 - Prestacion real (Attendance).
--
-- Migracion ADITIVA y no destructiva. No altera ni borra datos historicos de
-- U01..U05. Crea el esquema `attendance` con tres tablas:
--
--   attendance.attendances           : la atencion realmente realizada
--   attendance.attendance_corrections : correcciones trazables (nunca borrado)
--   attendance.attendance_events      : ledger append-only de la atencion
--
-- Reconciliacion documentada con C01 `01_CURRENT_TARGET_AND_PERSISTENCE.md`:
--   1) Representacion legitima de walk-in (Actor B, D01 §03.5):
--      `reservation_id = NULL` CON `walk_in = true` es una combinacion VALIDA.
--      Ningun CHECK la prohibe. El CHECK de la tabla exige exactamente:
--        - si `reservation_id is null` => `walk_in` es true (atencion sin reserva);
--        - si `walk_in` es true        => `reservation_id is null` (no existe
--          una Reservation ficticia) y `contact_snapshot` no es null (identidad
--          minima del walk-in);
--        - si `walk_in` es false       => `reservation_id is not null`.
--   2) `iam.user_accounts` no tiene `business_id`: FK sobre `id` y aislamiento
--      por `business_id` + FKs compuestas a `team.staff_members` /
--      `booking.reservations` / `clients.client_profiles`.
--   3) Una reserva admite como mucho UNA atencion terminal
--      (unique partial `attendances_one_terminal_per_reservation`).
--
-- Rollback: DROP TABLE attendance.attendance_events;
--            DROP TABLE attendance.attendance_corrections;
--            DROP TABLE attendance.attendances;

create schema if not exists attendance;

-- ---------------------------------------------------------------------------
-- 1. Atencion realizada
-- ---------------------------------------------------------------------------
create table if not exists attendance.attendances (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  -- NULL => atencion sin reserva (walk-in legitimo). Nunca una reserva ficticia.
  reservation_id uuid,
  -- Profesional que REGISTRA la atencion.
  staff_member_id uuid not null,
  -- Profesional RESPONSABLE de la atencion (puede diferir del que registra).
  attended_by_staff_member_id uuid not null,
  -- NULL => no hay ficha CRM asociada (walk-in NO crea cuenta CLIENT).
  client_profile_id uuid,
  walk_in boolean not null default false,
  status text not null default 'IN_PROGRESS'
    check (status in ('IN_PROGRESS','COMPLETED','PARTIAL','INTERRUPTED')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- Servicios EFECTIVAMENTE realizados: pueden diferir de reservation_items.
  services_performed_snapshot jsonb,
  -- Nombre/telefono: obligatorio en walk-in (unica identidad sin reserva).
  contact_snapshot jsonb,
  notes text,
  revision bigint not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendances_unique_business_id_id unique (business_id, id),
  constraint attendances_reservation_fk
    foreign key (business_id, reservation_id)
    references booking.reservations(business_id, id) on delete restrict,
  constraint attendances_registering_staff_fk
    foreign key (business_id, staff_member_id)
    references team.staff_members(business_id, id) on delete restrict,
  constraint attendances_responsible_staff_fk
    foreign key (business_id, attended_by_staff_member_id)
    references team.staff_members(business_id, id) on delete restrict,
  constraint attendances_client_profile_fk
    foreign key (business_id, client_profile_id)
    references clients.client_profiles(business_id, id) on delete restrict,
  -- Walk-in: sin reserva y con contacto minimo.
  constraint attendances_walk_in_requires_contact
    check (not walk_in or contact_snapshot is not null),
  constraint attendances_walk_in_has_no_reservation
    check (not walk_in or reservation_id is null),
  -- Sin walk-in siempre hay reserva legitimita.
  constraint attendances_requires_reservation_or_walk_in
    check (reservation_id is not null or walk_in),
  -- Estados terminales: `finished_at` obligatorio; en curso: prohibido.
  constraint attendances_terminal_finished_check
    check ((status = 'IN_PROGRESS' and finished_at is null)
        or (status <> 'IN_PROGRESS' and finished_at is not null)),
  constraint attendances_terminal_services_check
    check (status = 'IN_PROGRESS' or services_performed_snapshot is not null)
);

comment on table attendance.attendances is
  'H03.U06 CAP-03-08: prestacion real. Distinta de Reservation; walk-in legitimo con reservation_id NULL.';

create index if not exists attendances_reservation
  on attendance.attendances (business_id, reservation_id);

create index if not exists attendances_staff_started
  on attendance.attendances (business_id, attended_by_staff_member_id, started_at desc);

create index if not exists attendances_business_status
  on attendance.attendances (business_id, status, started_at desc);

-- Una reserva admite como mucho UNA atencion terminal.
create unique index if not exists attendances_one_terminal_per_reservation
  on attendance.attendances (business_id, reservation_id)
  where reservation_id is not null
    and status in ('COMPLETED','PARTIAL','INTERRUPTED');

-- ---------------------------------------------------------------------------
-- 2. Correcciones trazables (nunca se borra la atencion original)
-- ---------------------------------------------------------------------------
create table if not exists attendance.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  attendance_id uuid not null,
  changed_by_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  changed_at timestamptz not null default now(),
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  reason text not null check (length(trim(reason)) > 0),
  constraint attendance_corrections_unique_business_id_id unique (business_id, id),
  constraint attendance_corrections_attendance_fk
    foreign key (business_id, attendance_id)
    references attendance.attendances(business_id, id) on delete restrict
);

create index if not exists attendance_corrections_attendance
  on attendance.attendance_corrections (business_id, attendance_id, changed_at desc);

-- ---------------------------------------------------------------------------
-- 3. Ledger append-only de eventos de atencion
-- ---------------------------------------------------------------------------
create table if not exists attendance.attendance_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  attendance_id uuid not null,
  sequence bigint not null check (sequence >= 1),
  event_type text not null check (event_type in (
    'ATTENDANCE_REGISTERED','ATTENDANCE_WALKIN_REGISTERED','ATTENDANCE_COMPLETED',
    'ATTENDANCE_PARTIAL','ATTENDANCE_INTERRUPTED','ATTENDANCE_CORRECTED')),
  operation_id uuid not null references system.operation_attempts(operation_id) on delete restrict,
  principal_type text not null,
  actor_account_id uuid references iam.user_accounts(id) on delete restrict,
  staff_member_id uuid,
  occurred_at timestamptz not null default now(),
  before_revision bigint,
  after_revision bigint,
  changes jsonb not null default '{}'::jsonb,
  reason_code text,
  constraint attendance_events_unique_sequence unique (business_id, attendance_id, sequence),
  constraint attendance_events_attendance_fk
    foreign key (business_id, attendance_id)
    references attendance.attendances(business_id, id) on delete restrict
);

create index if not exists attendance_events_attendance
  on attendance.attendance_events (business_id, attendance_id, sequence);

create or replace function attendance.reject_event_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'attendance events are append-only (attempted %)', TG_OP using errcode = '55000';
end;
$$;

drop trigger if exists attendance_events_immutable on attendance.attendance_events;
create trigger attendance_events_immutable
  before delete or update on attendance.attendance_events
  for each row execute function attendance.reject_event_mutation();

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
grant usage on schema attendance to service_role;
grant all on all tables in schema attendance to service_role;
revoke all on all tables in schema attendance from anon, authenticated;
