/**
 * H03.U05 · Fixtures de Agenda Staff.
 *
 * Reutiliza las reglas de los fixtures U04 (`booking-fixtures.ts`) y añade las
 * entidades que U05 necesita:_policy vigente, personal con roles y reservas con
 * ventana temporal manipulable (para los casos de no-show).
 */
import { randomUUID } from "node:crypto";
import { database } from "../../../apps/api/src/lib/runtime";
import type { Tx } from "../../../apps/api/src/modules/system/operations";
import { FIXTURE_TIMEZONE } from "./booking-fixtures";

export type StaffAgendaSeed = {
  business: string;
  ownerAccount: string;
  receptionistAccount: string;
  barberAccount: string;
  ownerStaff: string;
  receptionistStaff: string;
  barberStaff: string;
  category: string;
  serviceCut: string;
  serviceBeard: string;
  termsCut: string;
  termsBeard: string;
  policyVersionId: string;
  personIds: string[];
};

/** Fecha local del fixture: un día anterior (miércoles) para poder simular horas pasadas. */
export const STAFF_FIXTURE_DATE = "2026-11-04";
/** Fecha local futura (miércoles) para las operaciones que exigen horario por delante. */
export const STAFF_CREATE_DATE = "2026-11-18";

/**
 * Crea un Business con tres profesionales (owner, recepción, barbero), dos
 * servicios y una policy vigente. Los tres profesionales son elegibles para
 * ambos servicios salvo que el test lo altere explícitamente.
 */
export async function seedStaffAgendaBusiness(label: string): Promise<StaffAgendaSeed> {
  const ids = {
    business: randomUUID(),
    ownerAccount: randomUUID(),
    receptionistAccount: randomUUID(),
    barberAccount: randomUUID(),
    ownerStaff: randomUUID(),
    receptionistStaff: randomUUID(),
    barberStaff: randomUUID(),
    category: randomUUID(),
    serviceCut: randomUUID(),
    serviceBeard: randomUUID(),
    termsCut: randomUUID(),
    termsBeard: randomUUID(),
  };
  const personIds: string[] = [];
  let versionId = "";
  await database.client.begin(async tx => {
    await tx`insert into business.businesses(id,provisioning_key,display_name,timezone,status) values (${ids.business},${`${label}-${ids.business}`},${label},${FIXTURE_TIMEZONE},'ACTIVE')`;

    const people: Array<{ account: string; staff: string; first: string; last: string; role: string }> = [
      { account: ids.ownerAccount, staff: ids.ownerStaff, first: "Owner", last: "U05", role: "OWNER" },
      { account: ids.receptionistAccount, staff: ids.receptionistStaff, first: "Recepcion", last: "U05", role: "RECEPTIONIST" },
      { account: ids.barberAccount, staff: ids.barberStaff, first: "Barber", last: "U05", role: "BARBER" },
    ];
    for (const person of people) {
      const personId = randomUUID();
      personIds.push(personId);
      await tx`insert into iam.persons(id,first_name,last_name) values (${personId},${person.first},${person.last})`;
      await tx`insert into iam.user_accounts(id,person_id,status) values (${person.account},${personId},'ACTIVE')`;
      await tx`insert into iam.account_security_states(account_id) values (${person.account})`;
      await tx`insert into team.staff_members(id,business_id,person_id,employment_status,access_status) values (${person.staff},${ids.business},${personId},'ACTIVE','ACTIVE')`;
      await tx`insert into team.staff_relationship_periods(business_id,staff_member_id) values (${ids.business},${person.staff})`;
      await tx`insert into iam.staff_role_states(business_id,staff_member_id) values (${ids.business},${person.staff})`;
      await tx`insert into iam.role_assignments(business_id,staff_member_id,role,effective_at,assigned_by_account_id) values (${ids.business},${person.staff},${person.role},now(),${ids.ownerAccount})`;
    }

    await tx`insert into catalog.service_categories(id,business_id,name) values (${ids.category},${ids.business},'Services U05')`;
    await tx`insert into catalog.services(id,business_id,name,category_id,publication,lifecycle) values (${ids.serviceCut},${ids.business},'Corte U05',${ids.category},'PUBLISHED','ACTIVE'),(${ids.serviceBeard},${ids.business},'Barba U05',${ids.category},'PUBLISHED','ACTIVE')`;
    await tx`insert into catalog.service_terms_versions(id,business_id,service_id,version_number,price_minor,currency,duration_minutes,pre_buffer_minutes,post_buffer_minutes,conditions,effective_from) values (${ids.termsCut},${ids.business},${ids.serviceCut},1,10000,'ARS',30,5,5,null,now()),(${ids.termsBeard},${ids.business},${ids.serviceBeard},1,5000,'ARS',20,5,5,null,now())`;
    await tx`update catalog.services set current_terms_version_id=${ids.termsCut} where id=${ids.serviceCut}`;
    await tx`update catalog.services set current_terms_version_id=${ids.termsBeard} where id=${ids.serviceBeard}`;

    for (const staff of [ids.ownerStaff, ids.receptionistStaff, ids.barberStaff]) {
      const setId = (await tx`insert into team.staff_service_sets(business_id,staff_member_id) values (${ids.business},${staff}) returning id`)[0]!.id;
      await tx`insert into team.staff_service_assignments(business_id,staff_service_set_id,service_id) values (${ids.business},${setId},${ids.serviceCut}),(${ids.business},${setId},${ids.serviceBeard})`;
      const scheduleId = (await tx`insert into team.staff_weekly_schedules(business_id,staff_member_id) values (${ids.business},${staff}) returning id`)[0]!.id;
      await tx`insert into team.staff_schedule_intervals(business_id,weekly_schedule_id,weekday,start_minute,end_minute) values (${ids.business},${scheduleId},3,0,1440)`;
    }

    const hoursId = (await tx`insert into business.business_hours_configs(business_id) values (${ids.business}) returning id`)[0]!.id;
    await tx`insert into business.business_hours_intervals(business_id,config_id,weekday,start_minute,end_minute) values (${ids.business},${hoursId},3,0,1440)`;

    versionId = (await tx`insert into business.booking_policy_versions(business_id,version_number,public_booking_enabled,horizon_calendar_dates,min_lead_minutes,start_step_minutes,cancel_cutoff_minutes,reschedule_cutoff_minutes,created_by) values (${ids.business},1,true,365,0,30,120,120,${ids.ownerAccount}) returning id`)[0]!.id;
    await tx`insert into business.booking_policy_states(business_id,current_version_id) values (${ids.business},${versionId})`;
  });
  return { ...ids, policyVersionId: versionId, personIds };
}

