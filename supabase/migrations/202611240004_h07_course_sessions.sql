-- WP-06 / M4 — Sesiones de curso e instructor (CAP-07-02/03/04).
--
-- La ocupación NO vive aquí: vive en availability.resource_allocations con
-- source_type='COURSE_SESSION'. Esta tabla conserva identidad, estado e
-- historia; `operation_id` enlaza con system.operation_attempts (M-H07-04).

create table courses.course_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id),
  course_id uuid not null,
  instructor_staff_member_id uuid not null,
  local_date date not null,
  timezone text not null,
  -- Visibilidad/ocupación en instantes inequívocos; la ENTRADA local se
  -- captura en la capa de dominio para poder detectar DST (NEW-04).
  visible_start_at timestamptz,
  occupied_start_at timestamptz not null,
  occupied_end_at timestamptz not null,
  status text not null default 'SCHEDULED'
    check (status in ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'COMPLETED')),
  revision integer not null default 1 check (revision > 0),
  operation_id uuid references system.operation_attempts(operation_id),
  confirmed_by_account_id uuid references iam.user_accounts(id),
  confirmed_at timestamptz,
  completed_by_account_id uuid references iam.user_accounts(id),
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  check (occupied_end_at > occupied_start_at),
  check (visible_start_at is null or visible_start_at <= occupied_start_at),
  foreign key (business_id, course_id) references courses.courses(business_id, id),
  foreign key (business_id, instructor_staff_member_id)
    references team.staff_members(business_id, id)
);

create index course_sessions_lookup on courses.course_sessions(business_id, course_id, local_date);
create index course_sessions_instructor on courses.course_sessions(business_id, instructor_staff_member_id, occupied_start_at);

create table courses.course_session_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  session_id uuid not null,
  event_type text not null,
  actor_account_id uuid not null references iam.user_accounts(id),
  operation_id uuid references system.operation_attempts(operation_id),
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (business_id, session_id) references courses.course_sessions(business_id, id)
);

create index course_session_events_lookup
  on courses.course_session_events(business_id, session_id, created_at);

drop trigger if exists course_session_allocation_integrity on courses.course_sessions;
create constraint trigger course_session_allocation_integrity
  after insert or update on courses.course_sessions
  deferrable initially deferred
  for each row execute function courses.assert_session_allocation_integrity();

drop trigger if exists course_session_events_immutable on courses.course_session_events;
create trigger course_session_events_immutable
  before update or delete on courses.course_session_events
  for each row execute function courses.reject_event_mutation();

revoke all on all tables in schema courses from anon, authenticated;
grant all on all tables in schema courses to service_role;
alter table courses.course_sessions enable row level security;
alter table courses.course_session_events enable row level security;
