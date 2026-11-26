-- D20: linaje únicamente. No backfill, saldo ni ledger adicional.
alter table money.money_components add column refund_of_component_id uuid;
alter table money.money_components add constraint money_components_refund_origin_fk
  foreign key (business_id, refund_of_component_id)
  references money.money_components(business_id, id) on delete restrict;

create table money.refund_attributions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  refund_id uuid not null,
  original_allocation_id uuid,
  amount_minor bigint not null check (amount_minor between 1 and 1000000000),
  foreign key (business_id, refund_id) references money.money_operations(business_id, id) on delete restrict,
  foreign key (business_id, original_allocation_id) references money.money_allocations(business_id, id) on delete restrict,
  unique nulls not distinct (business_id, refund_id, original_allocation_id)
);
comment on column money.refund_attributions.original_allocation_id is
  'NULL declara explícitamente devolución de saldo no asignado; no significa origen desconocido.';
create index refund_attributions_origin on money.refund_attributions(business_id, original_allocation_id);
create index money_components_refund_origin on money.money_components(business_id, refund_of_component_id)
  where refund_of_component_id is not null;
create unique index money_components_one_refund_origin on money.money_components(business_id, money_operation_id, refund_of_component_id)
  where refund_of_component_id is not null;
create trigger guard_refund_attribution_immutability before update or delete on money.refund_attributions
  for each row execute function money.guard_allocation_immutability();

create function money.guard_refund_component_lineage() returns trigger language plpgsql as $$
declare refund money.money_operations; source money.money_components;
begin
  if tg_op = 'UPDATE' then
    if new.refund_of_component_id is distinct from old.refund_of_component_id then
      raise exception 'El linaje del componente es inmutable' using errcode='23514';
    end if;
    return new;
  end if;
  if new.refund_of_component_id is null then return new; end if;
  select * into refund from money.money_operations where business_id=new.business_id and id=new.money_operation_id;
  select * into source from money.money_components where business_id=new.business_id and id=new.refund_of_component_id;
  if refund.kind <> 'REFUND' or source.money_operation_id is distinct from refund.refund_of_id
     or source.outcome <> 'CONFIRMED' or source.method <> new.method or new.outcome <> 'CONFIRMED' then
    raise exception 'El componente devuelto debe conservar origen confirmado y medio real' using errcode='23514';
  end if;
  if length(trim(coalesce(new.evidence_reference,''))) < 3 then
    raise exception 'Toda devolución requiere evidencia del reintegro' using errcode='23514';
  end if;
  if new.method <> 'CASH' and length(trim(coalesce(new.external_reference,''))) < 3 then
    raise exception 'La devolución externa requiere referencia operativa' using errcode='23514';
  end if;
  return new;
end $$;
create trigger guard_refund_component_lineage before insert or update on money.money_components
  for each row execute function money.guard_refund_component_lineage();

-- Sólo INSERT de refunds nuevos: nunca exige inventar linaje para históricos.
create function money.check_new_refund_lineage() returns trigger language plpgsql as $$
declare total bigint;
begin
  if new.kind <> 'REFUND' then return new; end if;
  select coalesce(sum(amount_minor),0) into total from money.refund_attributions
    where business_id=new.business_id and refund_id=new.id;
  if total <> new.amount_minor or exists (
    select 1 from money.refund_attributions a join money.money_allocations o
      on o.business_id=a.business_id and o.id=a.original_allocation_id
    where a.business_id=new.business_id and a.refund_id=new.id and o.money_operation_id<>new.refund_of_id
  ) then
    raise exception 'La devolución requiere distribución exacta sobre el cobro original' using errcode='23514';
  end if;
  select coalesce(sum(amount_minor),0) into total from money.money_components
    where business_id=new.business_id and money_operation_id=new.id and refund_of_component_id is not null;
  if total <> new.amount_minor or exists (select 1 from money.money_components
    where business_id=new.business_id and money_operation_id=new.id and refund_of_component_id is null) then
    raise exception 'La devolución requiere componentes originales explícitos' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger check_new_refund_lineage after insert on money.money_operations
  deferrable initially deferred for each row execute function money.check_new_refund_lineage();

revoke all on money.refund_attributions from public, anon, authenticated;
grant select, insert on money.refund_attributions to service_role;
revoke all on function money.guard_refund_component_lineage() from public, anon, authenticated;
revoke all on function money.check_new_refund_lineage() from public, anon, authenticated;
grant execute on function money.guard_refund_component_lineage() to service_role;
grant execute on function money.check_new_refund_lineage() to service_role;
