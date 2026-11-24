-- WP-11 / M9 · Refuerzo de invariantes H08 (hallazgos EGM P1/P2).

-- Un único acuerdo ACTIVO por (business, staff). Evita dos versiones vigentes
-- que duplicarían una línea de venta y bloquearían el cierre por fuente única.
create unique index if not exists one_active_agreement_per_staff
  on econ.agreements(business_id, staff_member_id) where status = 'ACTIVE';

-- Períodos de liquidación NO pueden traslaparse. La unicidad por fuente no
-- basta: un período sin líneas duplicaría FIXED/RENT.
alter table econ.settlements
  add constraint settlements_period_no_overlap
  exclude using gist (
    business_id with =,
    staff_member_id with =,
    tstzrange(period_start, period_end, '[)') with &&
  );

-- Inmutabilidad completa del snapshot: sólo se permite mutar la lista blanca
-- de campos operativos (ids de obligación y estado del ciclo de vida).
create or replace function econ.reject_settlement_mutation() returns trigger language plpgsql as $$
begin
  if new.snapshot is distinct from old.snapshot
     or new.total_payable_minor is distinct from old.total_payable_minor
     or new.total_receivable_minor is distinct from old.total_receivable_minor
     or new.terms_hash is distinct from old.terms_hash
     or new.agreement_version_id is distinct from old.agreement_version_id
     or new.source_fingerprint is distinct from old.source_fingerprint
     or new.currency is distinct from old.currency
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.closed_at is distinct from old.closed_at
     or new.closed_by_account_id is distinct from old.closed_by_account_id
     or new.operation_id is distinct from old.operation_id then
    raise exception 'CLOSED_SNAPSHOT is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
