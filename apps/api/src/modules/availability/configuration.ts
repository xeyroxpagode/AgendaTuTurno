import {
  DomainError, bookingPolicyValuesSchema, replaceBookingPolicySchema, replaceBusinessHoursSchema,
  replaceDateExceptionSchema, weekdayByNumber, weekdayNumber, weekdays,
  type BookingPolicyValues, type DateException
} from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { audit, executeOperation, type Tx } from "../system/operations.js";
import { canonicalizeDayIntervals, canonicalizeWeek, canonicalWeekToApi, emptyWeek, formatTimeOfDay, weeklySchedulesEqual, type CanonicalInterval, type CanonicalWeek } from "../schedules/domain.js";
import { rows, sql } from "../../lib/sql.js";
import { lockAvailabilityGuard } from "./guard.js";

type RevisionRow = { id: string; revision: number | string };
type IntervalRow = { weekday?: number; startMinute: number | string; endMinute: number | string };

function intervalsToWeek(input: IntervalRow[]): CanonicalWeek {
  const week = emptyWeek();
  for (const row of input) {
    if (!row.weekday) continue;
    week[weekdayByNumber[row.weekday]!].push({ startMinute: Number(row.startMinute), endMinute: Number(row.endMinute) });
  }
  return week;
}

async function insertWeek(tx: Tx, businessId: string, configId: string, week: CanonicalWeek) {
  for (const weekday of weekdays) for (const interval of week[weekday]) {
    await tx`insert into business.business_hours_intervals(business_id,config_id,weekday,start_minute,end_minute)
      values (${businessId},${configId},${weekdayNumber[weekday]},${interval.startMinute},${interval.endMinute})`;
  }
}

async function assertNoFutureBusinessCommitments(tx: Tx, businessId: string) {
  const conflicts = await tx`select id from availability.resource_allocations where business_id=${businessId} and status='ACTIVE' and occupied_end_at>now() limit 100`;
  if (conflicts.length) throw new DomainError("AVAILABILITY_IMPACT_CONFLICT", "The change would affect future commitments", 409, { allocationIds: conflicts.map(item => item.id) });
}

async function assertNoDateCommitments(tx: Tx, businessId: string, localDate: string, staffMemberId?: string) {
  const conflicts = staffMemberId
    ? await tx`select id from availability.resource_allocations where business_id=${businessId} and staff_member_id=${staffMemberId} and local_date=${localDate} and status='ACTIVE' limit 100`
    : await tx`select id from availability.resource_allocations where business_id=${businessId} and local_date=${localDate} and status='ACTIVE' limit 100`;
  if (conflicts.length) throw new DomainError("AVAILABILITY_IMPACT_CONFLICT", "The change would affect commitments on this date", 409, { allocationIds: conflicts.map(item => item.id) });
}

export async function getBusinessHours(actor: Actor) {
  const [business] = await rows<{ timezone: string }>(sql`select timezone from business.businesses where id=${actor.businessId}`);
  const [config] = await rows<RevisionRow>(sql`select id,revision from business.business_hours_configs where business_id=${actor.businessId}`);
  if (!config) return { revision: 0, hasConfiguration: false, timezone: business?.timezone ?? "UTC", week: canonicalWeekToApi(emptyWeek()) };
  const intervals = await rows<IntervalRow>(sql`select weekday,start_minute "startMinute",end_minute "endMinute" from business.business_hours_intervals where business_id=${actor.businessId} and config_id=${config.id} order by weekday,start_minute`);
  return { revision: Number(config.revision), hasConfiguration: true, timezone: business?.timezone ?? "UTC", week: canonicalWeekToApi(intervalsToWeek(intervals)) };
}

