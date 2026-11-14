import {
  DomainError, availabilitySearchSchema, type AvailabilitySearchInput,
  type BookingPolicyValues, type ProfessionalPreference, type ServiceRequirement
} from "@youngkingz/contracts";
import { database } from "../../lib/runtime.js";
import type { Tx } from "../system/operations.js";
import type { CanonicalInterval } from "../schedules/domain.js";
import {
  addLocalDays, assertWithinHorizon, businessLocalDate, compareRelativeLoad,
  composeServiceSequence, deterministicCandidateOrder, intersectIntervals,
  intervalContains, localDateTimeToInstant, subtractIntervals, totalMinutes
} from "./temporal.js";

type SqlClient = Tx | typeof database.client;
type Business = { id: string; timezone: string; status: string };
type Policy = BookingPolicyValues & { id: string; revision: number; versionNumber: number };
type Candidate = { id: string; capacityMinutes: number; confirmedMinutes: number; available: CanonicalInterval[] };

function isoWeekday(localDate: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return value === 0 ? 7 : value;
}

async function loadBusiness(client: SqlClient, businessId: string): Promise<Business> {
  const [business] = await client`select id,timezone,status::text status from business.businesses where id=${businessId}`;
  if (!business) throw new DomainError("NOT_FOUND", "Business not found", 404);
  if (business.status !== "ACTIVE") throw new DomainError("BUSINESS_NOT_BOOKABLE", "Business is not active", 409);
  return business as Business;
}

async function loadPolicy(client: SqlClient, businessId: string, requirePublic: boolean): Promise<Policy> {
  const [row] = await client`select v.id,s.revision,v.version_number "versionNumber",v.public_booking_enabled "publicBookingEnabled",v.horizon_calendar_dates "horizonCalendarDates",v.min_lead_minutes "minLeadMinutes",v.start_step_minutes "startStepMinutes",v.cancel_cutoff_minutes "cancelCutoffMinutes",v.reschedule_cutoff_minutes "rescheduleCutoffMinutes" from business.booking_policy_states s join business.booking_policy_versions v on v.business_id=s.business_id and v.id=s.current_version_id where s.business_id=${businessId}`;
  if (!row) throw new DomainError("BOOKING_POLICY_MISSING", "Booking Policy is not configured", 409);
  const policy = { ...row, revision: Number(row.revision), versionNumber: Number(row.versionNumber), horizonCalendarDates: Number(row.horizonCalendarDates), minLeadMinutes: Number(row.minLeadMinutes), startStepMinutes: Number(row.startStepMinutes), cancelCutoffMinutes: Number(row.cancelCutoffMinutes), rescheduleCutoffMinutes: Number(row.rescheduleCutoffMinutes) } as Policy;
  if (requirePublic && !policy.publicBookingEnabled) throw new DomainError("BUSINESS_NOT_BOOKABLE", "Public booking is disabled", 409);
  return policy;
}

async function loadServices(client: SqlClient, businessId: string, serviceIds: string[], requirePublic: boolean): Promise<ServiceRequirement[]> {
  const rows = await client`select s.id,s.lifecycle::text lifecycle,s.publication::text publication,s.current_terms_version_id "currentTermsVersionId",c.lifecycle::text "categoryLifecycle",t.duration_minutes "durationMinutes",t.pre_buffer_minutes "preBufferMinutes",t.post_buffer_minutes "postBufferMinutes" from catalog.services s left join catalog.service_categories c on c.business_id=s.business_id and c.id=s.category_id left join catalog.service_terms_versions t on t.business_id=s.business_id and t.service_id=s.id and t.id=s.current_terms_version_id where s.business_id=${businessId} and s.id=any(${serviceIds}::uuid[])`;
  const byId = new Map(rows.map(row => [row.id as string, row]));
  return serviceIds.map(id => {
    const row = byId.get(id);
    if (!row || row.lifecycle !== "ACTIVE" || !row.currentTermsVersionId || row.categoryLifecycle !== "ACTIVE" || (requirePublic && row.publication !== "PUBLISHED")) {
      throw new DomainError("SERVICE_NOT_BOOKABLE", "A selected Service is not bookable", 409, { serviceId: id });
    }
    return { id, durationMinutes: Number(row.durationMinutes), preBufferMinutes: Number(row.preBufferMinutes), postBufferMinutes: Number(row.postBufferMinutes) };
  });
}

