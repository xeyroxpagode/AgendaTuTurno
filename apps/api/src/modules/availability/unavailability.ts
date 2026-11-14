import { DomainError } from "@youngkingz/contracts";
import type { Tx } from "../system/operations.js";
import { lockAvailabilityGuard } from "./guard.js";

export async function applyEffectiveUnavailability(tx:Tx,input:{businessId:string;staffMemberId:string;sourceType:"APPLIED_ABSENCE"|"OPERATIONAL_BLOCK";sourceId:string;localDate:string;startMinute:number;endMinute:number;operationId:string;urgent?:boolean}){
  if(input.startMinute<0||input.endMinute>1440||input.startMinute>=input.endMinute)throw new DomainError("VALIDATION_ERROR","Effective unavailability interval is invalid",400);
  await lockAvailabilityGuard(tx,input.businessId);
  const[staff]=await tx`select id from team.staff_members where business_id=${input.businessId} and id=${input.staffMemberId} for update`;if(!staff)throw new DomainError("NOT_FOUND","Staff member not found",404);
  const conflicts=await tx`select id from availability.resource_allocations where business_id=${input.businessId} and staff_member_id=${input.staffMemberId} and local_date=${input.localDate} and status='ACTIVE'`;
  if(conflicts.length&&!input.urgent)throw new DomainError("AVAILABILITY_IMPACT_CONFLICT","Applied unavailability would affect commitments",409,{allocationIds:conflicts.map(item=>item.id)});
  if(input.urgent)for(const allocation of conflicts)await tx`insert into availability.commitment_conflicts(business_id,allocation_id,reason_code,source_operation_id) values (${input.businessId},${allocation.id},'URGENT_EFFECTIVE_UNAVAILABILITY',${input.operationId}) on conflict do nothing`;
  const[row]=await tx`insert into team.staff_effective_unavailability(business_id,staff_member_id,source_type,source_id,local_date,start_minute,end_minute) values (${input.businessId},${input.staffMemberId},${input.sourceType},${input.sourceId},${input.localDate},${input.startMinute},${input.endMinute}) on conflict(business_id,source_type,source_id,local_date,start_minute,end_minute) do update set released_at=null,applied_at=now() returning id,applied_at "appliedAt"`;
  return row!;
}

export async function releaseEffectiveUnavailability(tx:Tx,input:{businessId:string;sourceType:"APPLIED_ABSENCE"|"OPERATIONAL_BLOCK";sourceId:string}){
  await lockAvailabilityGuard(tx,input.businessId);
  const[released]=await tx`update team.staff_effective_unavailability set released_at=now() where business_id=${input.businessId} and source_type=${input.sourceType} and source_id=${input.sourceId} and released_at is null returning id,released_at "releasedAt"`;
  if(!released)throw new DomainError("NOT_FOUND","Active effective unavailability was not found",404);return released;
}
