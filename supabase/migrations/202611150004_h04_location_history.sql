-- A location's historical physical attribution cannot be relabelled after use.
-- A new attribution uses a new location identity; old movements remain truthful.
create function inventory.guard_location_history() returns trigger language plpgsql as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(old.business_id::text,404));
 if (new.business_id,new.id) is distinct from (old.business_id,old.id) then raise exception 'Location identity is immutable' using errcode='23514'; end if;
 if new.staff_member_id is distinct from old.staff_member_id and exists(select 1 from inventory.entries where business_id=old.business_id and location_id=old.id) then raise exception 'Historical physical attribution is immutable' using errcode='23514'; end if;
 return new;
end $$;
create trigger guard_location_history before update on inventory.locations for each row execute function inventory.guard_location_history();
revoke all on function inventory.guard_location_history() from public,anon,authenticated;
grant execute on function inventory.guard_location_history() to service_role;
