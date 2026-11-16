-- H04: whole-unit, append-only inventory. No financial effects or Orders.
create schema inventory;
alter table system.operation_attempts add constraint operation_business_identity unique (business_id, operation_id);

create table inventory.items (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references business.businesses(id),
 sku text not null check (sku ~ '^[A-Z0-9._-]{1,64}$'), name text not null check(length(trim(name)) between 1 and 120),
 description text not null default '', category text not null default '',
 use text not null check(use in ('SALE','INTERNAL','MIXED')), unit text not null default 'unidad' check(unit='unidad'),
 parent_id uuid, active boolean not null default true, published boolean not null default false,
 price_minor integer check(price_minor between 1 and 1000000000), cost_minor integer check(cost_minor between 0 and 1000000000), image_url text,
 revision bigint not null default 1 check(revision between 1 and 9007199254740991), created_at timestamptz not null default now(),
 unique(business_id,id), unique(business_id,sku), foreign key(business_id,parent_id) references inventory.items(business_id,id),
 check(parent_id is distinct from id), check(use='INTERNAL' or price_minor is not null), check(not published or (active and use<>'INTERNAL'))
);
create table inventory.locations (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references business.businesses(id), name text not null check(length(trim(name)) between 1 and 100),
 staff_member_id uuid, active boolean not null default true, revision bigint not null default 1 check(revision>0),
 unique(business_id,id), unique(business_id,name), foreign key(business_id,staff_member_id) references team.staff_members(business_id,id)
);
-- Optional access to another professional's position is explicit, never inferred from inventory.read.
create table inventory.location_access (
 business_id uuid not null, location_id uuid not null, staff_member_id uuid not null,
 primary key(business_id,location_id,staff_member_id),
 foreign key(business_id,location_id) references inventory.locations(business_id,id),
 foreign key(business_id,staff_member_id) references team.staff_members(business_id,id)
);
create table inventory.movements (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references business.businesses(id),
 kind text not null check(kind in ('OPENING','RECEIPT','CONSUMPTION','LOSS','RETURN','TRANSFER','REALLOCATE','ISSUE','ADJUSTMENT','CORRECTION','DELIVERY')),
 operation_id uuid not null, actor_account_id uuid not null references iam.user_accounts(id),
 reason text not null check(length(trim(reason)) between 3 and 1000), effective_at timestamptz not null,
 created_at timestamptz not null default now(), source_reference text, corrects_id uuid,
 discrepancy boolean not null default false, unique(business_id,id), unique(operation_id),
 unique(business_id,id,operation_id), unique(corrects_id),
 foreign key(business_id,operation_id) references system.operation_attempts(business_id,operation_id),
 foreign key(business_id,corrects_id) references inventory.movements(business_id,id),
 check((kind='CORRECTION')=(corrects_id is not null))
);
create table inventory.entries (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, movement_id uuid not null,
 sku text not null, location_id uuid not null, purpose text not null check(purpose in ('SALE','INTERNAL')),
 delta integer not null check(delta<>0 and delta between -1000000000 and 1000000000),
 position_version bigint not null check(position_version>0),
 foreign key(business_id,movement_id) references inventory.movements(business_id,id),
 foreign key(business_id,sku) references inventory.items(business_id,sku),
 foreign key(business_id,location_id) references inventory.locations(business_id,id),
 unique(business_id,sku,location_id,purpose,position_version)
);
create index inventory_entry_history on inventory.entries(business_id,sku,movement_id);
-- Purpose is an independent partition of the physical position; SUM partitions = total.
create table inventory.positions (
 business_id uuid not null, sku text not null, location_id uuid not null, purpose text not null check(purpose in ('SALE','INTERNAL')),
 physical integer not null default 0 check(physical between -1000000000 and 1000000000),
 version bigint not null default 0 check(version between 0 and 9007199254740991),
 primary key(business_id,sku,location_id,purpose),
 foreign key(business_id,sku) references inventory.items(business_id,sku),
 foreign key(business_id,location_id) references inventory.locations(business_id,id)
);
create table inventory.consumptions (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, movement_id uuid not null unique, operation_id uuid not null unique,
 attendance_id uuid, attendance_revision bigint, used_by_staff_member_id uuid not null,
 unique(business_id,id),
 foreign key(business_id,movement_id,operation_id) references inventory.movements(business_id,id,operation_id),
 foreign key(business_id,attendance_id) references attendance.attendances(business_id,id),
 foreign key(business_id,used_by_staff_member_id) references team.staff_members(business_id,id),
 check((attendance_id is null)=(attendance_revision is null))
);
create table inventory.counts (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, sku text not null, location_id uuid not null,
 purpose text not null check(purpose in ('SALE','INTERNAL')), observed integer not null check(observed between 0 and 1000000000),
 reference_quantity integer not null, reference_version bigint not null check(reference_version>=0),
 observed_at timestamptz not null, created_at timestamptz not null default now(),
 actor_account_id uuid not null references iam.user_accounts(id), operation_id uuid not null unique,
 reason text not null check(length(trim(reason))>=3), previous_count_id uuid,
 unique(business_id,id), foreign key(business_id,sku) references inventory.items(business_id,sku),
 foreign key(business_id,location_id) references inventory.locations(business_id,id),
 foreign key(business_id,operation_id) references system.operation_attempts(business_id,operation_id),
 foreign key(business_id,previous_count_id) references inventory.counts(business_id,id)
);
create table inventory.adjustments (
 business_id uuid not null, count_id uuid primary key, movement_id uuid unique, operation_id uuid not null unique,
 foreign key(business_id,count_id) references inventory.counts(business_id,id),
 foreign key(business_id,movement_id,operation_id) references inventory.movements(business_id,id,operation_id),
 foreign key(business_id,operation_id) references system.operation_attempts(business_id,operation_id)
);
create table inventory.minimums (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, sku text not null, location_id uuid,
 quantity integer not null check(quantity between 0 and 1000000000), revision bigint not null default 1,
 foreign key(business_id,sku) references inventory.items(business_id,sku),
 foreign key(business_id,location_id) references inventory.locations(business_id,id),
 unique nulls not distinct(business_id,sku,location_id)
);
-- Internal H05/H06 primitives. No public confirm/deliver endpoints.
create table inventory.commitments (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, source_reference text not null,
 sku text not null, location_id uuid not null, quantity integer not null check(quantity between 1 and 1000000000),
 state text not null default 'ACTIVE' check(state in ('ACTIVE','RELEASED','DELIVERED')),
 revision bigint not null default 1, operation_id uuid not null unique, delivery_movement_id uuid unique,
 unique(business_id,id), unique(business_id,source_reference,sku,location_id),
 foreign key(business_id,sku) references inventory.items(business_id,sku),
 foreign key(business_id,location_id) references inventory.locations(business_id,id),
 foreign key(business_id,operation_id) references system.operation_attempts(business_id,operation_id),
 foreign key(business_id,delivery_movement_id) references inventory.movements(business_id,id),
 check((state='DELIVERED')=(delivery_movement_id is not null))
);
create index inventory_active_commitments on inventory.commitments(business_id,sku,location_id) where state='ACTIVE';
create index inventory_movements_recent on inventory.movements(business_id,created_at desc,id desc);