/**
 * Inserta una reserva CONFIRMED con su Allocation ACTIVE y un evento inicial.
 * `startsAt`/`endsAt` controlan la ventana temporal del turno.
 *
 * Cada invocación ocupa una franja horaria distinta (cursor correlativo) para
 * no chocar con la constraint GiST de no solapamiento de allocations activas.
 */
let slotCursor = 0;
const staffSlotCursor = new Map<string, number>();

export async function seedConfirmedReservation(
  seed: StaffAgendaSeed,
  input: {
    staffMemberId: string;
    localDate?: string;
    startsAt?: string;
    endsAt?: string;
    occupiedStartsAt?: string;
    occupiedEndsAt?: string;
    customerName?: string;
  },
) {
  const reservationId = randomUUID();
  const localDate = input.localDate ?? STAFF_FIXTURE_DATE;
  // Franja horaria correlativa POR PROFESIONAL: garantiza que dos reservas del
  // mismo profesional nunca comparten intervalo (constraint GiST) y que el
  // fixture cubre varias horas del día.
  const staffKey = `${input.staffMemberId}:${localDate}`;
  const index = staffSlotCursor.get(staffKey) ?? 0;
  staffSlotCursor.set(staffKey, index + 1);
  slotCursor += 1;
  const startMinute = 8 * 60 + index * 60;
  const iso = (minute: number) => `${localDate}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`;
  const startsAt = input.startsAt ?? iso(startMinute);
  const endsAt = input.endsAt ?? iso(startMinute + 50);
  const occupiedStartsAt = input.occupiedStartsAt ?? iso(startMinute - 5);
  const occupiedEndsAt = input.occupiedEndsAt ?? iso(startMinute + 55);

  await database.client.begin(async tx => {
    const operationId = await reservationOperation(tx, seed.business);
    const [allocation] = await tx`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${seed.business},${input.staffMemberId},'RESERVATION',${reservationId},${localDate},${startsAt},${endsAt},${occupiedStartsAt},${occupiedEndsAt}) returning id`;
    await tx`insert into booking.reservations(id,business_id,revision,status,owner_type,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,current_allocation_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
      values (${reservationId},${seed.business},1,'CONFIRMED','GUEST',${JSON.stringify({ name: input.customerName ?? "Cliente U05", phone: "1100000000" })}::jsonb,${input.staffMemberId},${seed.policyVersionId},'{}'::jsonb,10000,'ARS',${allocation!.id},${startsAt},${endsAt},${occupiedStartsAt},${occupiedEndsAt},${localDate},${FIXTURE_TIMEZONE},${operationId})`;
    await tx`insert into booking.reservation_items(business_id,reservation_id,position,service_id,service_name_snapshot,terms_version_id,duration_minutes,pre_buffer_minutes,post_buffer_minutes,price_minor,currency) values (${seed.business},${reservationId},1,${seed.serviceCut},'Corte U05',${seed.termsCut},30,5,5,10000,'ARS')`;
    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,changes) values (${seed.business},${reservationId},1,'RESERVATION_CONFIRMED',${operationId},'STAFF','{}'::jsonb)`;
  });
  return { reservationId, staffMemberId: input.staffMemberId };
}

export async function reservationOperation(tx: Tx | typeof database.client, businessId: string, command = "test.fixture"): Promise<string> {
  const operationId = randomUUID();
  await tx`insert into system.operation_attempts(operation_id,business_id,command_name,request_hash,status,response_status,completed_at) values (${operationId},${businessId},${command},'fixture','SUCCEEDED',200,now())`;
  return operationId;
}

/**
 * Elimina el Business de prueba y todos sus datos (usado en limpieza).
 *
 * `booking.reservation_events` es append-only por trigger y varias tablas
 * referencian a `iam.user_accounts`; por eso la limpieza se hace con los
 * triggers desactivados dentro de la transacción (`SET LOCAL` los revierte al
 * cerrar la transacción).
 */
export async function destroyStaffAgendaBusiness(seed: StaffAgendaSeed): Promise<void> {
  await database.client.begin(async tx => {
    await tx`set local session_replication_role = replica`;
    // H03.U06 · Ausencias y atenciones: se limpian primero porque referencian
    // `team.staff_members`, `booking.reservations` y `system.operation_attempts`.
    await tx`delete from absence.absence_events where business_id=${seed.business}`;
    await tx`delete from absence.absence_requests where business_id=${seed.business}`;
    await tx`delete from attendance.attendance_events where business_id=${seed.business}`;
    await tx`delete from attendance.attendance_corrections where business_id=${seed.business}`;
    await tx`delete from attendance.attendances where business_id=${seed.business}`;
    await tx`delete from team.staff_effective_unavailability where business_id=${seed.business}`;
    await tx`delete from availability.commitment_conflicts where business_id=${seed.business}`;
    await tx`delete from booking.reservation_events where business_id=${seed.business}`;
    await tx`delete from booking.reservation_items where business_id=${seed.business}`;
    await tx`delete from booking.reservations where business_id=${seed.business}`;
    await tx`delete from availability.allocation_service_requirements where business_id=${seed.business}`;
    await tx`delete from availability.resource_allocations where business_id=${seed.business}`;
    await tx`delete from availability.business_guards where business_id=${seed.business}`;
    await tx`delete from team.staff_service_assignments where business_id=${seed.business}`;
    await tx`delete from team.staff_service_sets where business_id=${seed.business}`;
    await tx`delete from team.staff_schedule_intervals where business_id=${seed.business}`;
    await tx`delete from team.staff_weekly_schedules where business_id=${seed.business}`;
    await tx`delete from team.staff_relationship_periods where business_id=${seed.business}`;
    await tx`delete from iam.staff_role_states where business_id=${seed.business}`;
    await tx`delete from iam.role_assignments where business_id=${seed.business}`;
    await tx`delete from iam.capability_grants where business_id=${seed.business}`;
    await tx`delete from iam.access_sessions where business_id=${seed.business}`;
    await tx`delete from team.staff_members where business_id=${seed.business}`;
    await tx`delete from iam.account_security_states where account_id=any(${[seed.ownerAccount, seed.receptionistAccount, seed.barberAccount]}::uuid[])`;
    await tx`delete from iam.user_accounts where id=any(${[seed.ownerAccount, seed.receptionistAccount, seed.barberAccount]}::uuid[])`;
    await tx`delete from iam.persons where id=any(${seed.personIds}::uuid[])`;
    await tx`delete from catalog.service_terms_versions where business_id=${seed.business}`;
    await tx`delete from catalog.services where business_id=${seed.business}`;
    await tx`delete from catalog.service_categories where business_id=${seed.business}`;
    await tx`delete from business.business_hours_intervals where business_id=${seed.business}`;
    await tx`delete from business.business_hours_configs where business_id=${seed.business}`;
    await tx`delete from business.booking_policy_states where business_id=${seed.business}`;
    await tx`delete from business.booking_policy_versions where business_id=${seed.business}`;
    await tx`delete from system.audit_events where business_id=${seed.business}`;
    await tx`delete from system.operation_attempts where business_id=${seed.business}`;
    await tx`delete from business.businesses where id=${seed.business}`;
  });
}
