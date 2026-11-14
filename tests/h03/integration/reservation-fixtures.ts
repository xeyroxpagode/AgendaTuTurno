/**
 * Fixture helpers for integration tests: create a CONFIRMED reservation bound to a
 * single ACTIVE allocation, satisfying the H03.U04 bidirectional integrity trigger.
 *
 * Never used in production code paths.
 */
import { randomUUID } from "node:crypto";
import { database } from "../../../apps/api/src/lib/runtime";
import { claimAllocation, releaseAllocation, replaceAllocation } from "../../../apps/api/src/modules/availability/allocation";
import type { Tx } from "../../../apps/api/src/modules/system/operations";
import type { AllocationClaimInput } from "@youngkingz/contracts";

export type SeedInput = {
  businessId: string;
  staffMemberId: string;
  sourceId: string;
  localDate: string;
  visibleStartAt: string;
  visibleEndAt: string;
  occupiedStartAt: string;
  occupiedEndAt: string;
};

async function policyVersionId(tx: Tx | typeof database.client, businessId: string): Promise<string> {
  const [row] = await tx`select ps.current_version_id "policyVersionId" from business.booking_policy_states ps where ps.business_id=${businessId}`;
  if (!row) throw new Error("booking policy missing for fixture business");
  return row.policyVersionId as string;
}

async function insertOperation(tx: Tx | typeof database.client, businessId: string, command: string): Promise<string> {
  const operationId = randomUUID();
  await tx`insert into system.operation_attempts(operation_id,business_id,command_name,request_hash,status,response_status,completed_at) values (${operationId},${businessId},${command},'fixture','SUCCEEDED',200,now())`;
  return operationId;
}

export async function seedConfirmedReservationWithAllocation(input: SeedInput): Promise<string> {
  return database.client.begin(async tx => {
    const policyVersionIdValue = await policyVersionId(tx, input.businessId);
    const operationId = await insertOperation(tx, input.businessId, "test.fixture");
    const [alloc] = await tx`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${input.businessId},${input.staffMemberId},'RESERVATION',${input.sourceId},${input.localDate},${input.visibleStartAt},${input.visibleEndAt},${input.occupiedStartAt},${input.occupiedEndAt}) returning id`;
    await tx`insert into booking.reservations(id,business_id,status,owner_type,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,current_allocation_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
      values (${input.sourceId},${input.businessId},'CONFIRMED','GUEST',${JSON.stringify({ name: "Fixture Guest", phone: "1100000000" })}::jsonb,${input.staffMemberId},${policyVersionIdValue},'{}'::jsonb,1000,'ARS',${alloc!.id},${input.visibleStartAt},${input.visibleEndAt},${input.occupiedStartAt},${input.occupiedEndAt},${input.localDate},'America/Argentina/Buenos_Aires',${operationId})`;
    return alloc!.id as string;
  });
}

export async function claimReservationWithBooking(tx: Tx, input: AllocationClaimInput, now: Date) {
  const claimed = await claimAllocation(tx, input, now);
  const policyVersionIdValue = await policyVersionId(tx, input.businessId);
  const operationId = await insertOperation(tx, input.businessId, "test.claim-fixture");
  await tx`insert into booking.reservations(id,business_id,status,owner_type,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,current_allocation_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
    values (${input.sourceId},${input.businessId},'CONFIRMED','GUEST',${JSON.stringify({ name: "Fixture Guest", phone: "1100000000" })}::jsonb,${claimed.staffMemberId},${policyVersionIdValue},'{}'::jsonb,1000,'ARS',${claimed.allocationId},${claimed.visibleStartAt.toISOString()},${claimed.visibleEndAt.toISOString()},${claimed.occupiedStartAt.toISOString()},${claimed.occupiedEndAt.toISOString()},${input.localDate},'America/Argentina/Buenos_Aires',${operationId})`;
  return claimed;
}

/** Replace + reservation update in one transaction (mirrors booking.reschedule). */
export async function replaceReservationWithBooking(
  tx: Tx,
  input: { origin: { businessId: string; sourceType: AllocationClaimInput["sourceType"]; sourceId: string }; destination: AllocationClaimInput; releaseReason: string },
  now: Date,
) {
  const replaced = await replaceAllocation(tx, input, now);
  const slot = replaced.destination;
  await tx`update booking.reservations
     set current_allocation_id=${slot.allocationId},
         staff_member_id=${slot.staffMemberId},
         starts_at=${slot.visibleStartAt.toISOString()},
         ends_at=${slot.visibleEndAt.toISOString()},
         occupied_starts_at=${slot.occupiedStartAt.toISOString()},
         occupied_ends_at=${slot.occupiedEndAt.toISOString()},
         business_local_date=${slot.localDate},
         revision=revision+1,
         updated_at=now()
   where business_id=${input.origin.businessId} and id=${input.origin.sourceId}`;
  return replaced;
}

/** Release (cancel) + reservation cancellation in one transaction (mirrors booking.cancel). */
export async function cancelReservationWithBooking(
  tx: Tx,
  input: { businessId: string; sourceType: AllocationClaimInput["sourceType"]; sourceId: string; reason: string },
) {
  const released = await releaseAllocation(tx, input);
  await tx`update booking.reservations
     set status='CANCELLED', cancelled_at=now(), revision=revision+1, updated_at=now()
   where business_id=${input.businessId} and id=${input.sourceId} and status='CONFIRMED'`;
  return released;
}
