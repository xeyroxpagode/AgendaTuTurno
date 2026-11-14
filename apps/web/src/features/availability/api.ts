import { api } from "@/lib/api/client";
import type { BookingPolicy, BusinessHours, DateException, WeeklyScheduleWeek } from "@youngkingz/contracts";

type Mutation<T>={data:T;replayed:boolean};
export type { BookingPolicy, BusinessHours, DateException, WeeklyScheduleWeek };

export const getBusinessHours=()=>api<BusinessHours>("/v1/businesses/current/hours");
export const saveBusinessHours=async(expectedRevision:number,week:WeeklyScheduleWeek)=>(await api<Mutation<BusinessHours&{changed:boolean}>>("/v1/businesses/current/hours",{method:"PUT",operationId:crypto.randomUUID(),body:JSON.stringify({expectedRevision,week})})).data;
export const getBookingPolicy=()=>api<BookingPolicy|null>("/v1/businesses/current/booking-policy");
export const getBookingPolicyHistory=()=>api<BookingPolicy[]>("/v1/businesses/current/booking-policy/history");
export const saveBookingPolicy=async(body:{expectedRevision:number;publicBookingEnabled:boolean;horizonCalendarDates:number;minLeadMinutes:number;startStepMinutes:number;cancelCutoffMinutes:number;rescheduleCutoffMinutes:number})=>(await api<Mutation<BookingPolicy&{changed:boolean}>>("/v1/businesses/current/booking-policy",{method:"PUT",operationId:crypto.randomUUID(),body:JSON.stringify(body)})).data;
export const listBusinessExceptions=()=>api<DateException[]>("/v1/businesses/current/date-exceptions");
export const saveBusinessException=async(date:string,body:{expectedRevision:number;reason:string|null;intervals:Array<{start:string;end:string}>})=>(await api<Mutation<DateException&{changed:boolean}>>(`/v1/businesses/current/date-exceptions/${date}`,{method:"PUT",operationId:crypto.randomUUID(),body:JSON.stringify(body)})).data;
export const listStaffExceptions=(staffId:string)=>api<DateException[]>(`/v1/staff/${staffId}/date-exceptions`);
export const saveStaffException=async(staffId:string,date:string,body:{expectedRevision:number;reason:string|null;intervals:Array<{start:string;end:string}>})=>(await api<Mutation<DateException&{changed:boolean}>>(`/v1/staff/${staffId}/date-exceptions/${date}`,{method:"PUT",operationId:crypto.randomUUID(),body:JSON.stringify(body)})).data;
export const searchPublicAvailability=(businessId:string,body:{serviceIds:string[];fromDate:string;throughDate:string;professionalPreference:{type:"ANY"}|{type:"SPECIFIC";staffMemberId:string}})=>api<{days:Array<{date:string;slots:Array<{start:string;end:string;occupiedMinutes:number}>}>}>(`/v1/public/businesses/${businessId}/availability/search`,{method:"POST",body:JSON.stringify(body)});
export const evaluateImpact=(body:{kind:string;staffMemberId?:string;localDate?:string;removedServiceIds:string[]})=>api<{conflictCount:number;canApply:boolean;conflicts:Array<{allocationId:string;localDate:string}>}>("/v1/availability/impacts/evaluate",{method:"POST",body:JSON.stringify(body)});
export async function getAvailabilityContext(){const[context,catalog,team]=await Promise.all([api<{businessId:string;capabilities:string[]}>("/v1/iam/context"),api<{items:Array<{id:string;name:string;lifecycle:string;publication:string}>}>("/v1/catalog/services?limit=100"),api<{items:Array<{staffMemberId:string;displayName:string}>}>("/v1/schedules/team")]);return[context,catalog.items,team] as const;}