create function inventory.immutable() returns trigger language plpgsql as $$
begin raise exception 'Inventory history is append-only' using errcode='23514'; end $$;
create trigger immutable_movements before update or delete on inventory.movements for each row execute function inventory.immutable();
create trigger immutable_entries before update or delete on inventory.entries for each row execute function inventory.immutable();
create trigger immutable_consumptions before update or delete on inventory.consumptions for each row execute function inventory.immutable();
create trigger immutable_counts before update or delete on inventory.counts for each row execute function inventory.immutable();
create trigger immutable_adjustments before update or delete on inventory.adjustments for each row execute function inventory.immutable();

create function inventory.project_entry() returns trigger language plpgsql as $$
declare p inventory.positions; item_use text; op_status text;
begin
 -- Same lock as application commands; covers direct SQL and missing positions.
 perform pg_advisory_xact_lock(hashtextextended(new.business_id::text,404));
 select use into item_use from inventory.items where business_id=new.business_id and sku=new.sku;
 if (item_use='SALE' and new.purpose<>'SALE') or (item_use='INTERNAL' and new.purpose<>'INTERNAL') then
   raise exception 'Invalid use partition' using errcode='23514';
 end if;
 select o.status::text into op_status from inventory.movements m join system.operation_attempts o on o.operation_id=m.operation_id where m.id=new.movement_id;
 if op_status<>'STARTED' then raise exception 'Cannot append to a completed operation' using errcode='23514'; end if;
 insert into inventory.positions(business_id,sku,location_id,purpose) values(new.business_id,new.sku,new.location_id,new.purpose) on conflict do nothing;
 select * into p from inventory.positions where business_id=new.business_id and sku=new.sku and location_id=new.location_id and purpose=new.purpose for update;
 if new.position_version<>p.version+1 then raise exception 'Stale position version' using errcode='23514'; end if;
 update inventory.positions set physical=physical+new.delta,version=version+1 where business_id=new.business_id and sku=new.sku and location_id=new.location_id and purpose=new.purpose;
 return new;
