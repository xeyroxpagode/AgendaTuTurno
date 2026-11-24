-- WP-06 / M3 — Oferta de cursos (CAP-07-01).
--
-- DISCOVERY_ONLY: no hay alumnos, inscripciones, cupos, matrículas, pagos,
-- certificados ni asistencia nominal. Sólo oferta, publicación e historia.

create table courses.courses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id),
  title text not null check (length(trim(title)) between 1 and 200),
  summary text,
  description text,
  -- Datos de contacto PÚBLICOS del negocio, no de un profesional ajeno.
  contact_channel text check (contact_channel in ('PHONE', 'EMAIL', 'WHATSAPP', 'NONE')),
  contact_value text,
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'CANCELLED')),
  revision integer not null default 1 check (revision > 0),
  published_at timestamptz,
  created_by_account_id uuid not null references iam.user_accounts(id),
  operation_id uuid references system.operation_attempts(operation_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

create index courses_business_status on courses.courses(business_id, status);

create table courses.course_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  course_id uuid not null,
  event_type text not null,
  actor_account_id uuid not null references iam.user_accounts(id),
  operation_id uuid references system.operation_attempts(operation_id),
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (business_id, course_id) references courses.courses(business_id, id)
);

create index course_events_lookup on courses.course_events(business_id, course_id, created_at);

-- Append-only: la historia es inmutable.
create or replace function courses.reject_event_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'Course events are append-only' using errcode = '23514';
end $$;

drop trigger if exists course_events_immutable on courses.course_events;
create trigger course_events_immutable
  before update or delete on courses.course_events
  for each row execute function courses.reject_event_mutation();

revoke all on schema courses from anon, authenticated;
grant usage on schema courses to service_role;
revoke all on all tables in schema courses from anon, authenticated;
grant all on all tables in schema courses to service_role;
alter table courses.courses enable row level security;
alter table courses.course_events enable row level security;
revoke all on function courses.reject_event_mutation() from public, anon, authenticated;
grant execute on function courses.reject_event_mutation() to service_role;
