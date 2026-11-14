import { randomUUID } from "node:crypto";
import { beforeAll,describe,expect,it } from "vitest";
import { database } from "../../../apps/api/src/lib/runtime";
import { claimAllocationOperation,quoteAllocation,releaseAllocation } from "../../../apps/api/src/modules/availability/allocation";
import { resolveSlot,searchAvailability } from "../../../apps/api/src/modules/availability/queries";
import { getBookingPolicyHistory,removeBusinessDateException,replaceBookingPolicy,replaceBusinessDateException,replaceBusinessHours } from "../../../apps/api/src/modules/availability/configuration";
import { applyEffectiveUnavailability,releaseEffectiveUnavailability } from "../../../apps/api/src/modules/availability/unavailability";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization";
import { replaceWeeklySchedule } from "../../../apps/api/src/modules/schedules/commands";
import { replaceStaffServices } from "../../../apps/api/src/modules/staff-services/commands";
import { lifecycle } from "../../../apps/api/src/modules/team/service";
import { claimReservationWithBooking, cancelReservationWithBooking, replaceReservationWithBooking, seedConfirmedReservationWithAllocation } from "./reservation-fixtures";

const ids={business:randomUUID(),person:randomUUID(),account:randomUUID(),staffA:randomUUID(),staffB:randomUUID(),category:randomUUID(),serviceCut:randomUUID(),termsCut:randomUUID(),serviceBeard:randomUUID(),termsBeard:randomUUID()};
const now=new Date("2026-11-04T12:00:00.000Z");
const actor:Actor={accountId:ids.account,personId:ids.person,businessId:ids.business,staffMemberId:ids.staffA,accessSessionId:randomUUID(),roleAssignmentId:randomUUID(),role:"OWNER",contextRevision:1,capabilities:new Set(["availability.manage"]),email:"u03@example.test"};

beforeAll(async()=>{
  await database.client.begin(async tx=>{
    await tx`insert into business.businesses(id,provisioning_key,display_name,timezone,status) values (${ids.business},${`u03-${ids.business}`},'U03 Integration','America/Argentina/Buenos_Aires','ACTIVE')`;
    await tx`insert into iam.persons(id,first_name) values (${ids.person},'Availability Owner')`;
    await tx`insert into iam.user_accounts(id,person_id,status) values (${ids.account},${ids.person},'ACTIVE')`;
    const personB=randomUUID();await tx`insert into iam.persons(id,first_name) values (${personB},'Availability B')`;
    await tx`insert into team.staff_members(id,business_id,person_id,employment_status,access_status) values (${ids.staffA},${ids.business},${ids.person},'ACTIVE','ACTIVE'),(${ids.staffB},${ids.business},${personB},'ACTIVE','ACTIVE')`;
    const category=await tx`insert into catalog.service_categories(id,business_id,name) values (${ids.category},${ids.business},'U03 Services') returning id`;
    await tx`insert into catalog.services(id,business_id,name,category_id,publication) values (${ids.serviceCut},${ids.business},'Cut',${category[0]!.id},'PUBLISHED'),(${ids.serviceBeard},${ids.business},'Beard',${category[0]!.id},'PUBLISHED')`;
    await tx`insert into catalog.service_terms_versions(id,business_id,service_id,version_number,price_minor,currency,duration_minutes,pre_buffer_minutes,post_buffer_minutes) values (${ids.termsCut},${ids.business},${ids.serviceCut},1,1000,'ARS',30,5,5),(${ids.termsBeard},${ids.business},${ids.serviceBeard},1,500,'ARS',20,5,5)`;
    await tx`update catalog.services set current_terms_version_id=${ids.termsCut} where id=${ids.serviceCut}`;await tx`update catalog.services set current_terms_version_id=${ids.termsBeard} where id=${ids.serviceBeard}`;
    const setA=(await tx`insert into team.staff_service_sets(business_id,staff_member_id) values (${ids.business},${ids.staffA}) returning id`)[0]!.id;const setB=(await tx`insert into team.staff_service_sets(business_id,staff_member_id) values (${ids.business},${ids.staffB}) returning id`)[0]!.id;
    for(const service of[ids.serviceCut,ids.serviceBeard])await tx`insert into team.staff_service_assignments(business_id,staff_service_set_id,service_id) values (${ids.business},${setA},${service})`;
    await tx`insert into team.staff_service_assignments(business_id,staff_service_set_id,service_id) values (${ids.business},${setB},${ids.serviceCut})`;
    const scheduleA=(await tx`insert into team.staff_weekly_schedules(business_id,staff_member_id) values (${ids.business},${ids.staffA}) returning id`)[0]!.id;const scheduleB=(await tx`insert into team.staff_weekly_schedules(business_id,staff_member_id) values (${ids.business},${ids.staffB}) returning id`)[0]!.id;
    await tx`insert into team.staff_schedule_intervals(business_id,weekly_schedule_id,weekday,start_minute,end_minute) values (${ids.business},${scheduleA},3,540,1080),(${ids.business},${scheduleB},3,540,1200)`;
    const hours=(await tx`insert into business.business_hours_configs(business_id) values (${ids.business}) returning id`)[0]!.id;await tx`insert into business.business_hours_intervals(business_id,config_id,weekday,start_minute,end_minute) values (${ids.business},${hours},3,600,1200)`;
    const version=(await tx`insert into business.booking_policy_versions(business_id,version_number,public_booking_enabled,horizon_calendar_dates,min_lead_minutes,start_step_minutes,cancel_cutoff_minutes,reschedule_cutoff_minutes,created_by) values (${ids.business},1,true,30,0,30,120,120,${ids.account}) returning id`)[0]!.id;await tx`insert into business.booking_policy_states(business_id,current_version_id) values (${ids.business},${version})`;
  });
});

