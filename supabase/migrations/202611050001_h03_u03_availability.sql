create extension if not exists btree_gist;
create schema if not exists availability;

create type availability.allocation_status as enum ('ACTIVE', 'RELEASED');
create type availability.allocation_source as enum ('RESERVATION', 'OPERATIONAL_BLOCK');
create type availability.conflict_status as enum ('OPEN', 'RESOLVED');
create type team.effective_unavailability_source as enum ('APPLIED_ABSENCE', 'OPERATIONAL_BLOCK');

create table business.business_hours_configs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id),
  unique (business_id, id)
);

create table business.business_hours_intervals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  config_id uuid not null,
  weekday integer not null check (weekday between 1 and 7),
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440),
  check (start_minute < end_minute),
  foreign key (business_id, config_id)
    references business.business_hours_configs(business_id, id) on delete cascade
);
create index business_hours_intervals_lookup
  on business.business_hours_intervals(business_id, config_id, weekday, start_minute);

create table business.business_date_exceptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  local_date date not null,
  revision bigint not null default 1 check (revision > 0),
  reason text check (reason is null or length(reason) <= 500),
  created_by uuid references iam.user_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, local_date),
  unique (business_id, id)
);

create table business.business_date_exception_intervals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  exception_id uuid not null,
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440),
  check (start_minute < end_minute),
  foreign key (business_id, exception_id)
    references business.business_date_exceptions(business_id, id) on delete cascade
);
create index business_date_exception_lookup
  on business.business_date_exception_intervals(business_id, exception_id, start_minute);

create table business.booking_policy_versions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  version_number bigint not null check (version_number > 0),
  public_booking_enabled boolean not null,
  horizon_calendar_dates integer not null check (horizon_calendar_dates between 1 and 366),
  min_lead_minutes integer not null check (min_lead_minutes >= 0),
  start_step_minutes integer not null check (start_step_minutes between 1 and 1440),
  cancel_cutoff_minutes integer not null check (cancel_cutoff_minutes >= 0),
  reschedule_cutoff_minutes integer not null check (reschedule_cutoff_minutes >= 0),
  effective_from timestamptz not null default now(),
  created_by uuid not null references iam.user_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, version_number),
  unique (business_id, id)
);

create table business.booking_policy_states (
  business_id uuid primary key references business.businesses(id) on delete restrict,
  current_version_id uuid not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  foreign key (business_id, current_version_id)
    references business.booking_policy_versions(business_id, id) on delete restrict
);

create function business.reject_booking_policy_version_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Booking Policy versions are immutable' using errcode = '55000';
end;
$$;
create trigger booking_policy_versions_immutable
  before update or delete on business.booking_policy_versions
  for each row execute function business.reject_booking_policy_version_update();

create table team.staff_date_exceptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  staff_member_id uuid not null,
  local_date date not null,
  revision bigint not null default 1 check (revision > 0),
  reason text check (reason is null or length(reason) <= 500),
  created_by uuid references iam.user_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, staff_member_id, local_date),
  unique (business_id, id),
  foreign key (business_id, staff_member_id)
    references team.staff_members(business_id, id) on delete restrict
);

create table team.staff_date_exception_intervals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  exception_id uuid not null,
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440),
  check (start_minute < end_minute),
  foreign key (business_id, exception_id)
    references team.staff_date_exceptions(business_id, id) on delete cascade
);
create index staff_date_exception_lookup
  on team.staff_date_exception_intervals(business_id, exception_id, start_minute);

create table team.staff_effective_unavailability (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  staff_member_id uuid not null,
  source_type team.effective_unavailability_source not null,
  source_id uuid not null,
  local_date date not null,
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440),
  applied_at timestamptz not null default now(),
  released_at timestamptz,
  check (start_minute < end_minute),
  unique (business_id, source_type, source_id, local_date, start_minute, end_minute),
  unique (business_id, id),
  foreign key (business_id, staff_member_id)
    references team.staff_members(business_id, id) on delete restrict
);
create index staff_effective_unavailability_lookup
  on team.staff_effective_unavailability(business_id, staff_member_id, local_date)
  where released_at is null;

