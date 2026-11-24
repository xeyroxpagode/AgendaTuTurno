/**
 * Full booking fixture: Business + IAM actor + Staff + Catalog + Policy.
 * Shared by H03.U04 integration specs. Never used in production paths.
 */
import { randomUUID } from "node:crypto";
import { database } from "../../../apps/api/src/lib/runtime";
import type { Tx } from "../../../apps/api/src/modules/system/operations";

export type BookingSeed = {
  business: string;
  person: string;
  account: string;
  staffA: string;
  staffB: string;
  category: string;
  serviceCut: string;
  serviceBeard: string;
  termsCut: string;
  termsBeard: string;
  policyVersionId: string;
};

/** Wednesday 2026-11-04 (weekday 3). */
export const FIXTURE_DATE = "2026-11-04";
export const FIXTURE_TIMEZONE = "America/Argentina/Buenos_Aires";

// Keep the weekday and cutoff invariant while moving test dates with the clock.
export function nextBookingWednesday(weeksAhead = 0): string {
  const localToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: FIXTURE_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const date = new Date(localToday + "T00:00:00Z");
  const days = (3 - date.getUTCDay() + 7) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + days + weeksAhead * 7);
  return date.toISOString().slice(0, 10);
}

export async function seedBookingBusiness(label: string): Promise<BookingSeed> {
  const ids = {
    business: randomUUID(),
    person: randomUUID(),
    account: randomUUID(),
    staffA: randomUUID(),
    staffB: randomUUID(),
    category: randomUUID(),
    serviceCut: randomUUID(),
    serviceBeard: randomUUID(),
    termsCut: randomUUID(),
    termsBeard: randomUUID(),
  };
  await database.client.begin(async tx => {
    await tx`insert into business.businesses(id,provisioning_key,display_name,timezone,status) values (${ids.business},${`${label}-${ids.business}`},${label},${FIXTURE_TIMEZONE},'ACTIVE')`;
    await tx`insert into iam.persons(id,first_name) values (${ids.person},'Booking Owner')`;
    await tx`insert into iam.user_accounts(id,person_id,status) values (${ids.account},${ids.person},'ACTIVE')`;
    const personB = randomUUID();
    await tx`insert into iam.persons(id,first_name) values (${personB},'Booking Barber B')`;
    await tx`insert into team.staff_members(id,business_id,person_id,employment_status,access_status) values (${ids.staffA},${ids.business},${ids.person},'ACTIVE','ACTIVE'),(${ids.staffB},${ids.business},${personB},'ACTIVE','ACTIVE')`;
    await tx`insert into catalog.service_categories(id,business_id,name) values (${ids.category},${ids.business},'Services')`;
    await tx`insert into catalog.services(id,business_id,name,category_id,publication) values (${ids.serviceCut},${ids.business},'Corte',${ids.category},'PUBLISHED'),(${ids.serviceBeard},${ids.business},'Barba',${ids.category},'PUBLISHED')`;
    await tx`insert into catalog.service_terms_versions(id,business_id,service_id,version_number,price_minor,currency,duration_minutes,pre_buffer_minutes,post_buffer_minutes,conditions) values (${ids.termsCut},${ids.business},${ids.serviceCut},1,1000,'ARS',30,5,5,null),(${ids.termsBeard},${ids.business},${ids.serviceBeard},1,500,'ARS',20,5,5,null)`;
    await tx`update catalog.services set current_terms_version_id=${ids.termsCut} where id=${ids.serviceCut}`;
    await tx`update catalog.services set current_terms_version_id=${ids.termsBeard} where id=${ids.serviceBeard}`;
    const setA = (await tx`insert into team.staff_service_sets(business_id,staff_member_id) values (${ids.business},${ids.staffA}) returning id`)[0]!.id;
    const setB = (await tx`insert into team.staff_service_sets(business_id,staff_member_id) values (${ids.business},${ids.staffB}) returning id`)[0]!.id;
    for (const service of [ids.serviceCut, ids.serviceBeard]) await tx`insert into team.staff_service_assignments(business_id,staff_service_set_id,service_id) values (${ids.business},${setA},${service})`;
    await tx`insert into team.staff_service_assignments(business_id,staff_service_set_id,service_id) values (${ids.business},${setB},${ids.serviceCut})`;
    const scheduleA = (await tx`insert into team.staff_weekly_schedules(business_id,staff_member_id) values (${ids.business},${ids.staffA}) returning id`)[0]!.id;
    const scheduleB = (await tx`insert into team.staff_weekly_schedules(business_id,staff_member_id) values (${ids.business},${ids.staffB}) returning id`)[0]!.id;
    await tx`insert into team.staff_schedule_intervals(business_id,weekly_schedule_id,weekday,start_minute,end_minute) values (${ids.business},${scheduleA},3,540,1080),(${ids.business},${scheduleB},3,540,1200)`;
    const hours = (await tx`insert into business.business_hours_configs(business_id) values (${ids.business}) returning id`)[0]!.id;
    await tx`insert into business.business_hours_intervals(business_id,config_id,weekday,start_minute,end_minute) values (${ids.business},${hours},3,600,1200)`;
    const version = (await tx`insert into business.booking_policy_versions(business_id,version_number,public_booking_enabled,horizon_calendar_dates,min_lead_minutes,start_step_minutes,cancel_cutoff_minutes,reschedule_cutoff_minutes,created_by) values (${ids.business},1,true,30,0,30,120,120,${ids.account}) returning id`)[0]!.id;
    await tx`insert into business.booking_policy_states(business_id,current_version_id) values (${ids.business},${version})`;
  });
  const [row] = await database.client`select ps.current_version_id "policyVersionId" from business.booking_policy_states ps where ps.business_id=${ids.business}`;
  return { ...ids, policyVersionId: row!.policyVersionId as string };
}

