-- WP-11 / M7 · CAP-08-04/05/06 · Cierre, fuentes y ajustes.
-- Doble unicidad: por (business, staff, período) Y por fuente global.
-- Payable -> obligación PAYABLE; chair rent -> RECEIVABLE (NO expense).

create table econ.settlements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id),
  staff_member_id uuid not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'CLOSED_SNAPSHOT'
    check (status in ('CLOSED_SNAPSHOT', 'ADJUSTED')),
  currency text not null default 'ARS',
  agreement_version_id uuid,
  terms_hash text not null,
  source_fingerprint text not null,
  total_payable_minor bigint not null,
  total_receivable_minor bigint not null,
  snapshot jsonb not null,
  payable_obligation_id uuid,
  receivable_obligation_id uuid,
  closed_by_account_id uuid not null references iam.user_accounts(id),
  closed_at timestamptz not null default now(),
  operation_id uuid references system.operation_attempts(operation_id),
  unique (business_id, id),
  unique (business_id, staff_member_id, period_start, period_end),
  foreign key (business_id, staff_member_id) references team.staff_members(business_id, id)
);

create table econ.settlement_sources (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  settlement_id uuid not null,
  source_type text not null,
  source_id uuid not null,
  component text not null,
  amount_minor bigint not null,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, source_type, source_id, component),
  foreign key (business_id, settlement_id) references econ.settlements(business_id, id)
);

create table econ.settlement_adjustments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  settlement_id uuid not null,
  amount_minor bigint not null check (amount_minor <> 0),
  reason text not null,
  source_type text,
  source_id uuid,
  created_by_account_id uuid not null references iam.user_accounts(id),
  operation_id uuid references system.operation_attempts(operation_id),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, operation_id),
  foreign key (business_id, settlement_id) references econ.settlements(business_id, id)
);

-- Inmutabilidad del snapshot cerrado: los ajustes son HECHOS NUEVOS.
create or replace function econ.reject_settlement_mutation() returns trigger language plpgsql as $$
begin
  if new.snapshot is distinct from old.snapshot
     or new.total_payable_minor is distinct from old.total_payable_minor
     or new.total_receivable_minor is distinct from old.total_receivable_minor
     or new.terms_hash is distinct from old.terms_hash
     or new.agreement_version_id is distinct from old.agreement_version_id then
    raise exception 'CLOSED_SNAPSHOT is immutable' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists settlement_snapshot_immutable on econ.settlements;
create trigger settlement_snapshot_immutable
  before update on econ.settlements
  for each row execute function econ.reject_settlement_mutation();

create index settlements_lookup on econ.settlements(business_id, staff_member_id, period_start);
create index settlement_sources_lookup on econ.settlement_sources(business_id, settlement_id);

revoke all on all tables in schema econ from anon, authenticated;
grant all on all tables in schema econ to service_role;
alter table econ.settlements enable row level security;
alter table econ.settlement_sources enable row level security;
alter table econ.settlement_adjustments enable row level security;
revoke all on function econ.reject_settlement_mutation() from public, anon, authenticated;
grant execute on function econ.reject_settlement_mutation() to service_role;