async function loadBaseBusinessIntervals(client: SqlClient, businessId: string, localDate: string): Promise<CanonicalInterval[]> {
  const [exception] = await client`select id from business.business_date_exceptions where business_id=${businessId} and local_date=${localDate}`;
  if (exception) {
    const rows = await client`select start_minute "startMinute",end_minute "endMinute" from business.business_date_exception_intervals where business_id=${businessId} and exception_id=${exception.id} order by start_minute`;
    return rows.map(row => ({ startMinute: Number(row.startMinute), endMinute: Number(row.endMinute) }));
  }
  const weekday = isoWeekday(localDate);
  const rows = await client`select i.start_minute "startMinute",i.end_minute "endMinute" from business.business_hours_configs c join business.business_hours_intervals i on i.business_id=c.business_id and i.config_id=c.id where c.business_id=${businessId} and i.weekday=${weekday} order by i.start_minute`;
  return rows.map(row => ({ startMinute: Number(row.startMinute), endMinute: Number(row.endMinute) }));
}

async function loadCandidateIds(client: SqlClient, businessId: string, serviceIds: string[], preference: ProfessionalPreference): Promise<string[]> {
  const specific = preference.type === "SPECIFIC" ? preference.staffMemberId : null;
  const candidates = await client`select sm.id from team.staff_members sm join team.staff_service_sets sets on sets.business_id=sm.business_id and sets.staff_member_id=sm.id join team.staff_service_assignments a on a.business_id=sets.business_id and a.staff_service_set_id=sets.id and a.service_id=any(${serviceIds}::uuid[]) where sm.business_id=${businessId} and sm.employment_status='ACTIVE' and sm.access_status='ACTIVE' and (${specific}::uuid is null or sm.id=${specific}::uuid) group by sm.id having count(distinct a.service_id)=${serviceIds.length}`;
  const ids = candidates.map(row => row.id as string);
  if (preference.type === "SPECIFIC" && !ids.length) throw new DomainError("PROFESSIONAL_NOT_ELIGIBLE", "Professional cannot perform the selected Services", 409);
  return ids;
}

async function loadStaffBase(client: SqlClient, businessId: string, staffMemberId: string, localDate: string): Promise<CanonicalInterval[]> {
  const [exception] = await client`select id from team.staff_date_exceptions where business_id=${businessId} and staff_member_id=${staffMemberId} and local_date=${localDate}`;
  if (exception) {
    const rows = await client`select start_minute "startMinute",end_minute "endMinute" from team.staff_date_exception_intervals where business_id=${businessId} and exception_id=${exception.id} order by start_minute`;
    return rows.map(row => ({ startMinute:Number(row.startMinute),endMinute:Number(row.endMinute) }));
  }
  const weekday=isoWeekday(localDate);
  const rows=await client`select i.start_minute "startMinute",i.end_minute "endMinute" from team.staff_weekly_schedules s join team.staff_schedule_intervals i on i.business_id=s.business_id and i.weekly_schedule_id=s.id where s.business_id=${businessId} and s.staff_member_id=${staffMemberId} and i.weekday=${weekday} order by i.start_minute`;
  return rows.map(row=>({startMinute:Number(row.startMinute),endMinute:Number(row.endMinute)}));
}

async function loadBlocks(client: SqlClient,businessId:string,staffMemberId:string,localDate:string,timezone:string){
  const unavailable=await client`select start_minute "startMinute",end_minute "endMinute" from team.staff_effective_unavailability where business_id=${businessId} and staff_member_id=${staffMemberId} and local_date=${localDate} and released_at is null`;
  const allocations=await client`select source_type::text "sourceType",extract(hour from occupied_start_at at time zone ${timezone})::int*60+extract(minute from occupied_start_at at time zone ${timezone})::int "startMinute",case when (occupied_end_at at time zone ${timezone})::date>${localDate}::date then 1440 else extract(hour from occupied_end_at at time zone ${timezone})::int*60+extract(minute from occupied_end_at at time zone ${timezone})::int end "endMinute",extract(epoch from (occupied_end_at-occupied_start_at))/60 "minutes" from availability.resource_allocations where business_id=${businessId} and staff_member_id=${staffMemberId} and local_date=${localDate} and status='ACTIVE'`;
  return {
    unavailable: unavailable.map(row=>({startMinute:Number(row.startMinute),endMinute:Number(row.endMinute)})),
    operational: allocations.filter(row=>row.sourceType==="OPERATIONAL_BLOCK").map(row=>({startMinute:Number(row.startMinute),endMinute:Number(row.endMinute)})),
    occupied: allocations.map(row=>({startMinute:Number(row.startMinute),endMinute:Number(row.endMinute)})),
    confirmedMinutes: allocations.filter(row=>row.sourceType==="RESERVATION").reduce((sum,row)=>sum+Number(row.minutes),0)
  };
}

