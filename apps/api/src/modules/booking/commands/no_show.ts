/**
 * H03.U05 · Comando `booking.staff.no_show` — confirmación explícita de no-show.
 *
 * El no-show NUNCA se infiere por el paso del tiempo: sólo un acto explícito
 * del Staff lo confirma. A cambio, el servidor valida que la hora de turno ya
 * haya pasado (B01 §B5.9, AC-17) para no cerrar turnos futuros por error.
 *
 * Efectos (B01 §B5.9): estado `NO_SHOW` (terminal), `no_show_at`, liberación
 * de la Allocation, `revision+1` y evento `NO_SHOW_CONFIRMED` en el ledger
 * append-only. La reserva conserva su `reservation_id` y sus snapshots.
 */
import { DomainError } from "@youngkingz/contracts";
import { executePrincipalOperation, type Tx } from "../../system/operations.js";
import { lockAvailabilityGuard } from "../../availability/guard.js";
import { releaseAllocation } from "../../availability/allocation.js";
import { assertExpectedRevision, assertStatusTransition } from "../domain/reservation.js";

const NO_SHOW_COMMAND = "booking.staff.no_show";

export type StaffNoShowInput = {
  businessId: string;
  actorAccountId: string;
  actorStaffMemberId: string;
  reservationId: string;
  expectedRevision: number;
  reason?: string;
  /** Ámbito propio: sólo reservas asignadas al profesional actor. */
  selfScopeOnly: boolean;
  operationId: string;
  now?: Date;
};

export type StaffNoShowResult = {
  reservationId: string;
  status: "NO_SHOW";
  noShowAt: string;
  released: boolean;
  revision: number;
  replayed: boolean;
};

export async function confirmStaffNoShow(input: StaffNoShowInput): Promise<StaffNoShowResult> {
  const now = input.now ?? new Date();

  const result = await executePrincipalOperation<Omit<StaffNoShowResult, "replayed">>({
    operationId: input.operationId,
    command: NO_SHOW_COMMAND,
    principal: { kind: "STAFF", businessId: input.businessId, accountId: input.actorAccountId },
    payload: { reservationId: input.reservationId, expectedRevision: input.expectedRevision, reason: input.reason ?? null },
  }, async (tx) => {
    await lockAvailabilityGuard(tx, input.businessId);

    const [reservation] = await tx`select id,status,revision,staff_member_id "staffMemberId",starts_at "startsAt" from booking.reservations where business_id=${input.businessId} and id=${input.reservationId} for update`;
    if (!reservation) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);
    if (input.selfScopeOnly && reservation.staffMemberId !== input.actorStaffMemberId) {
      throw new DomainError("FORBIDDEN", "Reservation is not assigned to this professional", 403);
    }

    // `NO_SHOW` es terminal: un no-show repetido es un error, no un replay silencioso.
    assertStatusTransition(reservation.status as "CONFIRMED" | "CANCELLED" | "NO_SHOW", "NO_SHOW");
    assertExpectedRevision(Number(reservation.revision), input.expectedRevision);

    // La hora de turno debe haber pasado: no se cierra un turno futuro.
    if (new Date(reservation.startsAt as string).getTime() > now.getTime()) {
      throw new DomainError("BOOKING_NO_SHOW_WINDOW_NOT_OPEN", "The appointment time has not elapsed yet", 409, { startsAt: reservation.startsAt });
    }

    // Liberación de la Allocation en la misma transacción (trigger diferible: 0 ACTIVE).
    const released = await releaseAllocation(tx, {
      businessId: input.businessId,
      sourceType: "RESERVATION",
      sourceId: input.reservationId,
      reason: input.reason ?? "staff_no_show",
    });

    // H03.U06 · WP-11 · U05-CORR-04: `no_show_at` se persiste con el reloj
    // del SERVIDOR (`now()` de PostgreSQL) y el payload devuelve exactamente
    // ese valor persistido, no el reloj del llamante.
    const [updated] = await tx`update booking.reservations set status='NO_SHOW', no_show_at=now(), revision=revision+1, updated_at=now() where business_id=${input.businessId} and id=${input.reservationId} returning no_show_at "noShowAt", revision::int revision`;
    if (!updated) throw new DomainError("STALE_REVISION", "The reservation was modified concurrently", 409);

    const sequence = await nextSeq(tx, input.businessId, input.reservationId);
    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,actor_account_id,staff_member_id,before_revision,after_revision,changes,reason_code)
      values (${input.businessId},${input.reservationId},${sequence},'NO_SHOW_CONFIRMED',${input.operationId},'STAFF',${input.actorAccountId},${input.actorStaffMemberId},${Number(reservation.revision)},${Number(reservation.revision) + 1},${JSON.stringify({ status: { before: "CONFIRMED", after: "NO_SHOW" } })}::jsonb,${input.reason ?? null})`;

    await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${input.businessId},${input.actorAccountId},${input.operationId},'booking.reservation.no_show','bookings.no_show',${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,'RESERVATION',${input.reservationId},'SUCCEEDED',${JSON.stringify({ reason: input.reason ?? null })}::jsonb)`;

    return {
      reservationId: input.reservationId,
      status: "NO_SHOW" as const,
      noShowAt: new Date(updated!.noShowAt as Date).toISOString(),
      released: released.changed,
      revision: Number(updated!.revision),
    };
  });

  return { ...result.data, replayed: result.replayed };
}

async function nextSeq(tx: Tx, businessId: string, reservationId: string): Promise<number> {
  const [row] = await tx`select coalesce(max(sequence),0)+1 "next" from booking.reservation_events where business_id=${businessId} and reservation_id=${reservationId}`;
  return Number(row!.next);
}