export async function replaceBusinessHours(actor: Actor, raw: unknown, operationId: string) {
  const input = replaceBusinessHoursSchema.parse(raw); const target = canonicalizeWeek(input.week);
  return executeOperation({ operationId, command: "availability.business-hours.replace", actor, payload: { expectedRevision: input.expectedRevision, week: target } }, async tx => {
    await lockAvailabilityGuard(tx, actor.businessId);
    const [config] = await tx`select id,revision from business.business_hours_configs where business_id=${actor.businessId} for update` as unknown as RevisionRow[];
    const actual = config ? Number(config.revision) : 0;
    if (actual !== input.expectedRevision) throw new DomainError("STALE_REVISION", "Business Hours revision is stale", 409);
    const existingRows = config ? await tx`select weekday,start_minute "startMinute",end_minute "endMinute" from business.business_hours_intervals where business_id=${actor.businessId} and config_id=${config.id} order by weekday,start_minute` as unknown as IntervalRow[] : [];
    const existing = intervalsToWeek(existingRows);
    if (config && weeklySchedulesEqual(existing, target)) return { revision: actual, changed: false, hasConfiguration: true, week: canonicalWeekToApi(target) };
    if (!config && weeklySchedulesEqual(existing, target)) return { revision: 0, changed: false, hasConfiguration: false, week: canonicalWeekToApi(target) };
    await assertNoFutureBusinessCommitments(tx, actor.businessId);
    let id: string; let revision: number;
    if (!config) {
      const [created] = await tx`insert into business.business_hours_configs(business_id) values (${actor.businessId}) returning id,revision` as unknown as RevisionRow[];
      id = created!.id; revision = Number(created!.revision);
    } else {
      id = config.id;
      await tx`delete from business.business_hours_intervals where business_id=${actor.businessId} and config_id=${id}`;
      const [updated] = await tx`update business.business_hours_configs set revision=revision+1,updated_at=now() where id=${id} returning revision` as unknown as RevisionRow[];
      revision = Number(updated!.revision);
    }
    await insertWeek(tx, actor.businessId, id, target);
    await audit(tx, { actor, operationId, action: "availability.business_hours.replaced", capability: "availability.manage", resourceType: "BUSINESS_HOURS", resourceId: id, changes: { revision } });
    return { revision, changed: true, hasConfiguration: true, week: canonicalWeekToApi(target) };
  });
}

type PolicyRow = BookingPolicyValues & { id: string; revision: number | string; versionNumber: number | string; effectiveFrom: Date | string };
const policySelect = sql`select v.id,s.revision,v.version_number "versionNumber",v.public_booking_enabled "publicBookingEnabled",v.horizon_calendar_dates "horizonCalendarDates",v.min_lead_minutes "minLeadMinutes",v.start_step_minutes "startStepMinutes",v.cancel_cutoff_minutes "cancelCutoffMinutes",v.reschedule_cutoff_minutes "rescheduleCutoffMinutes",v.effective_from "effectiveFrom" from business.booking_policy_states s join business.booking_policy_versions v on v.business_id=s.business_id and v.id=s.current_version_id`;
const toIso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const mapPolicy = (row: PolicyRow) => ({ ...row, revision: Number(row.revision), versionNumber: Number(row.versionNumber), effectiveFrom: toIso(row.effectiveFrom) });

export async function getBookingPolicy(actor: Actor) {
  const [row] = await rows<PolicyRow>(sql`${policySelect} where s.business_id=${actor.businessId}`);
  return row ? mapPolicy(row) : null;
}

export async function getBookingPolicyHistory(actor: Actor) {
  const history = await rows<Omit<PolicyRow, "revision">>(sql`select id,version_number "versionNumber",public_booking_enabled "publicBookingEnabled",horizon_calendar_dates "horizonCalendarDates",min_lead_minutes "minLeadMinutes",start_step_minutes "startStepMinutes",cancel_cutoff_minutes "cancelCutoffMinutes",reschedule_cutoff_minutes "rescheduleCutoffMinutes",effective_from "effectiveFrom" from business.booking_policy_versions where business_id=${actor.businessId} order by version_number desc`);
  return history.map(row => ({ ...row, versionNumber: Number(row.versionNumber), effectiveFrom: toIso(row.effectiveFrom) }));
}

function samePolicy(a: BookingPolicyValues, b: BookingPolicyValues) {
  return a.publicBookingEnabled === b.publicBookingEnabled && a.horizonCalendarDates === b.horizonCalendarDates && a.minLeadMinutes === b.minLeadMinutes && a.startStepMinutes === b.startStepMinutes && a.cancelCutoffMinutes === b.cancelCutoffMinutes && a.rescheduleCutoffMinutes === b.rescheduleCutoffMinutes;
}

