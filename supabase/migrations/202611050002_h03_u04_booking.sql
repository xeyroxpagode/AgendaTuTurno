-- H03.U04 Reservas y Booking Público — esquema `booking`.
-- FKs compuestas tenant-safe, constraints reales, RLS, grants mínimos.
-- Migración ADITIVA: no altera migraciones publicadas ni datos existentes.

-- La tabla publicada carece de unique (business_id, id); se añade de forma
-- aditiva para permitir FKs compuestas tenant-safe desde booking.
alter table catalog.service_terms_versions
  add constraint service_terms_versions_business_id_id_key unique (business_id, id);

create schema if not exists booking;

-- ─────────────────────────── Reservas ───────────────────────────
create table booking.reservations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  revision bigint not null default 1 check (revision >= 1),
  status text not null check (status in ('CONFIRMED','CANCELLED')),
  owner_type text not null check (owner_type in ('CLIENT','GUEST')),
  owner_account_id uuid references iam.user_accounts(id) on delete restrict,
  client_profile_id uuid,
  contact_snapshot jsonb not null,
  staff_member_id uuid not null,
  policy_version_id uuid not null,
  policy_snapshot jsonb not null,
  commercial_total_minor bigint not null check (commercial_total_minor >= 0),
  currency text not null check (currency = 'ARS'),
  current_allocation_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  occupied_starts_at timestamptz not null,
  occupied_ends_at timestamptz not null,
  business_local_date date not null,
  business_timezone_snapshot text not null,
  created_operation_id uuid not null references system.operation_attempts(operation_id) on delete restrict,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (occupied_starts_at <= starts_at),
  check (ends_at <= occupied_ends_at),
  check (occupied_starts_at < occupied_ends_at),
  check ((owner_type = 'CLIENT' and owner_account_id is not null)
      or (owner_type = 'GUEST'  and owner_account_id is null)),
  check ((status = 'CONFIRMED' and cancelled_at is null)
      or (status = 'CANCELLED' and cancelled_at is not null)),
  unique (business_id, id),
  foreign key (business_id)
    references business.businesses(id) on delete restrict,
  foreign key (business_id, staff_member_id)
    references team.staff_members(business_id, id) on delete restrict,
  foreign key (business_id, policy_version_id)
    references business.booking_policy_versions(business_id, id) on delete restrict,
  foreign key (business_id, client_profile_id)
    references clients.client_profiles(business_id, id) on delete restrict,
  foreign key (business_id, current_allocation_id)
    references availability.resource_allocations(business_id, id) on delete restrict
);
create index booking_reservations_business_status on booking.reservations(business_id, status, starts_at);
create index booking_reservations_owner on booking.reservations(business_id, owner_account_id) where owner_account_id is not null;
create index booking_reservations_staff_date on booking.reservations(business_id, staff_member_id, business_local_date);
create index booking_reservations_operation on booking.reservations(business_id, created_operation_id);

-- ─────────────────────────── Ítems ───────────────────────────
create table booking.reservation_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  reservation_id uuid not null,
  position integer not null check (position >= 1),
  service_id uuid not null,
  service_name_snapshot text not null check (length(trim(service_name_snapshot)) > 0),
  terms_version_id uuid not null,
  duration_minutes integer not null check (duration_minutes > 0),
  pre_buffer_minutes integer not null check (pre_buffer_minutes >= 0),
  post_buffer_minutes integer not null check (post_buffer_minutes >= 0),
  price_minor bigint not null check (price_minor >= 0),
  currency text not null check (currency = 'ARS'),
  conditions_snapshot text,
  created_at timestamptz not null default now(),
  unique (business_id, reservation_id, position),
  unique (business_id, reservation_id, service_id),
  foreign key (business_id, reservation_id)
    references booking.reservations(business_id, id) on delete restrict,
  foreign key (business_id, service_id)
    references catalog.services(business_id, id) on delete restrict,
  foreign key (business_id, terms_version_id)
    references catalog.service_terms_versions(business_id, id) on delete restrict
);
create index booking_reservation_items_reservation on booking.reservation_items(business_id, reservation_id);

-- ─────────────────── Historia append-only ───────────────────
create table booking.reservation_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  reservation_id uuid not null,
  sequence bigint not null check (sequence >= 1),
  event_type text not null,
  operation_id uuid not null references system.operation_attempts(operation_id) on delete restrict,
  principal_type text not null check (principal_type in ('STAFF','CLIENT','GUEST_INTENT','GUEST_RESERVATION')),
  actor_account_id uuid references iam.user_accounts(id) on delete restrict,
  staff_member_id uuid,
  occurred_at timestamptz not null default now(),
  before_revision bigint,
  after_revision bigint,
  changes jsonb not null default '{}'::jsonb,
  reason_code text check (reason_code is null or length(reason_code) <= 120),
  audit_reference text check (audit_reference is null or length(audit_reference) <= 200),
  unique (business_id, reservation_id, sequence),
  foreign key (business_id, reservation_id)
    references booking.reservations(business_id, id) on delete restrict
);
create index booking_reservation_events_reservation on booking.reservation_events(business_id, reservation_id, sequence);
create index booking_reservation_events_operation on booking.reservation_events(business_id, operation_id);

