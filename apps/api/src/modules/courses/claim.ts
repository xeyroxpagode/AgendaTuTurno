import { DomainError } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";
import { revalidateAuthority } from "../system/operations.js";
import { lockAvailabilityGuard } from "../availability/guard.js";
import { loadBaseBusinessIntervals, loadStaffBase } from "../availability/queries.js";
import { translateAllocationError } from "../availability/allocation.js";
import { assertInstructorEligible, businessTimezone, composeLocalInterval } from "./domain.js";

export type CourseClaimInput = {
  businessId: string;
  sessionId: string;
  instructorStaffMemberId: string;
  localDate: string;
  startMinute: number;
  durationMinutes: number;
};

/**
 * H07 · CAP-07-03 · Claim PROPIO para sesiones de curso.
 *
 * NO reutiliza `claimAllocation`: esa función exige `serviceIds` e inserta
 * `allocation_service_requirements` (requirements de reserva incompatibles).
 * Aquí se construyen visible/occupied desde la entrada LOCAL y se usa el
 * MISMO guard por Business, el MISMO EXCLUDE GiST y el MISMO rango `[inicio,fin)`.
 */
export async function claimCourseSession(tx: Tx, actor: Actor, input: CourseClaimInput) {
  if (actor.businessId !== input.businessId) throw new DomainError("FORBIDDEN", "Allocation Business does not match the actor context", 403);

  await lockAvailabilityGuard(tx, input.businessId);
  const timezone = await businessTimezone(input.businessId, tx);
  await assertInstructorEligible(tx, input.businessId, input.instructorStaffMemberId);

  const interval = composeLocalInterval({
    localDate: input.localDate,
    startMinute: input.startMinute,
    durationMinutes: input.durationMinutes,
    timezone
  });

  // Matriz de ausencias ÚNICA (NEW-01/NEW-02): una ausencia aprobada que
  // solape genera conflicto REAL; NUNCA cancela la sesión ni borra reservas.
  const conflicts = await tx`
    select id, reason_code "reasonCode" from availability.course_session_absence_conflicts(
      ${input.businessId}, ${input.instructorStaffMemberId}, ${input.localDate},
      ${interval.startMinute}, ${interval.endMinute})`;
  if (conflicts.length) {
    throw new DomainError("AVAILABILITY_IMPACT_CONFLICT", "The instructor has an effective absence overlapping this session", 409, {
      conflicts: conflicts.map((item) => ({ id: item.id, reasonCode: item.reasonCode }))
    });
  }

  const hours = await loadBaseBusinessIntervals(tx, input.businessId, input.localDate);
  const schedule = await loadStaffBase(tx, input.businessId, input.instructorStaffMemberId, input.localDate);
  const covers = (block: { startMinute: number; endMinute: number }) =>
    block.startMinute <= interval.startMinute && block.endMinute >= interval.endMinute;
  if (!hours.some(covers) || !schedule.some(covers)) {
    throw new DomainError("NO_AVAILABILITY", "La sesión está fuera del horario habilitado del negocio o del instructor", 409);
  }

  try {
    const [allocation] = await tx`
      insert into availability.resource_allocations(
        business_id, staff_member_id, source_type, source_id, local_date,
        visible_start_at, visible_end_at, occupied_start_at, occupied_end_at)
      values (${input.businessId}, ${input.instructorStaffMemberId}, 'COURSE_SESSION', ${input.sessionId},
              ${input.localDate}, ${interval.occupiedStartAt.toISOString()}, ${interval.occupiedEndAt.toISOString()},
              ${interval.occupiedStartAt.toISOString()}, ${interval.occupiedEndAt.toISOString()})
      returning id`;
    const allocationId = allocation!.id as string;
    // Autoridad revalidada DENTRO de la transacción, antes del commit.
    await revalidateAuthority(tx, actor, "courses.sessions.manage", { staffMemberId: input.instructorStaffMemberId });
    return { allocationId, occupiedStartAt: interval.occupiedStartAt, occupiedEndAt: interval.occupiedEndAt };
  } catch (error) {
    // 23P01/23505 -> SLOT_CONFLICT; 22000/23514 -> INVALID_INTERVAL.
    // Cualquier otro error (incluida la revalidación) se propaga intacto.
    translateAllocationError(error);
  }
}
