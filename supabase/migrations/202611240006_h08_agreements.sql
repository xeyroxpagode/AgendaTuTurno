-- WP-11 / M5 · CAP-08-01 · Acuerdos económicos versionados.
-- Las tasas NO son universales: cada versión las declara explícitamente.
-- Un acuerdo NO concede permisos de seguridad (B-01..B-03).

create schema if not exists econ;

create table econ.agreements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id),
  staff_member_id uuid not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CANCELLED')),
  created_by_account_id uuid not null references iam.user_accounts(id),
  operation_id uuid references system.operation_attempts(operation_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, staff_member_id) references team.staff_members(business_id, id)
);

create table econ.agreement_versions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  agreement_id uuid not null,
  version integer not null check (version > 0),
  modality text not null check (modality in ('COMMISSION', 'FIXED', 'CHAIR_RENT', 'MIXED')),
  -- Base explícita. NULL indica acuerdo incompleto -> NOT_CONFIGURED (CL-08).
  commission_base text check (commission_base in ('REALIZED', 'COLLECTED')),
  bps integer check (bps is null or (bps between 0 and 10000)),
  fixed_amount_minor bigint,
  rent_amount_minor bigint,
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  terms_hash text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CANCELLED')),
  created_by_account_id uuid not null references iam.user_accounts(id),
  operation_id uuid references system.operation_attempts(operation_id),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (agreement_id, version),
  check (valid_to > valid_from),
  check (fixed_amount_minor is null or fixed_amount_minor >= 0),
  check (rent_amount_minor is null or rent_amount_minor >= 0),
  foreign key (business_id, agreement_id) references econ.agreements(business_id, id)
);

-- CL-07: sin superposición de vigencias -> sin devengo retroactivo ambiguo.
alter table econ.agreement_versions
  add constraint agreement_versions_no_overlap
  exclude using gist (agreement_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
  where (status = 'ACTIVE');

create index agreement_versions_effective_lookup
  on econ.agreement_versions(business_id, agreement_id, valid_from, valid_to);

revoke all on schema econ from anon, authenticated;
grant usage on schema econ to service_role;
revoke all on all tables in schema econ from anon, authenticated;
grant all on all tables in schema econ to service_role;
alter table econ.agreements enable row level security;
alter table econ.agreement_versions enable row level security;