export async function replaceBookingPolicy(actor: Actor, raw: unknown, operationId: string) {
  const input = replaceBookingPolicySchema.parse(raw);
  const values = bookingPolicyValuesSchema.parse({
    publicBookingEnabled: input.publicBookingEnabled,
    horizonCalendarDates: input.horizonCalendarDates,
    minLeadMinutes: input.minLeadMinutes,
    startStepMinutes: input.startStepMinutes,
    cancelCutoffMinutes: input.cancelCutoffMinutes,
    rescheduleCutoffMinutes: input.rescheduleCutoffMinutes
  });
  return executeOperation({ operationId, command: "availability.booking-policy.replace", actor, payload: input }, async tx => {
    await lockAvailabilityGuard(tx, actor.businessId);
    const [state] = await tx`select current_version_id "currentVersionId",revision from business.booking_policy_states where business_id=${actor.businessId} for update` as unknown as { currentVersionId: string; revision: number | string }[];
    const actual = state ? Number(state.revision) : 0;
    if (actual !== input.expectedRevision) throw new DomainError("STALE_REVISION", "Booking Policy revision is stale", 409);
    let current: PolicyRow | undefined;
    if (state) [current] = await tx`select v.id,${actual}::bigint revision,v.version_number "versionNumber",v.public_booking_enabled "publicBookingEnabled",v.horizon_calendar_dates "horizonCalendarDates",v.min_lead_minutes "minLeadMinutes",v.start_step_minutes "startStepMinutes",v.cancel_cutoff_minutes "cancelCutoffMinutes",v.reschedule_cutoff_minutes "rescheduleCutoffMinutes",v.effective_from "effectiveFrom" from business.booking_policy_versions v where v.business_id=${actor.businessId} and v.id=${state.currentVersionId}` as unknown as PolicyRow[];
    if (current && samePolicy(current, values)) return { ...mapPolicy(current), changed: false };
    const versionNumber = current ? Number(current.versionNumber) + 1 : 1;
    const [version] = await tx`insert into business.booking_policy_versions(business_id,version_number,public_booking_enabled,horizon_calendar_dates,min_lead_minutes,start_step_minutes,cancel_cutoff_minutes,reschedule_cutoff_minutes,created_by) values (${actor.businessId},${versionNumber},${values.publicBookingEnabled},${values.horizonCalendarDates},${values.minLeadMinutes},${values.startStepMinutes},${values.cancelCutoffMinutes},${values.rescheduleCutoffMinutes},${actor.accountId}) returning id,effective_from "effectiveFrom"` as unknown as { id: string; effectiveFrom: Date | string }[];
    const revision = state ? actual + 1 : 1;
    await tx`insert into business.booking_policy_states(business_id,current_version_id,revision) values (${actor.businessId},${version!.id},${revision}) on conflict(business_id) do update set current_version_id=excluded.current_version_id,revision=excluded.revision,updated_at=now()`;
    await audit(tx, { actor, operationId, action: "availability.booking_policy.published", capability: "availability.manage", resourceType: "BOOKING_POLICY", resourceId: version!.id, changes: { versionNumber, publicBookingEnabled: values.publicBookingEnabled } });
    return { id: version!.id, revision, versionNumber, ...values, effectiveFrom: toIso(version!.effectiveFrom), changed: true };
  });
}

async function insertExceptionIntervals(tx: Tx, table: "business" | "staff", businessId: string, exceptionId: string, intervals: CanonicalInterval[]) {
  for (const interval of intervals) {
    if (table === "business") await tx`insert into business.business_date_exception_intervals(business_id,exception_id,start_minute,end_minute) values (${businessId},${exceptionId},${interval.startMinute},${interval.endMinute})`;
    else await tx`insert into team.staff_date_exception_intervals(business_id,exception_id,start_minute,end_minute) values (${businessId},${exceptionId},${interval.startMinute},${interval.endMinute})`;
  }
}

function equalIntervals(a: CanonicalInterval[], b: CanonicalInterval[]) { return a.length === b.length && a.every((item, index) => item.startMinute === b[index]!.startMinute && item.endMinute === b[index]!.endMinute); }

export async function listBusinessDateExceptions(actor: Actor) {
  const exceptions = await rows<{ id: string; localDate: string; revision: number | string; reason: string | null }>(sql`select id,local_date::text "localDate",revision,reason from business.business_date_exceptions where business_id=${actor.businessId} order by local_date`);
  return Promise.all(exceptions.map(async item => {
    const intervals = await rows<IntervalRow>(sql`select start_minute "startMinute",end_minute "endMinute" from business.business_date_exception_intervals where business_id=${actor.businessId} and exception_id=${item.id} order by start_minute`);
    return { ...item, revision: Number(item.revision), intervals: intervals.map(row => ({ start: formatTimeOfDay(Number(row.startMinute)), end: formatTimeOfDay(Number(row.endMinute)) })) };
  })) as Promise<DateException[]>;
}

