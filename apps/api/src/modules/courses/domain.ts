import { DomainError } from "@youngkingz/contracts";
import { rows, sql } from "../../lib/sql.js";
import type { Tx } from "../system/operations.js";
import { addLocalDays, localDateTimeToInstant } from "../availability/temporal.js";

/** H07 · Transiciones autorizadas. El paso del tiempo NUNCA registra realización. */
const SESSION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  SCHEDULED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["RESCHEDULED", "CANCELLED", "COMPLETED"],
  // RESCHEDULED conserva la ocupación ya confirmada: volver a CONFIRMED
  // insertaría una segunda allocation sobre el mismo intervalo y chocaría con
  // el EXCLUDE GiST. La transición se elimina en lugar de degradar el error.
  RESCHEDULED: ["RESCHEDULED", "CANCELLED", "COMPLETED"],
  CANCELLED: [],
  COMPLETED: []
};

export function assertSessionTransition(from: string, to: string): void {
  if (!SESSION_TRANSITIONS[from]?.includes(to)) {
    throw new DomainError("SESSION_STATE_INVALID", `Session transition ${from} -> ${to} is not allowed`, 409, { from, to });
  }
}

/** El instructor debe ser un profesional REAL, ACTIVO y del mismo Business. */
export async function assertInstructorEligible(tx: Tx, businessId: string, staffMemberId: string): Promise<void> {
  const [eligible] = await tx`
    select sm.id from team.staff_members sm
    where sm.id=${staffMemberId} and sm.business_id=${businessId}
      and sm.access_status='ACTIVE' and sm.employment_status='ACTIVE'
      and (
        exists (select 1 from team.professional_profiles pp where pp.business_id=sm.business_id and pp.staff_member_id=sm.id and pp.status='ACTIVE')
        or exists (select 1 from iam.role_assignments ra where ra.business_id=sm.business_id and ra.staff_member_id=sm.id and ra.role='BARBER' and ra.revoked_at is null and ra.effective_at is not null)
      )`;
  if (!eligible) throw new DomainError("INSTRUCTOR_NOT_ELIGIBLE", "The instructor is not an active professional of this business", 409, { staffMemberId });
}

export type LocalSessionInterval = {
  localDate: string;
  startMinute: number;
  endMinute: number;
  timezone: string;
  occupiedStartAt: Date;
  occupiedEndAt: Date;
};

/**
 * Entrada LOCAL + zona horaria -> instantes UTC.
 * `localDateTimeToInstant` ya rechaza horas inexistentes/ambiguas por DST
 * (TIMEZONE_AMBIGUOUS) y la composición de buffers se reutiliza del motor H03.
 */
export function composeLocalInterval(input: { localDate: string; startMinute: number; durationMinutes: number; timezone: string }): LocalSessionInterval {
  const endMinute = input.startMinute + input.durationMinutes;
  if (input.startMinute < 0 || endMinute > 1440) throw new DomainError("INVALID_INTERVAL", "The session exceeds the operational date", 400);
  let occupiedEndAt: Date;
  if (endMinute === 1440) {
    occupiedEndAt = localDateTimeToInstant(addLocalDays(input.localDate, 1), 0, input.timezone);
  } else {
    occupiedEndAt = localDateTimeToInstant(input.localDate, endMinute, input.timezone);
  }
  const occupiedStartAt = localDateTimeToInstant(input.localDate, input.startMinute, input.timezone);
  if (occupiedEndAt.getTime() <= occupiedStartAt.getTime()) throw new DomainError("INVALID_INTERVAL", "The session interval must be positive", 400);
  return { localDate: input.localDate, startMinute: input.startMinute, endMinute, timezone: input.timezone, occupiedStartAt, occupiedEndAt };
}

export async function businessTimezone(businessId: string, tx?: Tx): Promise<string> {
  const result = tx
    ? await tx`select timezone from business.businesses where id=${businessId}` as unknown as { timezone: string }[]
    : await rows<{ timezone: string }>(sql`select timezone from business.businesses where id=${businessId}`);
  const timezone = result[0]?.timezone;
  if (!timezone) throw new DomainError("NOT_FOUND", "Business not found", 404);
  return String(timezone);
}