export async function insertOperationFixture(businessId: string, command = "test.fixture"): Promise<string> {
  const operationId = randomUUID();
  await database.client`insert into system.operation_attempts(operation_id,business_id,command_name,request_hash,status,response_status,completed_at) values (${operationId},${businessId},${command},'fixture','SUCCEEDED',200,now())`;
  return operationId;
}

/** Inserts a fully valid CONFIRMED reservation + ACTIVE allocation in one tx. */
export async function seedConfirmedReservation(seed: BookingSeed, input?: {
  reservationId?: string;
  staffMemberId?: string;
  localDate?: string;
  visibleStartAt?: string;
  visibleEndAt?: string;
  occupiedStartAt?: string;
  occupiedEndAt?: string;
}) {
  const reservationId = input?.reservationId ?? randomUUID();
  const staffMemberId = input?.staffMemberId ?? seed.staffA;
  const localDate = input?.localDate ?? FIXTURE_DATE;
  const visibleStartAt = input?.visibleStartAt ?? `${FIXTURE_DATE}T13:30:00Z`;
  const visibleEndAt = input?.visibleEndAt ?? `${FIXTURE_DATE}T14:20:00Z`;
  const occupiedStartAt = input?.occupiedStartAt ?? `${FIXTURE_DATE}T13:25:00Z`;
  const occupiedEndAt = input?.occupiedEndAt ?? `${FIXTURE_DATE}T14:25:00Z`;
  return database.client.begin(async tx => {
    const operationId = await reservationOperation(tx, seed.business);
    const [alloc] = await tx`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${seed.business},${staffMemberId},'RESERVATION',${reservationId},${localDate},${visibleStartAt},${visibleEndAt},${occupiedStartAt},${occupiedEndAt}) returning id`;
    await tx`insert into booking.reservations(id,business_id,status,owner_type,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,current_allocation_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
      values (${reservationId},${seed.business},'CONFIRMED','GUEST','{"name":"Fixture Guest","phone":"1100000000"}'::jsonb,${staffMemberId},${seed.policyVersionId},'{}'::jsonb,1500,'ARS',${alloc!.id},${visibleStartAt},${visibleEndAt},${occupiedStartAt},${occupiedEndAt},${localDate},${FIXTURE_TIMEZONE},${operationId})`;
    return { reservationId, allocationId: alloc!.id as string };
  });
}

export async function reservationOperation(tx: Tx | typeof database.client, businessId: string, command = "test.fixture"): Promise<string> {
  const operationId = randomUUID();
  await tx`insert into system.operation_attempts(operation_id,business_id,command_name,request_hash,status,response_status,completed_at) values (${operationId},${businessId},${command},'fixture','SUCCEEDED',200,now())`;
  return operationId;
}