export async function replaceBusinessDateException(actor: Actor, localDate: string, raw: unknown, operationId: string) {
  const input = replaceDateExceptionSchema.parse(raw); const intervals = canonicalizeDayIntervals(input.intervals);
  return executeOperation({ operationId, command: "availability.business-date-exception.replace", actor, payload: { localDate, ...input, intervals } }, async tx => {
    await lockAvailabilityGuard(tx, actor.businessId);
    const [existing] = await tx`select id,revision,reason from business.business_date_exceptions where business_id=${actor.businessId} and local_date=${localDate} for update` as unknown as (RevisionRow & { reason: string | null })[];
    const actual = existing ? Number(existing.revision) : 0;
    if (actual !== input.expectedRevision) throw new DomainError("STALE_REVISION", "Business exception revision is stale", 409);
    const currentRows = existing ? await tx`select start_minute "startMinute",end_minute "endMinute" from business.business_date_exception_intervals where business_id=${actor.businessId} and exception_id=${existing.id} order by start_minute` as unknown as IntervalRow[] : [];
    const current = currentRows.map(row => ({ startMinute: Number(row.startMinute), endMinute: Number(row.endMinute) }));
    const reason = input.reason ?? null;
    if (existing && existing.reason === reason && equalIntervals(current, intervals)) return { id: existing.id, localDate, revision: actual, reason, intervals: input.intervals, changed: false };
    await assertNoDateCommitments(tx, actor.businessId, localDate);
    let id: string; let revision: number;
    if (!existing) { const [created] = await tx`insert into business.business_date_exceptions(business_id,local_date,reason,created_by) values (${actor.businessId},${localDate},${reason},${actor.accountId}) returning id,revision` as unknown as RevisionRow[]; id=created!.id;revision=Number(created!.revision); }
    else { id=existing.id; await tx`delete from business.business_date_exception_intervals where business_id=${actor.businessId} and exception_id=${id}`; const [updated]=await tx`update business.business_date_exceptions set reason=${reason},revision=revision+1,updated_at=now() where id=${id} returning revision` as unknown as RevisionRow[]; revision=Number(updated!.revision); }
    await insertExceptionIntervals(tx,"business",actor.businessId,id,intervals);
    await audit(tx,{actor,operationId,action:"availability.business_date_exception.replaced",capability:"availability.manage",resourceType:"BUSINESS_DATE_EXCEPTION",resourceId:id,changes:{localDate,closed:intervals.length===0}});
    return { id,localDate,revision,reason,intervals:intervals.map(item=>({start:formatTimeOfDay(item.startMinute),end:formatTimeOfDay(item.endMinute)})),changed:true };
  });
}

export async function removeBusinessDateException(actor: Actor, localDate: string, raw: unknown, operationId: string) {
  const input = replaceDateExceptionSchema.pick({ expectedRevision: true }).parse(raw);
  return executeOperation({ operationId, command: "availability.business-date-exception.remove", actor, payload: { localDate, ...input } }, async tx => {
    await lockAvailabilityGuard(tx, actor.businessId);
    const [existing] = await tx`select id,revision from business.business_date_exceptions where business_id=${actor.businessId} and local_date=${localDate} for update` as unknown as RevisionRow[];
    if (!existing) return { localDate, removed: false };
    if (Number(existing.revision) !== input.expectedRevision) throw new DomainError("STALE_REVISION", "Business exception revision is stale", 409);
    await assertNoDateCommitments(tx, actor.businessId, localDate);
    await tx`delete from business.business_date_exceptions where business_id=${actor.businessId} and id=${existing.id}`;
    await audit(tx,{actor,operationId,action:"availability.business_date_exception.removed",capability:"availability.manage",resourceType:"BUSINESS_DATE_EXCEPTION",resourceId:existing.id,changes:{localDate}});
    return { localDate, removed: true };
  });
}

export async function listStaffDateExceptions(actor: Actor, staffMemberId: string) {
  const items = await rows<{ id: string; localDate: string; revision: number | string; reason: string | null }>(sql`select id,local_date::text "localDate",revision,reason from team.staff_date_exceptions where business_id=${actor.businessId} and staff_member_id=${staffMemberId} order by local_date`);
  return Promise.all(items.map(async item => {
    const intervals = await rows<IntervalRow>(sql`select start_minute "startMinute",end_minute "endMinute" from team.staff_date_exception_intervals where business_id=${actor.businessId} and exception_id=${item.id} order by start_minute`);
    return { ...item, revision:Number(item.revision), intervals: intervals.map(row=>({start:formatTimeOfDay(Number(row.startMinute)),end:formatTimeOfDay(Number(row.endMinute))})) };
  })) as Promise<DateException[]>;
}

