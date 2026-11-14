/**
 * H03.U04 · Excepciones Staff autorizadas (override cancel/reschedule).
 */
import { DomainError } from "@youngkingz/contracts";
import { cancelBooking } from "./cancel.js";
import { rescheduleBooking } from "./reschedule.js";
import { database } from "../../../lib/runtime.js";

export async function staffExceptionCancel(input: {
  businessId: string; reservationId: string; expectedRevision: number; reason: string;
  actorAccountId: string; operationId: string; now?: Date;
}) {
  if (!input.reason || input.reason.trim().length < 3) throw new DomainError("VALIDATION_ERROR", "reason is required", 400);
  const result = await cancelBooking({
    businessId: input.businessId,
    reservationId: input.reservationId,
    expectedRevision: input.expectedRevision,
    principal: "STAFF",
    accountId: input.actorAccountId,
    reason: input.reason,
    operationId: input.operationId,
    bypassCutoff: true,
    now: input.now,
  });
  await database.client.begin(async (tx) => {
    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,changes,reason_code)
      values (${input.businessId},${input.reservationId},coalesce((select max(sequence) from booking.reservation_events where business_id=${input.businessId} and reservation_id=${input.reservationId}),0)+1,'STAFF_EXCEPTION_APPLIED',${input.operationId},'STAFF',${JSON.stringify({ overrideType: "cancel", reason: input.reason, actorAccountId: input.actorAccountId })}::jsonb,${input.reason ?? null})`;
  });
  return result;
}

export async function staffExceptionReschedule(input: {
  businessId: string; reservationId: string; expectedRevision: number;
  localDate: string; visibleStart: string; professionalPreference?: { type: "ANY" } | { type: "SPECIFIC"; staffMemberId: string };
  reason: string; actorAccountId: string; operationId: string; now?: Date;
}) {
  if (!input.reason || input.reason.trim().length < 3) throw new DomainError("VALIDATION_ERROR", "reason is required", 400);
  const result = await rescheduleBooking({
    businessId: input.businessId,
    reservationId: input.reservationId,
    expectedRevision: input.expectedRevision,
    principal: "STAFF",
    accountId: input.actorAccountId,
    localDate: input.localDate,
    visibleStart: input.visibleStart,
    professionalPreference: input.professionalPreference,
    allowStaffOverride: true,
    reason: input.reason,
    operationId: input.operationId,
    bypassCutoff: true,
    now: input.now,
  });
  return result;
}