-- WP-11 / M6 · CAP-08-03 · OPEN_ESTIMATE.
-- ESTA TABLA ES UN CACHÉ DE LECTURA: una estimación NO escribe dinero,
-- NO crea obligaciones y NO genera deuda cerrada (invariante 3 del contrato).

create table econ.estimates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id),
  staff_member_id uuid not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  agreement_version_id uuid,
  terms_hash text,
  source_fingerprint text not null,
  total_payable_minor bigint not null default 0,
  total_receivable_minor bigint not null default 0,
  lines jsonb not null default '[]'::jsonb,
  state text not null default 'NOT_CONFIGURED'
    check (state in ('NOT_CONFIGURED', 'OPEN_ESTIMATE')),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, staff_member_id, period_start, period_end),
  foreign key (business_id, staff_member_id) references team.staff_members(business_id, id)
);

create index estimates_lookup on econ.estimates(business_id, staff_member_id, period_start);

revoke all on table econ.estimates from anon, authenticated;
grant all on table econ.estimates to service_role;
alter table econ.estimates enable row level security;