describe("H03.U03 PostgreSQL integration",()=>{
  it("fails closed when public Booking Policy is absent",async()=>{const business=randomUUID();await database.client`insert into business.businesses(id,provisioning_key,display_name,timezone,status) values (${business},${`missing-${business}`},'Missing policy','UTC','ACTIVE')`;await expect(searchAvailability(business,{serviceIds:[ids.serviceCut],fromDate:'2026-11-04',throughDate:'2026-11-04',professionalPreference:{type:'ANY'}},now)).rejects.toMatchObject({code:'BOOKING_POLICY_MISSING'});});

  it("intersects Business/Staff and preserves multiservice buffers",async()=>{const result=await searchAvailability(ids.business,{serviceIds:[ids.serviceCut,ids.serviceBeard],fromDate:'2026-11-04',throughDate:'2026-11-04',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now);const starts=result.days[0]!.slots.map(slot=>new Date(slot.start).toISOString());expect(starts).not.toContain('2026-11-04T13:00:00.000Z');expect(starts).toContain('2026-11-04T13:30:00.000Z');expect(result.days[0]!.slots.find(slot=>slot.start==='2026-11-04T13:30:00.000Z')).toMatchObject({occupiedMinutes:70,visibleMinutes:60});});

  it("Quote is repeatable and performs no allocation write",async()=>{const source=randomUUID();const before=Number((await database.client`select count(*) count from availability.resource_allocations where business_id=${ids.business}`)[0]!.count);await database.client.begin(tx=>quoteAllocation(tx,{businessId:ids.business,sourceType:'RESERVATION',sourceId:source,serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStart:'11:00',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now));await database.client.begin(tx=>quoteAllocation(tx,{businessId:ids.business,sourceType:'RESERVATION',sourceId:source,serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStart:'11:00',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now));const after=Number((await database.client`select count(*) count from availability.resource_allocations where business_id=${ids.business}`)[0]!.count);expect(after).toBe(before);});

  it("keeps Business Hours no-op semantic and operation idempotency",async()=>{const operationId=randomUUID();const week={MONDAY:[],TUESDAY:[],WEDNESDAY:[{start:'10:00',end:'20:00'}],THURSDAY:[],FRIDAY:[],SATURDAY:[],SUNDAY:[]};const first=await replaceBusinessHours(actor,{expectedRevision:1,week},operationId);const retry=await replaceBusinessHours(actor,{expectedRevision:1,week},operationId);expect(first).toMatchObject({replayed:false,data:{revision:1,changed:false}});expect(retry).toMatchObject({replayed:true,data:{revision:1,changed:false}});await expect(replaceBusinessHours(actor,{expectedRevision:1,week:{...week,WEDNESDAY:[{start:'10:00',end:'19:00'}]}},operationId)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});});

  it("versions Booking Policy prospectively and preserves immutable history",async()=>{const result=await replaceBookingPolicy(actor,{expectedRevision:1,publicBookingEnabled:true,horizonCalendarDates:30,minLeadMinutes:0,startStepMinutes:30,cancelCutoffMinutes:121,rescheduleCutoffMinutes:120},randomUUID());expect(result.data).toMatchObject({revision:2,versionNumber:2,changed:true});const history=await getBookingPolicyHistory(actor);expect(history.map(item=>item.versionNumber)).toEqual([2,1]);await expect(database.client`update business.booking_policy_versions set cancel_cutoff_minutes=999 where id=${history[0]!.id}`).rejects.toMatchObject({code:'55000'});});

  it("balances ANY by exact confirmed minutes / effective capacity",async()=>{for(const staffId of[ids.staffA,ids.staffB])await seedConfirmedReservationWithAllocation({businessId:ids.business,staffMemberId:staffId,sourceId:randomUUID(),localDate:'2026-11-04',visibleStartAt:'2026-11-04T22:00Z',visibleEndAt:'2026-11-05T00:00Z',occupiedStartAt:'2026-11-04T22:00Z',occupiedEndAt:'2026-11-05T00:00Z'});const resolved=await resolveSlot(database.client,{businessId:ids.business,serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStartMinute:660,professionalPreference:{type:'ANY'},requirePublic:true,now});expect(resolved.staffMemberId).toBe(ids.staffB);});

  it("replays the same Claim operation and rejects a changed payload",async()=>{const operationId=randomUUID();const input={businessId:ids.business,sourceType:'OPERATIONAL_BLOCK' as const,sourceId:randomUUID(),serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStart:'11:30',professionalPreference:{type:'SPECIFIC' as const,staffMemberId:ids.staffA}};const first=await claimAllocationOperation(actor,input,operationId,now);const retry=await claimAllocationOperation(actor,input,operationId,now);expect(first.replayed).toBe(false);expect(retry.replayed).toBe(true);await expect(claimAllocationOperation(actor,{...input,visibleStart:'12:30'},operationId,now)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});});

  it("serializes two concurrent Claims and confirms at most one",async()=>{const claim=(sourceId:string)=>database.client.begin(tx=>claimReservationWithBooking(tx,{businessId:ids.business,sourceType:'RESERVATION',sourceId,serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStart:'12:30',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now));const outcomes=await Promise.allSettled([claim(randomUUID()),claim(randomUUID())]);expect(outcomes.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(item=>item.status==='rejected')).toHaveLength(1);});

  it("allows distinct professionals at the same time",async()=>{const a=database.client.begin(tx=>claimReservationWithBooking(tx,{businessId:ids.business,sourceType:'RESERVATION',sourceId:randomUUID(),serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStart:'14:00',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now));const b=database.client.begin(tx=>claimReservationWithBooking(tx,{businessId:ids.business,sourceType:'RESERVATION',sourceId:randomUUID(),serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStart:'14:00',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffB}},now));await expect(Promise.all([a,b])).resolves.toHaveLength(2);});

  it("Replace preserves the origin on failure and swaps atomically on success",async()=>{const sourceId=randomUUID();const origin=await database.client.begin(tx=>claimReservationWithBooking(tx,{businessId:ids.business,sourceType:'RESERVATION',sourceId,serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStart:'16:00',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now));const blocker=randomUUID();await database.client`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${ids.business},${ids.staffA},'OPERATIONAL_BLOCK',${blocker},'2026-11-04','2026-11-04T20:00Z','2026-11-04T20:30Z','2026-11-04T20:00Z','2026-11-04T20:30Z')`;await expect(database.client.begin(tx=>replaceReservationWithBooking(tx,{origin:{businessId:ids.business,sourceType:'RESERVATION',sourceId},destination:{businessId:ids.business,sourceType:'RESERVATION',sourceId,serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStart:'17:00',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},releaseReason:'failed move'},now))).rejects.toMatchObject({code:'SLOT_CONFLICT'});expect((await database.client`select status::text status from availability.resource_allocations where id=${origin.allocationId}`)[0]!.status).toBe('ACTIVE');await database.client.begin(tx=>releaseAllocation(tx,{businessId:ids.business,sourceType:'OPERATIONAL_BLOCK',sourceId:blocker,reason:'clear blocker'}));const moved=await database.client.begin(tx=>replaceReservationWithBooking(tx,{origin:{businessId:ids.business,sourceType:'RESERVATION',sourceId},destination:{businessId:ids.business,sourceType:'RESERVATION',sourceId,serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStart:'17:00',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},releaseReason:'valid move'},now));expect(moved.originAllocationId).toBe(origin.allocationId);expect((await database.client`select status::text status from availability.resource_allocations where id=${origin.allocationId}`)[0]!.status).toBe('RELEASED');});

  it("PostgreSQL physically rejects overlapping ACTIVE rows and allows touching ranges",async()=>{const first=randomUUID();await database.client`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${ids.business},${ids.staffB},'OPERATIONAL_BLOCK',${first},'2026-11-04','2026-11-04T18:00Z','2026-11-04T18:30Z','2026-11-04T18:00Z','2026-11-04T18:30Z')`;await expect(database.client`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${ids.business},${ids.staffB},'OPERATIONAL_BLOCK',${randomUUID()},'2026-11-04','2026-11-04T18:15Z','2026-11-04T18:45Z','2026-11-04T18:15Z','2026-11-04T18:45Z')`).rejects.toMatchObject({code:'23P01'});await expect(database.client`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${ids.business},${ids.staffB},'OPERATIONAL_BLOCK',${randomUUID()},'2026-11-04','2026-11-04T18:30Z','2026-11-04T19:00Z','2026-11-04T18:30Z','2026-11-04T19:00Z')`).resolves.toBeDefined();});

  it("Release preserves history and restores the range",async()=>{const sourceId=randomUUID();const claimed=await database.client.begin(tx=>claimReservationWithBooking(tx,{businessId:ids.business,sourceType:'RESERVATION',sourceId,serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStart:'15:00',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now));await database.client.begin(tx=>cancelReservationWithBooking(tx,{businessId:ids.business,sourceType:'RESERVATION',sourceId,reason:'integration release'}));const row=(await database.client`select status::text status,released_at "releasedAt" from availability.resource_allocations where id=${claimed.allocationId}`)[0]!;expect(row.status).toBe('RELEASED');expect(row.releasedAt).toBeTruthy();await expect(resolveSlot(database.client,{businessId:ids.business,serviceIds:[ids.serviceCut],localDate:'2026-11-04',visibleStartMinute:900,professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA},requirePublic:true,now})).resolves.toMatchObject({staffMemberId:ids.staffA});});

  it("denies direct anon reads through grants/RLS",async()=>{await expect(database.client.begin(async tx=>{await tx`set local role anon`;await tx`select * from availability.resource_allocations`;})).rejects.toMatchObject({code:'42501'});});

  it("replaces a business date with a closure and restores the weekly schedule after removal",async()=>{
    await replaceBusinessDateException(actor,'2026-11-11',{expectedRevision:0,reason:'Local closure',intervals:[]},randomUUID());
    const closed=await searchAvailability(ids.business,{serviceIds:[ids.serviceCut],fromDate:'2026-11-11',throughDate:'2026-11-11',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now);
    expect(closed.days[0]!.slots).toHaveLength(0);
    await removeBusinessDateException(actor,'2026-11-11',{expectedRevision:1},randomUUID());
    const restored=await searchAvailability(ids.business,{serviceIds:[ids.serviceCut],fromDate:'2026-11-11',throughDate:'2026-11-11',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now);
    expect(restored.days[0]!.slots.length).toBeGreaterThan(0);
  });

  it("subtracts only applied effective unavailability and restores capacity on release",async()=>{
    const sourceId=randomUUID();
    await database.client.begin(tx=>applyEffectiveUnavailability(tx,{businessId:ids.business,staffMemberId:ids.staffA,sourceType:'APPLIED_ABSENCE',sourceId,localDate:'2026-11-11',startMinute:600,endMinute:720,operationId:randomUUID()}));
    await expect(resolveSlot(database.client,{businessId:ids.business,serviceIds:[ids.serviceCut],localDate:'2026-11-11',visibleStartMinute:630,professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA},requirePublic:true,now})).rejects.toMatchObject({code:'SLOT_CONFLICT'});
    await database.client.begin(tx=>releaseEffectiveUnavailability(tx,{businessId:ids.business,sourceType:'APPLIED_ABSENCE',sourceId}));
    await expect(resolveSlot(database.client,{businessId:ids.business,serviceIds:[ids.serviceCut],localDate:'2026-11-11',visibleStartMinute:630,professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA},requirePublic:true,now})).resolves.toMatchObject({staffMemberId:ids.staffA});
  });

  it("rejects duplicate service IDs in Claim per D13 and rejects starts outside policy cadence",async()=>{
    await expect(database.client.begin(tx=>claimReservationWithBooking(tx,{businessId:ids.business,sourceType:'RESERVATION',sourceId:randomUUID(),serviceIds:[ids.serviceCut,ids.serviceCut],localDate:'2026-11-11',visibleStart:'13:00',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now))).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await expect(database.client.begin(tx=>quoteAllocation(tx,{businessId:ids.business,sourceType:'RESERVATION',sourceId:randomUUID(),serviceIds:[ids.serviceCut],localDate:'2026-11-11',visibleStart:'10:17',professionalPreference:{type:'SPECIFIC',staffMemberId:ids.staffA}},now))).rejects.toMatchObject({code:'NO_AVAILABILITY'});
  });

  it("protects H02 schedule, eligibility, and lifecycle mutations with availability impact rules",async()=>{
    const futureDate='2099-11-05';
    const impactedSource=randomUUID();
    const impactedAllocation=await seedConfirmedReservationWithAllocation({businessId:ids.business,staffMemberId:ids.staffA,sourceId:impactedSource,localDate:futureDate,visibleStartAt:`${futureDate}T15:00Z`,visibleEndAt:`${futureDate}T15:30Z`,occupiedStartAt:`${futureDate}T15:00Z`,occupiedEndAt:`${futureDate}T15:30Z`});
    await database.client`insert into availability.allocation_service_requirements(business_id,allocation_id,service_id) values (${ids.business},${impactedAllocation},${ids.serviceCut})`;
    await expect(replaceWeeklySchedule(actor,ids.staffA,{expectedRevision:1,week:{MONDAY:[],TUESDAY:[],WEDNESDAY:[],THURSDAY:[],FRIDAY:[],SATURDAY:[],SUNDAY:[]}},randomUUID())).rejects.toMatchObject({code:'AVAILABILITY_IMPACT_CONFLICT'});
    await expect(replaceStaffServices(actor,ids.staffA,{expectedRevision:1,serviceIds:[ids.serviceBeard]},randomUUID())).rejects.toMatchObject({code:'AVAILABILITY_IMPACT_CONFLICT'});

    await seedConfirmedReservationWithAllocation({businessId:ids.business,staffMemberId:ids.staffB,sourceId:randomUUID(),localDate:futureDate,visibleStartAt:`${futureDate}T16:00Z`,visibleEndAt:`${futureDate}T16:30Z`,occupiedStartAt:`${futureDate}T16:00Z`,occupiedEndAt:`${futureDate}T16:30Z`});
    const suspended=await lifecycle(actor,ids.staffB,'suspend',{revision:1,reason:'Urgent credential compromise'},randomUUID());
    expect(suspended.data).toMatchObject({accessStatus:'SUSPENDED'});
    await expect(database.client`select 1 from availability.commitment_conflicts c join availability.resource_allocations a on a.business_id=c.business_id and a.id=c.allocation_id where c.business_id=${ids.business} and a.staff_member_id=${ids.staffB} and c.status='OPEN' and c.reason_code='STAFF_SECURITY_SUSPENSION'`).resolves.toHaveLength(1);
  });

  it("resolveSlot is deterministic under repeated identical calls (ANY balancing)",async()=>{
    // Llamadas secuenciales (no concurrentes) para verificar determinismo
    // de la función pura, sin interferencia de claim/release.
    const results=[];
    for(let i=0;i<100;i++){
      const resolved=await resolveSlot(database.client,{businessId:ids.business,serviceIds:[ids.serviceCut],localDate:'2026-11-18',visibleStartMinute:630,professionalPreference:{type:'ANY'},requirePublic:true,now});
      results.push(resolved);
    }
    const staffIds=results.map(r=>r.staffMemberId);
    // El primer resultado debe repetirse en todas las 100 llamadas (determinismo)
    results.forEach(r=>expect(r.staffMemberId).toBe(results[0].staffMemberId));
    expect(new Set(staffIds).size).toBe(1);
  });
});