async function candidatesForDate(client:SqlClient,business:Business,serviceIds:string[],localDate:string,preference:ProfessionalPreference):Promise<Candidate[]>{
  const businessIntervals=await loadBaseBusinessIntervals(client,business.id,localDate);if(!businessIntervals.length)return[];
  const ids=await loadCandidateIds(client,business.id,serviceIds,preference);const result:Candidate[]=[];
  for(const id of ids){const staff=await loadStaffBase(client,business.id,id,localDate);if(!staff.length)continue;const blocks=await loadBlocks(client,business.id,id,localDate,business.timezone);const intersected=intersectIntervals(businessIntervals,staff);const capacityBase=subtractIntervals(intersected,[...blocks.unavailable,...blocks.operational]);const capacityMinutes=totalMinutes(capacityBase);if(capacityMinutes<=0)continue;result.push({id,capacityMinutes,confirmedMinutes:blocks.confirmedMinutes,available:subtractIntervals(capacityBase,blocks.occupied.filter(block=>!blocks.operational.some(op=>op.startMinute===block.startMinute&&op.endMinute===block.endMinute)))})}return result;
}

export type ResolvedSlot={staffMemberId:string;localDate:string;visibleStartMinute:number;visibleEndMinute:number;occupiedStartMinute:number;occupiedEndMinute:number;visibleStartAt:Date;visibleEndAt:Date;occupiedStartAt:Date;occupiedEndAt:Date;occupiedMinutes:number;visibleMinutes:number;policy:Policy;services:ServiceRequirement[]};

export async function resolveSlot(client:SqlClient,input:{businessId:string;serviceIds:string[];localDate:string;visibleStartMinute:number;professionalPreference:ProfessionalPreference;requirePublic:boolean;now:Date;termsOverride?:ServiceRequirement[];allowPastSlot?:boolean}):Promise<ResolvedSlot>{
  if (new Set(input.serviceIds).size !== input.serviceIds.length) throw new DomainError("VALIDATION_ERROR", "Service IDs must be distinct", 400);
  const business=await loadBusiness(client,input.businessId);const policy=await loadPolicy(client,input.businessId,input.requirePublic);const today=businessLocalDate(input.now,business.timezone);
  // `allowPastSlot` se reserva para operaciones que CONSERVAN un turno ya
  // existente (reasignación de profesional): no crean un compromiso comercial
  // nuevo, por lo que el horizonte de reserva y la anticipación no aplican.
  if(!input.allowPastSlot)assertWithinHorizon(input.localDate,today,policy.horizonCalendarDates);
  if(input.visibleStartMinute%policy.startStepMinutes!==0)throw new DomainError("NO_AVAILABILITY","The requested start is outside the booking cadence",409);
  const services=await loadServices(client,input.businessId,input.serviceIds,input.requirePublic);const requirements= input.termsOverride && input.termsOverride.length === input.serviceIds.length ? input.termsOverride : services;const sequence=composeServiceSequence(input.visibleStartMinute,requirements);if(sequence.occupiedStartMinute<0||sequence.occupiedEndMinute>1440)throw new DomainError("NO_AVAILABILITY","The service sequence crosses the operational date",409);
  const candidates=await candidatesForDate(client,business,input.serviceIds,input.localDate,input.professionalPreference);const available=candidates.filter(candidate=>intervalContains(candidate.available,sequence.occupiedStartMinute,sequence.occupiedEndMinute));if(!available.length)throw new DomainError("SLOT_CONFLICT","The requested slot is no longer available",409);
  const visibleStartAt=localDateTimeToInstant(input.localDate,sequence.visibleStartMinute,business.timezone);const occupiedStartAt=localDateTimeToInstant(input.localDate,sequence.occupiedStartMinute,business.timezone);const visibleEndAt=localDateTimeToInstant(input.localDate,sequence.visibleEndMinute,business.timezone);const occupiedEndAt=localDateTimeToInstant(input.localDate,sequence.occupiedEndMinute,business.timezone);
  if(!input.allowPastSlot&&(occupiedStartAt.getTime()<input.now.getTime()||visibleStartAt.getTime()<input.now.getTime()+policy.minLeadMinutes*60000))throw new DomainError("PAST_START_TIME","Start or required preparation is already in the past",409);
  let selected=available[0]!;if(input.professionalPreference.type==="ANY"){const seed=`${input.businessId}:${input.localDate}:${input.visibleStartMinute}:${input.serviceIds.join(",")}`;const tieOrder=deterministicCandidateOrder(seed,available.map(item=>item.id));selected=[...available].sort((a,b)=>compareRelativeLoad(a,b)||tieOrder.indexOf(a.id)-tieOrder.indexOf(b.id))[0]!;}
  return{staffMemberId:selected.id,localDate:input.localDate,visibleStartMinute:sequence.visibleStartMinute,visibleEndMinute:sequence.visibleEndMinute,occupiedStartMinute:sequence.occupiedStartMinute,occupiedEndMinute:sequence.occupiedEndMinute,visibleStartAt,visibleEndAt,occupiedStartAt,occupiedEndAt,occupiedMinutes:sequence.occupiedMinutes,visibleMinutes:sequence.visibleMinutes,policy,services};
}

