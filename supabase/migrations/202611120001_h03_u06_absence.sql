-- H03.U06 (D01) - CAP-03-07 - Ausencias y conflictos.
--
-- Migracion ADITIVA y no destructiva. No altera ni borra datos historicos de
-- U01..U05. Crea dos tablas nuevas en el esquema `absence`:
--
--   absence.absence_requests : la solicitud de ausencia (PENDING/APPROVED/APPLIED/REJECTED/WITHDRAWN)
--   absence.absence_events   : ledger append-only de la historia de la solicitud
--
-- Reconciliacion documentada con C01 `01_CURRENT_TARGET_AND_PERSISTENCE.md`:
--   1) La indisponibilidad efectiva NO vive en `availability.staff_effective_unavailability`
--      (esa tabla no existe en el esquema real). La tabla real es
--      `team.staff_effective_unavailability`, con `source_type = 'APPLIED_ABSENCE'`
--      y `source_id` = id de la solicitud de ausencia. Se reutiliza tal cual.
--   2) `iam.user_accounts` NO tiene columna `business_id` (la cuenta es global).
--      Por eso las FKs de actor son sobre `iam.user_accounts(id)` y el
--      aislamiento por Business se garantiza por `business_id` + la FK compuesta
--      a `team.staff_members(business_id, id)`; los comandos validan ademas que
--      el actor pertenece al Business.
--   3) `absence.absence_events` referencia `system.operation_attempts(operation_id)`
--      para conservar la trazabilidad de la operacion (mismo patron que
--      `booking.reservation_events`).
--
-- Rollback: DROP TABLE absence.absence_events; DROP TABLE absence.absence_requests;
-- (se pierden los datos de ausencia creados despues de aplicar; mitigacion
--  documentada en `D01_IMPLEMENTATION/03_DATABASE_AND_MIGRATION_EVIDENCE.md`).

create schema if not exists absence;

-- ---------------------------------------------------------------------------
-- 1. Solicitud de ausencia
-- ---------------------------------------------------------------------------
create table if not exists absence.absence_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  staff_member_id uuid not null,
  requested_by_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  created_operation_id uuid not null references system.operation_attempts(operation_id) on delete restrict,
  local_date date not null,
  start_minute integer not null check (start_minute >= 0 and start_minute < 1440),
  end_minute integer not null check (end_minute > 0 and end_minute <= 1440),
  reason text,
  status text not null default 'PENDING'
    check (status in ('PENDING','APPROVED','APPLIED','REJECTED','WITHDRAWN')),
  revision bigint not null default 1 check (revision >= 1),
  approved_by_account_id uuid references iam.user_accounts(id) on delete restrict,
  approved_at timestamptz,
  reject_reason text,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint absence_requests_interval_check check (start_minute < end_minute),
  constraint absence_requests_unique_business_id_id unique (business_id, id),
  constraint absence_requests_staff_fk
    foreign key (business_id, staff_member_id)
    references team.staff_members(business_id, id) on delete restrict
);

comment on table absence.absence_requests is
  'H03.U06 CAP-03-07: solicitud de ausencia. PENDING no bloquea disponibilidad; APPLIED sí.';

create index if not exists absence_requests_staff_date
  on absence.absence_requests (business_id, staff_member_id, local_date);

create index if not exists absence_requests_status
  on absence.absence_requests (business_id, status);

create index if not exists absence_requests_requested_by
  on absence.absence_requests (business_id, requested_by_account_id);

-- ---------------------------------------------------------------------------
-- 2. Ledger append-only de eventos de ausencia
-- ---------------------------------------------------------------------------
create table if not exists absence.absence_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  absence_request_id uuid not null,
  sequence bigint not null check (sequence >= 1),
  event_type text not null check (event_type in (
    'ABSENCE_REQUESTED','ABSENCE_APPROVED','ABSENCE_REJECTED','ABSENCE_WITHDRAWN',
    'ABSENCE_APPLIED','ABSENCE_CONFLICT_DETECTED','ABSENCE_COMMITMENT_RESOLVED')),
  operation_id uuid not null references system.operation_attempts(operation_id) on delete restrict,
  principal_type text not null,
  actor_account_id uuid references iam.user_accounts(id) on delete restrict,
  staff_member_id uuid,
  occurred_at timestamptz not null default now(),
  before_revision bigint,
  after_revision bigint,
  changes jsonb not null default '{}'::jsonb,
  reason_code text,
  constraint absence_events_unique_sequence unique (business_id, absence_request_id, sequence),
  constraint absence_events_request_fk
    foreign key (business_id, absence_request_id)
    references absence.absence_requests(business_id, id) on delete restrict
);

create index if not exists absence_events_request
  on absence.absence_events (business_id, absence_request_id, sequence);

-- El ledger de eventos es append-only: se reutiliza la funcion de inmutabilidad
-- ya congelada por U04 para `booking.reservation_events`.
create or replace function absence.reject_event_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'absence events are append-only (attempted %)', TG_OP using errcode = '55000';
end;
$$;

drop trigger if exists absence_events_immutable on absence.absence_events;
create trigger absence_events_immutable
  before delete or update on absence.absence_events
  for each row execute function absence.reject_event_mutation();

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
-- Patrón U03/U04/U05: el backend es el único acceso; el cliente nunca talks
-- directo a estas tablas.
grant usage on schema absence to service_role;
grant all on all tables in schema absence to service_role;
revoke all on all tables in schema absence from anon, authenticated;
