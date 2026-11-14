import { impactEvaluationSchema } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { rows, sql } from "../../lib/sql.js";

export async function evaluateImpact(actor: Actor, raw: unknown) {
  const input = impactEvaluationSchema.parse(raw);
  const removed = input.removedServiceIds;
  const allocations = await rows<{
    allocationId: string; staffMemberId: string; localDate: string; visibleStartAt: Date | string; visibleEndAt: Date | string; sourceType: string; sourceId: string; requiredServiceIds: string[];
  }>(sql`select a.id "allocationId",a.staff_member_id "staffMemberId",a.local_date::text "localDate",a.visible_start_at "visibleStartAt",a.visible_end_at "visibleEndAt",a.source_type::text "sourceType",a.source_id "sourceId",coalesce(array_agg(r.service_id) filter(where r.service_id is not null),'{}') "requiredServiceIds" from availability.resource_allocations a left join availability.allocation_service_requirements r on r.business_id=a.business_id and r.allocation_id=a.id where a.business_id=${actor.businessId} and a.status='ACTIVE' and a.occupied_end_at>now() ${input.staffMemberId ? sql`and a.staff_member_id=${input.staffMemberId}` : sql``} ${input.localDate ? sql`and a.local_date=${input.localDate}` : sql``} group by a.id order by a.visible_start_at`);
  const conflicts = allocations.filter(allocation => input.kind !== "STAFF_SERVICES" || removed.some(serviceId => allocation.requiredServiceIds.includes(serviceId)));
  return {
    evaluatedAt: new Date().toISOString(),
    kind: input.kind,
    conflictCount: conflicts.length,
    canApply: conflicts.length === 0,
    conflicts: conflicts.map(item => ({ ...item, visibleStartAt: new Date(item.visibleStartAt).toISOString(), visibleEndAt: new Date(item.visibleEndAt).toISOString() }))
  };
}

export async function listCommitmentConflicts(actor: Actor) {
  return rows(sql`select c.id,c.allocation_id "allocationId",c.reason_code "reasonCode",c.detected_at "detectedAt",c.status::text status,a.staff_member_id "staffMemberId",a.local_date::text "localDate",a.visible_start_at "visibleStartAt" from availability.commitment_conflicts c join availability.resource_allocations a on a.business_id=c.business_id and a.id=c.allocation_id where c.business_id=${actor.businessId} order by c.detected_at desc limit 200`);
}