export async function searchAvailability(businessId:string,raw:unknown,now:Date=new Date()){
  const input:AvailabilitySearchInput=availabilitySearchSchema.parse(raw);if(input.fromDate>input.throughDate)throw new DomainError("VALIDATION_ERROR","fromDate must be on or before throughDate",400);
  const business=await loadBusiness(database.client,businessId);const policy=await loadPolicy(database.client,businessId,true);const today=businessLocalDate(now,business.timezone);assertWithinHorizon(input.fromDate,today,policy.horizonCalendarDates);assertWithinHorizon(input.throughDate,today,policy.horizonCalendarDates);await loadServices(database.client,businessId,input.serviceIds,true);
  const days=[];for(let date=input.fromDate;date<=input.throughDate;date=addLocalDays(date,1)){const candidates=await candidatesForDate(database.client,business,input.serviceIds,date,input.professionalPreference);const starts=new Map<number,ResolvedSlot>();for(let minute=0;minute<1440;minute+=policy.startStepMinutes){try{const resolved=await resolveSlot(database.client,{businessId,serviceIds:input.serviceIds,localDate:date,visibleStartMinute:minute,professionalPreference:input.professionalPreference,requirePublic:true,now});starts.set(minute,resolved);}catch(error){if(error instanceof DomainError&&["SLOT_CONFLICT","NO_AVAILABILITY","PAST_START_TIME","TIMEZONE_AMBIGUOUS"].includes(error.code))continue;throw error;}}days.push({date,slots:[...starts.values()].map(slot=>({start:slot.visibleStartAt.toISOString(),end:slot.visibleEndAt.toISOString(),occupiedMinutes:slot.occupiedMinutes,visibleMinutes:slot.visibleMinutes,...(input.professionalPreference.type==="SPECIFIC"?{staffMemberId:slot.staffMemberId}:{})}))});if(!candidates.length&&input.professionalPreference.type==="SPECIFIC"){} }
  return{business:{id:business.id,timezone:business.timezone},policy:{id:policy.id,revision:policy.revision,versionNumber:policy.versionNumber,horizonCalendarDates:policy.horizonCalendarDates,startStepMinutes:policy.startStepMinutes,minLeadMinutes:policy.minLeadMinutes,cancelCutoffMinutes:policy.cancelCutoffMinutes,rescheduleCutoffMinutes:policy.rescheduleCutoffMinutes},serviceIds:input.serviceIds,days};
}

export async function getOwnAvailability(actorBusinessId:string,staffMemberId:string,raw:unknown,now:Date=new Date()){
  const parsed=availabilitySearchSchema.omit({professionalPreference:true}).parse(raw);return searchAvailability(actorBusinessId,{...parsed,professionalPreference:{type:"SPECIFIC",staffMemberId}},now);
}
