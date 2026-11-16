-- Guards for causal integrity even when callers bypass the HTTP/domain layer.
create function inventory.validate_physical_event() returns trigger language plpgsql as $$
declare e record; prior integer;
begin
 for e in select en.*,p.physical from inventory.entries en join inventory.positions p using(business_id,sku,location_id,purpose) where en.movement_id=new.id loop
   if new.kind='OPENING' then
     select count(*) into prior from inventory.entries where business_id=e.business_id and sku=e.sku and location_id=e.location_id and purpose=e.purpose and position_version<e.position_version;
     if prior<>0 then raise exception 'Opening requires a position without history' using errcode='23514'; end if;
   end if;
   if new.kind in ('CONSUMPTION','LOSS') and e.physical<0 and not new.discrepancy then raise exception 'Negative physical fact requires discrepancy' using errcode='23514'; end if;
   if new.kind in ('TRANSFER','REALLOCATE','ISSUE','DELIVERY') and e.delta<0 and e.physical<0 then raise exception 'Insufficient physical stock' using errcode='23514'; end if;
 end loop;
 if new.kind='RETURN' and new.source_reference is null then raise exception 'Physical return requires causal reference' using errcode='23514'; end if;
 if new.kind='ADJUSTMENT' and not exists(select 1 from inventory.adjustments where movement_id=new.id) then raise exception 'Adjustment requires a count' using errcode='23514'; end if;
 if new.kind='DELIVERY' and not exists(select 1 from inventory.commitments where delivery_movement_id=new.id and state='DELIVERED') then raise exception 'Delivery requires its commitment' using errcode='23514'; end if;
 return null;
end $$;
create constraint trigger validate_physical_event after insert on inventory.movements deferrable initially deferred for each row execute function inventory.validate_physical_event();

create function inventory.validate_adjustment() returns trigger language plpgsql as $$
declare c inventory.counts; count_delta bigint;
begin
 select * into c from inventory.counts where business_id=new.business_id and id=new.count_id;
 count_delta=c.observed-c.reference_quantity;
 if (count_delta=0)<>(new.movement_id is null) then raise exception 'Adjustment effect must match count difference' using errcode='23514'; end if;
 if count_delta<>0 and not exists(select 1 from inventory.movements m join inventory.entries e on e.movement_id=m.id where m.id=new.movement_id and m.kind='ADJUSTMENT' and m.source_reference=c.id::text and e.sku=c.sku and e.location_id=c.location_id and e.purpose=c.purpose and e.delta=count_delta and e.position_version=c.reference_version+1) then raise exception 'Adjustment must use the observed position and version' using errcode='23514'; end if;
 return null;
end $$;
create constraint trigger validate_adjustment after insert on inventory.adjustments deferrable initially deferred for each row execute function inventory.validate_adjustment();

create function inventory.guard_count() returns trigger language plpgsql as $$
declare p inventory.positions;
begin
 perform pg_advisory_xact_lock(hashtextextended(new.business_id::text,404));
 select * into p from inventory.positions where business_id=new.business_id and sku=new.sku and location_id=new.location_id and purpose=new.purpose;
 if new.reference_version<>coalesce(p.version,0) or new.reference_quantity<>coalesce(p.physical,0) then raise exception 'Count reference must match current position' using errcode='23514'; end if;
 return new;
end $$;
create trigger guard_count before insert on inventory.counts for each row execute function inventory.guard_count();

create function inventory.guard_commitment() returns trigger language plpgsql as $$
declare physical_units bigint; reserved_units bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended(new.business_id::text,404));
 if tg_op='UPDATE' then
   if old.state in ('RELEASED','DELIVERED') and new.state='ACTIVE' then raise exception 'Terminal commitment cannot reactivate' using errcode='23514'; end if;
   if old.state='DELIVERED' and new is distinct from old then raise exception 'Delivered commitment is immutable' using errcode='23514'; end if;
   if (new.business_id,new.sku,new.location_id,new.quantity,new.source_reference,new.operation_id) is distinct from (old.business_id,old.sku,old.location_id,old.quantity,old.source_reference,old.operation_id) then raise exception 'Commitment identity is immutable' using errcode='23514'; end if;
 end if;
 if new.state='ACTIVE' and tg_op='INSERT' then
   select coalesce(sum(physical),0) into physical_units from inventory.positions where business_id=new.business_id and sku=new.sku and location_id=new.location_id and purpose='SALE';
   select coalesce(sum(quantity),0) into reserved_units from inventory.commitments where business_id=new.business_id and sku=new.sku and location_id=new.location_id and state='ACTIVE';
   if physical_units-reserved_units<new.quantity then raise exception 'Insufficient sellable stock' using errcode='23514'; end if;
 end if;
 return new;
end $$;
create trigger guard_commitment before insert or update on inventory.commitments for each row execute function inventory.guard_commitment();

-- Prevent destructive shortcuts that row-level immutable triggers do not cover.
create trigger no_truncate_movements before truncate on inventory.movements execute function inventory.immutable();
create trigger no_truncate_entries before truncate on inventory.entries execute function inventory.immutable();
create trigger no_truncate_positions before truncate on inventory.positions execute function inventory.immutable();
create trigger no_truncate_counts before truncate on inventory.counts execute function inventory.immutable();
create trigger no_truncate_consumptions before truncate on inventory.consumptions execute function inventory.immutable();
create trigger no_truncate_adjustments before truncate on inventory.adjustments execute function inventory.immutable();
revoke all on all functions in schema inventory from public,anon,authenticated;
grant execute on all functions in schema inventory to service_role;
