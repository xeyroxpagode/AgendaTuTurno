-- One idempotent order operation may reserve/deliver several stock lines.
alter table inventory.commitments drop constraint commitments_operation_id_key;
alter table inventory.commitments drop constraint commitments_delivery_movement_id_key;
create function inventory.guard_item_dimensions() returns trigger language plpgsql as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.business_id::text,404));
 if tg_op='UPDATE' then
   if (new.business_id,new.id,new.sku,new.parent_id,new.unit) is distinct from (old.business_id,old.id,old.sku,old.parent_id,old.unit) then raise exception 'Item stock identity is immutable' using errcode='23514'; end if;
   if new.use<>'MIXED' and exists(select 1 from inventory.positions where business_id=new.business_id and sku=new.sku and purpose<>new.use and physical<>0) then raise exception 'Reallocate physical partitions before changing item use' using errcode='23514'; end if;
 end if;
 return new;
end $$;
create trigger guard_item_dimensions before update on inventory.items for each row execute function inventory.guard_item_dimensions();
revoke all on function inventory.guard_item_dimensions() from public,anon,authenticated;
grant execute on function inventory.guard_item_dimensions() to service_role;