export async function replaceStaffDateException(actor: Actor, staffMemberId: string, localDate: string, raw: unknown, operationId: string) {
  const input=replaceDateExceptionSchema.parse(raw); const intervals=canonicalizeDayIntervals(input.intervals);
  return executeOperation({operationId,command:"availability.staff-date-exception.replace",actor,payload:{staffMemberId,localDate,...input,intervals}},async tx=>{
    await lockAvailabilityGuard(tx,actor.businessId);
    const [staff]=await tx`select id,employment_status::text "employmentStatus" from team.staff_members where business_id=${actor.businessId} and id=${staffMemberId} for update`;
    if(!staff)throw new DomainError("NOT_FOUND","Staff member not found",404);if(staff.employmentStatus==="INACTIVE")throw new DomainError("SCHEDULE_STAFF_NOT_EDITABLE","Inactive Staff cannot receive exceptions",409);
    const [existing]=await tx`select id,revision,reason from team.staff_date_exceptions where business_id=${actor.businessId} and staff_member_id=${staffMemberId} and local_date=${localDate} for update` as unknown as (RevisionRow&{reason:string|null})[];
    const actual=existing?Number(existing.revision):0;if(actual!==input.expectedRevision)throw new DomainError("STALE_REVISION","Staff exception revision is stale",409);
    const currentRows=existing?await tx`select start_minute "startMinute",end_minute "endMinute" from team.staff_date_exception_intervals where business_id=${actor.businessId} and exception_id=${existing.id} order by start_minute` as unknown as IntervalRow[]:[];
    const current=currentRows.map(row=>({startMinute:Number(row.startMinute),endMinute:Number(row.endMinute)}));const reason=input.reason??null;
    if(existing&&existing.reason===reason&&equalIntervals(current,intervals))return{id:existing.id,localDate,revision:actual,reason,intervals:input.intervals,changed:false};
    await assertNoDateCommitments(tx,actor.businessId,localDate,staffMemberId);
    let id:string;let revision:number;if(!existing){const[created]=await tx`insert into team.staff_date_exceptions(business_id,staff_member_id,local_date,reason,created_by) values (${actor.businessId},${staffMemberId},${localDate},${reason},${actor.accountId}) returning id,revision` as unknown as RevisionRow[];id=created!.id;revision=Number(created!.revision);}else{id=existing.id;await tx`delete from team.staff_date_exception_intervals where business_id=${actor.businessId} and exception_id=${id}`;const[updated]=await tx`update team.staff_date_exceptions set reason=${reason},revision=revision+1,updated_at=now() where id=${id} returning revision` as unknown as RevisionRow[];revision=Number(updated!.revision);}
    await insertExceptionIntervals(tx,"staff",actor.businessId,id,intervals);await audit(tx,{actor,operationId,action:"availability.staff_date_exception.replaced",capability:"availability.manage",resourceType:"STAFF_DATE_EXCEPTION",resourceId:id,changes:{staffMemberId,localDate,closed:intervals.length===0}});
    return{id,localDate,revision,reason,intervals:intervals.map(item=>({start:formatTimeOfDay(item.startMinute),end:formatTimeOfDay(item.endMinute)})),changed:true};
  });
}

export async function removeStaffDateException(actor: Actor, staffMemberId: string, localDate: string, raw: unknown, operationId: string) {
  const input = replaceDateExceptionSchema.pick({ expectedRevision: true }).parse(raw);
  return executeOperation({ operationId, command: "availability.staff-date-exception.remove", actor, payload: { staffMemberId, localDate, ...input } }, async tx => {
    await lockAvailabilityGuard(tx, actor.businessId);
    const [staff] = await tx`select id from team.staff_members where business_id=${actor.businessId} and id=${staffMemberId} for update`;
    if (!staff) throw new DomainError("NOT_FOUND", "Staff member not found", 404);
    const [existing] = await tx`select id,revision from team.staff_date_exceptions where business_id=${actor.businessId} and staff_member_id=${staffMemberId} and local_date=${localDate} for update` as unknown as RevisionRow[];
    if (!existing) return { staffMemberId, localDate, removed: false };
    if (Number(existing.revision) !== input.expectedRevision) throw new DomainError("STALE_REVISION", "Staff exception revision is stale", 409);
    await assertNoDateCommitments(tx, actor.businessId, localDate, staffMemberId);
    await tx`delete from team.staff_date_exceptions where business_id=${actor.businessId} and id=${existing.id}`;
    await audit(tx,{actor,operationId,action:"availability.staff_date_exception.removed",capability:"availability.manage",resourceType:"STAFF_DATE_EXCEPTION",resourceId:existing.id,changes:{staffMemberId,localDate}});
    return { staffMemberId, localDate, removed: true };
  });
}