create function booking.reject_event_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'reservation_events is append-only' using errcode = '55000';
end;
$$;
create trigger reservation_events_immutable
  before update or delete on booking.reservation_events
  for each row execute function booking.reject_event_mutation();

-- ─────────────── Credenciales invitadas (digest) ───────────────
create table booking.guest_credentials (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  reservation_id uuid not null,
  token_digest text not null,
  generation integer not null default 1 check (generation >= 1),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  unique (business_id, id),
  unique (business_id, reservation_id, generation),
  unique (token_digest),
  check ((status = 'ACTIVE'  and revoked_at is null) or (status = 'REVOKED' and revoked_at is not null)),
  foreign key (business_id, reservation_id)
    references booking.reservations(business_id, id) on delete restrict
);
-- Una única credencial ACTIVE por reserva.
create unique index guest_credentials_one_active_per_reservation
  on booking.guest_credentials(business_id, reservation_id)
  where status = 'ACTIVE';
create index guest_credentials_lookup on booking.guest_credentials(business_id, token_digest);

-- ─────────── Delivery envelopes (AEAD, TTL acotada) ───────────
create table booking.guest_delivery_envelopes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  operation_id uuid not null references system.operation_attempts(operation_id) on delete restrict,
  reservation_id uuid not null,
  intent_proof_digest text not null,
  encrypted_payload bytea not null,
  key_version text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  unique (business_id, operation_id),
  foreign key (business_id, reservation_id)
    references booking.reservations(business_id, id) on delete restrict
);
create index guest_delivery_envelopes_expiry on booking.guest_delivery_envelopes(expires_at);

-- ─────────── Recuperación asistida (fail-closed) ───────────
create table booking.guest_recovery_cases (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  reservation_id uuid not null,
  requested_at timestamptz not null default now(),
  requested_by_staff_id uuid not null,
  verification_method text not null,
  evidence_reference text not null check (length(trim(evidence_reference)) > 0),
  verified_by_staff_id uuid,
  verified_at timestamptz,
  reason text not null check (length(trim(reason)) > 0),
  status text not null default 'REQUESTED' check (status in ('REQUESTED','VERIFIED','COMPLETED','REJECTED')),
  completed_at timestamptz,
  audit_reference text,
  foreign key (business_id, reservation_id)
    references booking.reservations(business_id, id) on delete restrict,
  foreign key (business_id, requested_by_staff_id)
    references team.staff_members(business_id, id) on delete restrict,
  foreign key (business_id, verified_by_staff_id)
    references team.staff_members(business_id, id) on delete restrict,
  check ((status = 'COMPLETED' and completed_at is not null) or status <> 'COMPLETED'),
  check ((status in ('VERIFIED','COMPLETED') and verified_by_staff_id is not null and verified_at is not null)
      or status in ('REQUESTED','REJECTED'))
);
create index guest_recovery_cases_reservation on booking.guest_recovery_cases(business_id, reservation_id);

-- ─────────── Idempotencia multi-principal (H01 adaptada) ───────────
alter table system.operation_attempts
  add column if not exists principal_kind text not null default 'STAFF';
alter table system.operation_attempts
  drop constraint if exists operation_attempts_principal_kind_check;
alter table system.operation_attempts
  add constraint operation_attempts_principal_kind_check
  check (principal_kind in ('STAFF','CLIENT','GUEST_INTENT','GUEST_RESERVATION'));
alter table system.operation_attempts
  add column if not exists principal_ref text;
create index if not exists operation_attempts_principal
  on system.operation_attempts(business_id, principal_kind, principal_ref);

-- ─────────── Integridad Reservation ↔ Allocation (G08) ───────────
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
    elsif reservation.status = 'CANCELLED' then
      select count(*) into active_count
        from availability.resource_allocations a
       where a.business_id = reservation.business_id
         and a.source_type = 'RESERVATION'
         and a.source_id = reservation.id
         and a.status = 'ACTIVE';
      if active_count <> 0 then
        raise exception 'CANCELLED reservation % must not retain ACTIVE Allocations (found %)', reservation.id, active_count
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

create constraint trigger reservations_allocation_integrity
  after insert or update on booking.reservations
  deferrable initially deferred
  for each row execute function booking.assert_reservation_allocation_integrity();

create constraint trigger allocations_reservation_integrity
  after insert or update on availability.resource_allocations
  deferrable initially deferred
  for each row execute function booking.assert_reservation_allocation_integrity();

create constraint trigger reservations_no_delete
  after delete on booking.reservations
  deferrable initially deferred
  for each row execute function booking.assert_reservation_allocation_integrity();

create constraint trigger allocations_no_delete
  after delete on availability.resource_allocations
  deferrable initially deferred
  for each row execute function booking.assert_reservation_allocation_integrity();

-- ─────────── Seguridad: sin escritura directa anon/authenticated ───────────
revoke all on schema booking from anon, authenticated;
revoke all on all tables in schema booking from anon, authenticated;

grant usage on schema booking to service_role;
grant all on all tables in schema booking to service_role;

alter table booking.reservations enable row level security;
alter table booking.reservation_items enable row level security;
alter table booking.reservation_events enable row level security;
alter table booking.guest_credentials enable row level security;
alter table booking.guest_delivery_envelopes enable row level security;
alter table booking.guest_recovery_cases enable row level security;