create table availability.business_guards (
  business_id uuid primary key references business.businesses(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);
insert into availability.business_guards(business_id)
select id from business.businesses on conflict do nothing;

create function availability.create_business_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into availability.business_guards(business_id) values (new.id)
  on conflict do nothing;
  return new;
end;
$$;
create trigger business_availability_guard
  after insert on business.businesses
  for each row execute function availability.create_business_guard();

create table availability.resource_allocations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  staff_member_id uuid not null,
  source_type availability.allocation_source not null,
  source_id uuid not null,
  local_date date not null,
  visible_start_at timestamptz not null,
  visible_end_at timestamptz not null,
  occupied_start_at timestamptz not null,
  occupied_end_at timestamptz not null,
  occupied_range tstzrange generated always as
    (tstzrange(occupied_start_at, occupied_end_at, '[)')) stored,
  status availability.allocation_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text check (release_reason is null or length(release_reason) <= 500),
  check (visible_start_at < visible_end_at),
  check (occupied_start_at < occupied_end_at),
  check (occupied_start_at <= visible_start_at),
  check (visible_end_at <= occupied_end_at),
  check ((status = 'ACTIVE' and released_at is null) or (status = 'RELEASED' and released_at is not null)),
  unique (business_id, id),
  foreign key (business_id, staff_member_id)
    references team.staff_members(business_id, id) on delete restrict,
  constraint no_overlapping_active_allocations exclude using gist (
    business_id with =,
    staff_member_id with =,
    occupied_range with &&
  ) where (status = 'ACTIVE')
);
create unique index one_active_allocation_per_source
  on availability.resource_allocations(business_id, source_type, source_id)
  where status = 'ACTIVE';
create index resource_allocations_staff_date
  on availability.resource_allocations(business_id, staff_member_id, local_date, status);
create index resource_allocations_source
  on availability.resource_allocations(business_id, source_type, source_id);

create table availability.allocation_service_requirements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  allocation_id uuid not null,
  service_id uuid not null,
  created_at timestamptz not null default now(),
  unique (business_id, allocation_id, service_id),
  foreign key (business_id, allocation_id)
    references availability.resource_allocations(business_id, id) on delete cascade,
  foreign key (business_id, service_id)
    references catalog.services(business_id, id) on delete restrict
);

create table availability.commitment_conflicts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  allocation_id uuid not null,
  reason_code text not null check (length(reason_code) between 1 and 100),
  source_operation_id uuid references system.operation_attempts(operation_id) on delete restrict,
  detected_at timestamptz not null default now(),
  status availability.conflict_status not null default 'OPEN',
  resolved_at timestamptz,
  resolution_reference text,
  check ((status = 'OPEN' and resolved_at is null) or status = 'RESOLVED'),
  unique (business_id, allocation_id, reason_code, source_operation_id),
  foreign key (business_id, allocation_id)
    references availability.resource_allocations(business_id, id) on delete restrict
);
create index commitment_conflicts_open
  on availability.commitment_conflicts(business_id, status, detected_at desc);

revoke all on schema availability from anon, authenticated;
revoke all on all tables in schema availability from anon, authenticated;
revoke all on business.business_hours_configs, business.business_hours_intervals,
  business.business_date_exceptions, business.business_date_exception_intervals,
  business.booking_policy_states, business.booking_policy_versions
  from anon, authenticated;
revoke all on team.staff_date_exceptions, team.staff_date_exception_intervals,
  team.staff_effective_unavailability from anon, authenticated;

grant usage on schema availability to service_role;
grant all on all tables in schema availability to service_role;
grant all on business.business_hours_configs, business.business_hours_intervals,
  business.business_date_exceptions, business.business_date_exception_intervals,
  business.booking_policy_states, business.booking_policy_versions to service_role;
grant all on team.staff_date_exceptions, team.staff_date_exception_intervals,
  team.staff_effective_unavailability to service_role;

alter table business.business_hours_configs enable row level security;
alter table business.business_hours_intervals enable row level security;
alter table business.business_date_exceptions enable row level security;
alter table business.business_date_exception_intervals enable row level security;
alter table business.booking_policy_states enable row level security;
alter table business.booking_policy_versions enable row level security;
alter table team.staff_date_exceptions enable row level security;
alter table team.staff_date_exception_intervals enable row level security;
alter table team.staff_effective_unavailability enable row level security;
alter table availability.business_guards enable row level security;
alter table availability.resource_allocations enable row level security;
alter table availability.allocation_service_requirements enable row level security;
alter table availability.commitment_conflicts enable row level security;