end $$;
create trigger project_entry before insert on inventory.entries for each row execute function inventory.project_entry();
create function inventory.guard_projection() returns trigger language plpgsql as $$
begin
 if pg_trigger_depth()<2 then raise exception 'Positions are projections of entries' using errcode='23514'; end if;
 return coalesce(new,old);
end $$;
create trigger guard_projection before insert or update or delete on inventory.positions for each row execute function inventory.guard_projection();

-- Deferred validation sees the complete atomic event, including consumption/adjustment links.
create function inventory.validate_movement() returns trigger language plpgsql as $$
declare m inventory.movements; n integer; total bigint; invalid boolean;
begin
 select * into m from inventory.movements where id=new.id;
 select count(*),sum(delta) into n,total from inventory.entries where movement_id=m.id;
 if n=0 then raise exception 'Movement requires physical entries' using errcode='23514'; end if;
 if m.kind in ('TRANSFER','REALLOCATE') then
   if n<>2 or total<>0 then raise exception 'Transfer must conserve physical total' using errcode='23514'; end if;
   select count(distinct sku)<>1 or count(distinct location_id)<>(case when m.kind='TRANSFER' then 2 else 1 end)
     or count(distinct purpose)<>(case when m.kind='REALLOCATE' then 2 else 1 end) into invalid from inventory.entries where movement_id=m.id;
   if invalid then raise exception 'Invalid transfer dimensions' using errcode='23514'; end if;
 end if;
 if m.kind in ('OPENING','RECEIPT','RETURN') and exists(select 1 from inventory.entries where movement_id=m.id and delta<0) then raise exception 'Inbound sign' using errcode='23514'; end if;
 if m.kind in ('CONSUMPTION','LOSS','ISSUE','DELIVERY') and exists(select 1 from inventory.entries where movement_id=m.id and delta>0) then raise exception 'Outbound sign' using errcode='23514'; end if;
 if m.kind='CONSUMPTION' and (n<>1 or not exists(select 1 from inventory.consumptions where movement_id=m.id)) then raise exception 'Consumption requires exactly one physical effect and reference' using errcode='23514'; end if;
 if m.kind='CORRECTION' and exists(
   (select sku,location_id,purpose,-sum(delta) d from inventory.entries where movement_id=m.corrects_id group by sku,location_id,purpose
    except select sku,location_id,purpose,sum(delta) from inventory.entries where movement_id=m.id group by sku,location_id,purpose)
   union all
   (select sku,location_id,purpose,sum(delta) from inventory.entries where movement_id=m.id group by sku,location_id,purpose
    except select sku,location_id,purpose,-sum(delta) from inventory.entries where movement_id=m.corrects_id group by sku,location_id,purpose)
 ) then raise exception 'Correction must compensate original' using errcode='23514'; end if;
 if not exists(select 1 from system.operation_attempts where operation_id=m.operation_id and status='SUCCEEDED' and actor_account_id=m.actor_account_id) then raise exception 'Movement requires confirmed matching operation' using errcode='23514'; end if;
 if not exists(select 1 from system.audit_events where operation_id=m.operation_id and business_id=m.business_id) then raise exception 'Movement requires audit' using errcode='23514'; end if;
 return null;
end $$;
create constraint trigger validate_movement after insert on inventory.movements deferrable initially deferred for each row execute function inventory.validate_movement();
create function inventory.validate_consumption() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from inventory.movements where id=new.movement_id and kind='CONSUMPTION') then raise exception 'Invalid consumption movement' using errcode='23514'; end if;
 if new.attendance_id is not null and not exists(select 1 from attendance.attendances where business_id=new.business_id and id=new.attendance_id and status in ('COMPLETED','PARTIAL','INTERRUPTED') and attended_by_staff_member_id=new.used_by_staff_member_id and revision=new.attendance_revision) then raise exception 'Invalid attendance reference' using errcode='23514'; end if;
 return null;
end $$;
create constraint trigger validate_consumption after insert on inventory.consumptions deferrable initially deferred for each row execute function inventory.validate_consumption();

create view inventory.reconstructed_positions as
 select business_id,sku,location_id,purpose,sum(delta)::bigint physical,max(position_version) version
 from inventory.entries group by business_id,sku,location_id,purpose;
revoke all on schema inventory from public,anon,authenticated;
revoke all on all tables in schema inventory from public,anon,authenticated;
revoke all on all functions in schema inventory from public,anon,authenticated;
grant usage on schema inventory to service_role;
grant select,insert,update,delete on all tables in schema inventory to service_role;
grant execute on all functions in schema inventory to service_role;
