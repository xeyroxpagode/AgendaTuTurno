import { DomainError, type AllocationClaimInput } from "@youngkingz/contracts";
import type { Tx } from "../system/operations.js";
import { lockAvailabilityGuard } from "./guard.js";
import { parseClock } from "./temporal.js";
import { resolveSlot } from "./queries.js";
import type { Actor } from "../iam/authorization.js";
import { executeOperation } from "../system/operations.js";

export async function quoteAllocation(tx: Tx, input: AllocationClaimInput, now: Date = new Date()) {
  return resolveSlot(tx, {
    businessId: input.businessId,
    serviceIds: input.serviceIds,
    localDate: input.localDate,
    visibleStartMinute: parseClock(input.visibleStart),
    professionalPreference: input.professionalPreference,
    requirePublic: false,
    now,
    termsOverride: input.historicalTerms,
    allowPastSlot: input.allowPastSlot,
  });
}

export async function claimAllocation(tx: Tx, input: AllocationClaimInput, now: Date = new Date()) {
  await lockAvailabilityGuard(tx, input.businessId);
  const slot = await quoteAllocation(tx, input, now);
  try {
    const [allocation] = await tx`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${input.businessId},${slot.staffMemberId},${input.sourceType},${input.sourceId},${input.localDate},${slot.visibleStartAt.toISOString()},${slot.visibleEndAt.toISOString()},${slot.occupiedStartAt.toISOString()},${slot.occupiedEndAt.toISOString()}) returning id,status::text status`;
    for (const serviceId of input.serviceIds) await tx`insert into availability.allocation_service_requirements(business_id,allocation_id,service_id) values (${input.businessId},${allocation!.id},${serviceId})`;
    return { allocationId: allocation!.id as string, status: allocation!.status as "ACTIVE", ...slot };
  } catch (error) {
    const sqlState = (error as { code?: string }).code;
    if (sqlState === "23P01" || sqlState === "23505") throw new DomainError("SLOT_CONFLICT", "The resource was occupied concurrently", 409);
    throw error;
  }
}

export async function claimAllocationOperation(actor: Actor, input: AllocationClaimInput, operationId: string, now: Date = new Date()) {
  if (actor.businessId !== input.businessId) throw new DomainError("FORBIDDEN", "Allocation Business does not match the actor context", 403);
  // H03.U04: reservations are created exclusively by booking.confirm (Reservation + Allocation in one transaction).
  if (input.sourceType === "RESERVATION") throw new DomainError("FORBIDDEN", "Reservation allocations are created by booking.confirm", 403);
  return executeOperation({ operationId, command: "availability.allocation.claim", actor, payload: input }, tx => claimAllocation(tx, input, now));
}

export async function releaseAllocation(tx: Tx, input: { businessId: string; sourceType: AllocationClaimInput["sourceType"]; sourceId: string; reason: string }) {
  await lockAvailabilityGuard(tx, input.businessId);
  const [allocation] = await tx`select id,status::text status from availability.resource_allocations where business_id=${input.businessId} and source_type=${input.sourceType} and source_id=${input.sourceId} and status='ACTIVE' for update`;
  if (!allocation) throw new DomainError("NOT_FOUND", "Active Allocation source was not found", 404);
  await tx`update availability.resource_allocations set status='RELEASED',released_at=now(),release_reason=${input.reason} where id=${allocation.id}`;
  return { allocationId: allocation.id as string, status: "RELEASED" as const, changed: true };
}

export async function replaceAllocation(tx: Tx, input: { origin: { businessId: string; sourceType: AllocationClaimInput["sourceType"]; sourceId: string }; destination: AllocationClaimInput; releaseReason: string }, now: Date = new Date()) {
  if (input.origin.businessId !== input.destination.businessId) throw new DomainError("FORBIDDEN", "Allocation cannot move across Businesses", 403);
  await lockAvailabilityGuard(tx, input.origin.businessId);
  const [origin] = await tx`select id,status::text status from availability.resource_allocations where business_id=${input.origin.businessId} and source_type=${input.origin.sourceType} and source_id=${input.origin.sourceId} and status='ACTIVE' order by created_at desc, id desc for update`;
  if (!origin || origin.status !== "ACTIVE") throw new DomainError("NOT_FOUND", "Active origin Allocation was not found", 404);
  await tx`update availability.resource_allocations set status='RELEASED',released_at=now(),release_reason=${input.releaseReason} where id=${origin.id}`;
  const destination = await claimAllocation(tx, input.destination, now);
  return { originAllocationId: origin.id as string, destination };
}
