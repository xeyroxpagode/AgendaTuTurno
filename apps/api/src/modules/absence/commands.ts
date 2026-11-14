/**
 * H03.U06 · CAP-03-07 · Ausencias y conflictos — comandos.
 *
 * Autoridad del módulo:
 *  · `absence_requests` es la ÚNICA fuente de verdad del ciclo de vida de la
 *    ausencia (solicitud → aprobación → aplicación).
 *  · La indisponibilidad efectiva se materializa en
 *    `team.staff_effective_unavailability` con `source_type='APPLIED_ABSENCE'`
 *    y `source_id` = id de la solicitud: es el mismo groundwork que ya leía
 *    el motor de Availability (`availability/queries.ts::loadBlocks`).
 *  · Los compromisos afectados se detectan SIEMPRE dentro de la transacción
 *    autoritativa, con `FOR UPDATE` sobre las allocations: la lista de
 *    conflictos que muestra el frontend NUNCA es la fuente de verdad.
 *  · `lockAvailabilityGuard` se adquiere PRIMERO en todo comando que toque
 *    allocations o indisponibilidad (orden de locks unificado con U03/U04/U05).
 */
import { DomainError } from "@youngkingz/contracts";
import type { AbsenceStatus } from "@youngkingz/contracts";
import { database } from "../../lib/runtime.js";
import { executePrincipalOperation, type Tx } from "../system/operations.js";
import { lockAvailabilityGuard } from "../availability/guard.js";
import { assertWithinHorizon, businessLocalDate, localDateTimeToInstant } from "../availability/temporal.js";
import type { Actor } from "../iam/authorization.js";
import { assertAbsenceInterval, assertAbsenceTransition, intervalsOverlap } from "./domain.js";

const REQUEST_COMMAND = "absence.request";
const APPROVE_COMMAND = "absence.approve";
const REJECT_COMMAND = "absence.reject";
const WITHDRAW_COMMAND = "absence.withdraw";
const APPLY_COMMAND = "absence.apply";
const CONFLICT_SYNC_COMMAND = "absence.conflicts.sync";

/** Razón de conflicto registrada en `availability.commitment_conflicts`. */
export const ABSENCE_CONFLICT_REASON = "APPLIED_ABSENCE";

type AbsenceRow = {
  id: string;
  businessId: string;
  staffMemberId: string;
  requestedByAccountId: string;
  createdOperationId: string;
  localDate: string;
  startMinute: number;
  endMinute: number;
  reason: string | null;
  status: AbsenceStatus;
  revision: number;
  approvedByAccountId: string | null;
  approvedAt: Date | null;
  rejectReason: string | null;
  appliedAt: Date | null;
};

/* ─────────────────────────── alcance ─────────────────────────── */

/**
 * Alcance de lectura/escritura de ausencias (B01 §5).
 * `BARBER` opera únicamente sobre sus propias ausencias; `OWNER` y
 * `RECEPTIONIST` operan sobre todo el Business.
 */
export function resolveAbsenceScope(actor: Actor): { staffMemberId?: string } {
  return actor.role === "BARBER" ? { staffMemberId: actor.staffMemberId } : {};
}

/** ¿El actor puede operar sobre la ausencia de este profesional? */
function assertAbsenceScope(actor: Actor, staffMemberId: string): void {
  const scope = resolveAbsenceScope(actor);
  if (scope.staffMemberId && scope.staffMemberId !== staffMemberId) {
    throw new DomainError("FORBIDDEN", "Absence is not within the actor's professional scope", 403);
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

async function loadAbsence(tx: Tx, businessId: string, absenceId: string): Promise<AbsenceRow> {
  const [row] = await tx`
    select id, business_id "businessId", staff_member_id "staffMemberId",
           requested_by_account_id "requestedByAccountId",
           created_operation_id "createdOperationId",
           local_date::text "localDate", start_minute "startMinute", end_minute "endMinute",
           reason, status::text status, revision::int revision,
           approved_by_account_id "approvedByAccountId", approved_at "approvedAt",
           reject_reason "rejectReason", applied_at "appliedAt"
      from absence.absence_requests
     where business_id = ${businessId} and id = ${absenceId}
     for update`;
  if (!row) throw new DomainError("NOT_FOUND", "Absence request not found", 404);
  return row as AbsenceRow;
}

async function nextAbsenceSequence(tx: Tx, businessId: string, absenceId: string): Promise<number> {
  const [row] = await tx`select coalesce(max(sequence),0)+1 "next" from absence.absence_events where business_id=${businessId} and absence_request_id=${absenceId}`;
  return Number(row!.next);
}

async function appendAbsenceEvent(tx: Tx, input: {
  businessId: string;
  absenceRequestId: string;
  eventType: string;
  operationId: string;
  actor: Actor;
  beforeRevision: number | null;
  afterRevision: number | null;
  changes: Record<string, unknown>;
  reasonCode?: string | null;
  staffMemberId?: string | null;
}) {
  const sequence = await nextAbsenceSequence(tx, input.businessId, input.absenceRequestId);
  await tx`
    insert into absence.absence_events(business_id,absence_request_id,sequence,event_type,operation_id,principal_type,actor_account_id,staff_member_id,before_revision,after_revision,changes,reason_code)
    values (${input.businessId},${input.absenceRequestId},${sequence},${input.eventType},${input.operationId},'STAFF',${input.actor.accountId},${input.staffMemberId ?? input.actor.staffMemberId},${input.beforeRevision},${input.afterRevision},${JSON.stringify(input.changes)}::jsonb,${input.reasonCode ?? null})`;
}

async function businessTimezone(tx: Tx, businessId: string): Promise<string> {
  const [row] = await tx`select timezone from business.businesses where id=${businessId}`;
  if (!row) throw new DomainError("NOT_FOUND", "Business not found", 404);
  return row!.timezone as string;
}

async function bookingHorizon(tx: Tx, businessId: string): Promise<number> {
  const [row] = await tx`
    select v.horizon_calendar_dates "horizonCalendarDates"
      from business.booking_policy_states s
      join business.booking_policy_versions v on v.business_id=s.business_id and v.id=s.current_version_id
     where s.business_id=${businessId}`;
  if (!row) throw new DomainError("BOOKING_POLICY_MISSING", "Booking Policy is not configured", 409);
  return Number(row!.horizonCalendarDates);
}

/**
 * Commitments afectados por la ausencia: allocations ACTIVE del profesional en
 * la fecha local cuyo rango ocupado se solapa con el intervalo de la ausencia.
 *
 * La comparación se hace en tiempo absoluto (tstzrange) sobre la zona horaria
 * real del Business, no con aritmética de minutos: es la única forma correcta
 * alrededor de los cambios de hora.
 */
export async function detectAffectedCommitments(tx: Tx, input: {
  businessId: string;
  staffMemberId: string;
  localDate: string;
  startMinute: number;
  endMinute: number;
  timezone: string;
}) {
  const rangeStart = localDateTimeToInstant(input.localDate, input.startMinute, input.timezone);
  const rangeEnd = localDateTimeToInstant(input.localDate, input.endMinute, input.timezone);
  // `for update of a` bloquea las allocations afectadas: la revalidación de
  // conflictos se hace SIEMPRE dentro de la transacción autoritativa.
  const rows = await tx`
    select a.id "allocationId", a.staff_member_id "staffMemberId", a.local_date::text "localDate",
           a.visible_start_at "visibleStartAt", a.visible_end_at "visibleEndAt",
           a.source_type::text "sourceType", a.source_id "sourceId",
           r.id "reservationId", r.status::text "reservationStatus", r.revision::int "reservationRevision",
           r.contact_snapshot->>'name' "customerName",
           r.starts_at "startsAt", r.ends_at "endsAt"
      from availability.resource_allocations a
      left join booking.reservations r
             on r.business_id = a.business_id and r.id = a.source_id and a.source_type = 'RESERVATION'
     where a.business_id = ${input.businessId}
       and a.staff_member_id = ${input.staffMemberId}
       and a.local_date = ${input.localDate}
       and a.status = 'ACTIVE'
       and a.occupied_range && tstzrange(${rangeStart.toISOString()}::timestamptz, ${rangeEnd.toISOString()}::timestamptz, '[)')
     order by a.visible_start_at
     for update of a`;
  return rows as unknown as Array<{
    allocationId: string; staffMemberId: string; localDate: string;
    visibleStartAt: Date; visibleEndAt: Date; sourceType: string; sourceId: string;
    reservationId: string | null; reservationStatus: string | null; reservationRevision: number | null;
    customerName: string | null; startsAt: Date | null; endsAt: Date | null;
  }>;
}

/** Registra (o refresca) los conflictos `OPEN` de una ausencia. */
async function upsertAbsenceConflicts(tx: Tx, input: {
  businessId: string;
  sourceOperationId: string;
  allocationIds: string[];
}): Promise<void> {
  for (const allocationId of input.allocationIds) {
    await tx`
      insert into availability.commitment_conflicts(business_id,allocation_id,reason_code,source_operation_id,status)
      values (${input.businessId},${allocationId},${ABSENCE_CONFLICT_REASON},${input.sourceOperationId},'OPEN')
      on conflict (business_id,allocation_id,reason_code,source_operation_id)
      do update set status='OPEN', detected_at=now(), resolved_at=null, resolution_reference=null`;
  }
}

/**
 * Persiste los conflictos `OPEN` detectados por un intento de aplicación.
 *
 * Se ejecuta en una TRANSACCIÓN PROPIA porque el intento de aplicación falla
 * (409) y su savepoint se deshace: si la detección viviera dentro de esa
 * transacción, el artefacto de conflicto no sobreviviría y el operador no
 * podría ver ni resolver los compromisos incompatibles.
 *
 * La autoridad NO cambia: esta función sólo REGISTRA. La comprobación que
 * bloquea la aplicación sigue siendo la revalidación transaccional del
 * comando `applyAbsence`.
 */
async function recordAbsenceConflicts(input: { businessId: string; absenceId: string; actor: Actor }): Promise<void> {
  await database.client.begin(async (tx) => {
    await lockAvailabilityGuard(tx as unknown as Tx, input.businessId);
    const [absence] = await tx`
      select id, staff_member_id "staffMemberId", local_date::text "localDate",
             start_minute "startMinute", end_minute "endMinute",
             created_operation_id "createdOperationId", status::text status, revision::int revision
        from absence.absence_requests
       where business_id = ${input.businessId} and id = ${input.absenceId}`;
    if (!absence) return;
    const timezone = await businessTimezone(tx as unknown as Tx, input.businessId);
    const affected = await detectAffectedCommitments(tx as unknown as Tx, {
      businessId: input.businessId, staffMemberId: absence.staffMemberId, localDate: absence.localDate,
      startMinute: absence.startMinute, endMinute: absence.endMinute, timezone
    });
    const blocking = affected.filter((item) => item.sourceType === "RESERVATION" && item.reservationStatus === "CONFIRMED");
    if (!blocking.length) return;
    await upsertAbsenceConflicts(tx as unknown as Tx, {
      businessId: input.businessId,
      sourceOperationId: absence.createdOperationId,
      allocationIds: blocking.map((item) => item.allocationId)
    });
    await appendAbsenceEvent(tx as unknown as Tx, {
      businessId: input.businessId,
      absenceRequestId: absence.id as string,
      eventType: "ABSENCE_CONFLICT_DETECTED",
      operationId: absence.createdOperationId as string,
      actor: input.actor,
      beforeRevision: Number(absence.revision),
      afterRevision: Number(absence.revision),
      changes: { conflictingReservations: blocking.map((item) => item.reservationId) },
      staffMemberId: absence.staffMemberId as string
    });
  });
}

/* ─────────────────────────── comandos ─────────────────────────── */

export type RequestAbsenceInput = {
  actor: Actor;
  staffMemberId: string;
  localDate: string;
  startMinute: number;
  endMinute: number;
  reason?: string;
  operationId: string;
};

export type AbsenceResult = {
  absenceId: string;
  status: AbsenceStatus;
  revision: number;
  staffMemberId: string;
  localDate: string;
  startMinute: number;
  endMinute: number;
  replayed: boolean;
};

/**
 * CAP-03-07-R1 · Solicitar ausencia.
 * `PENDING` NO bloquea disponibilidad (INV-ABS-01): no se escribe nada en
 * `team.staff_effective_unavailability`.
 */
export async function requestAbsence(input: RequestAbsenceInput): Promise<AbsenceResult> {
  assertAbsenceInterval(input.startMinute, input.endMinute);
  assertAbsenceScope(input.actor, input.staffMemberId);

  const result = await executePrincipalOperation<Omit<AbsenceResult, "replayed">>({
    operationId: input.operationId,
    command: REQUEST_COMMAND,
    principal: { kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId },
    payload: { staffMemberId: input.staffMemberId, localDate: input.localDate, startMinute: input.startMinute, endMinute: input.endMinute, reason: input.reason ?? null }
  }, async (tx) => {
    const businessId = input.actor.businessId;

    const [staff] = await tx`
      select sm.id, sm.employment_status::text "employmentStatus", sm.access_status::text "accessStatus"
        from team.staff_members sm
       where sm.business_id=${businessId} and sm.id=${input.staffMemberId}`;
    if (!staff) throw new DomainError("NOT_FOUND", "Professional not found", 404);
    if (staff.employmentStatus !== "ACTIVE" || staff.accessStatus !== "ACTIVE") {
      throw new DomainError("PROFESSIONAL_STAFF_NOT_ACTIVE", "Professional is not active in this Business", 409, { staffMemberId: input.staffMemberId });
    }

    // El solicitante debe pertenecer al Business (la cuenta es global).
    const [requester] = await tx`
      select 1 from iam.user_accounts ua
        join team.staff_members sm on sm.person_id = ua.person_id
       where ua.id = ${input.actor.accountId} and sm.business_id = ${businessId}`;
    if (!requester) throw new DomainError("FORBIDDEN", "The actor does not belong to this Business", 403);

    // B01 CAP-03-07-R1: la fecha local está dentro del horizonte del negocio.
    const timezone = await businessTimezone(tx, businessId);
    const today = businessLocalDate(new Date(), timezone);
    const horizon = await bookingHorizon(tx, businessId);
    assertWithinHorizon(input.localDate, today, horizon);

    // No se solapa con una ausencia ya APLICADA (una ausencia aplicada bloquea).
    const applied = await tx`
      select id from absence.absence_requests
       where business_id=${businessId} and staff_member_id=${input.staffMemberId}
         and status='APPLIED' and local_date=${input.localDate}
         and start_minute < ${input.endMinute} and ${input.startMinute} < end_minute`;
    if (applied.length) {
      throw new DomainError("CONFLICT", "An applied absence already covers this interval", 409, { absenceId: applied[0]!.id });
    }

    const [created] = await tx`
      insert into absence.absence_requests(business_id,staff_member_id,requested_by_account_id,created_operation_id,local_date,start_minute,end_minute,reason,status,revision)
      values (${businessId},${input.staffMemberId},${input.actor.accountId},${input.operationId},${input.localDate},${input.startMinute},${input.endMinute},${input.reason ?? null},'PENDING',1)
      returning id, status::text status, revision::int revision`;

    await appendAbsenceEvent(tx, {
      businessId,
      absenceRequestId: created!.id,
      eventType: "ABSENCE_REQUESTED",
      operationId: input.operationId,
      actor: input.actor,
      beforeRevision: null,
      afterRevision: 1,
      changes: { staffMemberId: input.staffMemberId, localDate: input.localDate, startMinute: input.startMinute, endMinute: input.endMinute, status: { before: null, after: "PENDING" } },
      reasonCode: input.reason ?? null,
      staffMemberId: input.staffMemberId
    });

    await tx`
      insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${businessId},${input.actor.accountId},${input.operationId},'absence.requested','absence.request',${JSON.stringify({ type: "BUSINESS", businessId })}::jsonb,'ABSENCE_REQUEST',${created!.id},'SUCCEEDED',${JSON.stringify({ staffMemberId: input.staffMemberId, localDate: input.localDate, startMinute: input.startMinute, endMinute: input.endMinute })}::jsonb)`;

    return {
      absenceId: created!.id as string,
      status: "PENDING" as AbsenceStatus,
      revision: Number(created!.revision),
      staffMemberId: input.staffMemberId,
      localDate: input.localDate,
      startMinute: input.startMinute,
      endMinute: input.endMinute
    };
  });

  return { ...result.data, replayed: result.replayed };
}

/** CAP-03-07-R3 · Aprobar (`PENDING → APPROVED`). No cancela reservas (INV-ABS-02). */
export async function approveAbsence(input: { actor: Actor; absenceId: string; expectedRevision: number; operationId: string }): Promise<AbsenceResult> {
  const result = await executePrincipalOperation<Omit<AbsenceResult, "replayed">>({
    operationId: input.operationId,
    command: APPROVE_COMMAND,
    principal: { kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId },
    payload: { absenceId: input.absenceId, expectedRevision: input.expectedRevision }
  }, async (tx) => {
    const businessId = input.actor.businessId;
    const absence = await loadAbsence(tx, businessId, input.absenceId);
    assertAbsenceScope(input.actor, absence.staffMemberId);
    assertAbsenceTransition(absence.status, "APPROVED");
    assertRevision(absence.revision, input.expectedRevision);

    const [updated] = await tx`
      update absence.absence_requests
         set status='APPROVED', approved_by_account_id=${input.actor.accountId}, approved_at=now(),
             revision=revision+1, updated_at=now()
       where business_id=${businessId} and id=${input.absenceId} and revision=${input.expectedRevision}
       returning revision::int revision`;
    if (!updated) throw new DomainError("STALE_REVISION", "The absence was modified concurrently", 409);

    await appendAbsenceEvent(tx, {
      businessId, absenceRequestId: absence.id, eventType: "ABSENCE_APPROVED", operationId: input.operationId,
      actor: input.actor, beforeRevision: absence.revision, afterRevision: absence.revision + 1,
      changes: { status: { before: absence.status, after: "APPROVED" } }, staffMemberId: absence.staffMemberId
    });

    await tx`
      insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${businessId},${input.actor.accountId},${input.operationId},'absence.approved','absence.approve',${JSON.stringify({ type: "BUSINESS", businessId })}::jsonb,'ABSENCE_REQUEST',${absence.id},'SUCCEEDED',${JSON.stringify({ status: "APPROVED" })}::jsonb)`;

    return {
      absenceId: absence.id, status: "APPROVED" as AbsenceStatus, revision: Number(updated.revision),
      staffMemberId: absence.staffMemberId, localDate: absence.localDate, startMinute: absence.startMinute, endMinute: absence.endMinute
    };
  });

  return { ...result.data, replayed: result.replayed };
}

/** CAP-03-07-R4 · Rechazar (`PENDING|APPROVED → REJECTED`, terminal). */
export async function rejectAbsence(input: { actor: Actor; absenceId: string; expectedRevision: number; reason: string; operationId: string }): Promise<AbsenceResult> {
  if (typeof input.reason !== "string" || input.reason.trim().length < 3) {
    throw new DomainError("VALIDATION_ERROR", "A rejection requires a reason", 400);
  }
  const result = await executePrincipalOperation<Omit<AbsenceResult, "replayed">>({
    operationId: input.operationId,
    command: REJECT_COMMAND,
    principal: { kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId },
    payload: { absenceId: input.absenceId, expectedRevision: input.expectedRevision, reason: input.reason }
  }, async (tx) => {
    const businessId = input.actor.businessId;
    const absence = await loadAbsence(tx, businessId, input.absenceId);
    assertAbsenceScope(input.actor, absence.staffMemberId);
    assertAbsenceTransition(absence.status, "REJECTED");
    assertRevision(absence.revision, input.expectedRevision);

    const [updated] = await tx`
      update absence.absence_requests
         set status='REJECTED', reject_reason=${input.reason}, revision=revision+1, updated_at=now()
       where business_id=${businessId} and id=${input.absenceId} and revision=${input.expectedRevision}
       returning revision::int revision`;
    if (!updated) throw new DomainError("STALE_REVISION", "The absence was modified concurrently", 409);

    await appendAbsenceEvent(tx, {
      businessId, absenceRequestId: absence.id, eventType: "ABSENCE_REJECTED", operationId: input.operationId,
      actor: input.actor, beforeRevision: absence.revision, afterRevision: absence.revision + 1,
      changes: { status: { before: absence.status, after: "REJECTED" }, reason: input.reason }, reasonCode: input.reason,
      staffMemberId: absence.staffMemberId
    });

    await tx`
      insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${businessId},${input.actor.accountId},${input.operationId},'absence.rejected','absence.reject',${JSON.stringify({ type: "BUSINESS", businessId })}::jsonb,'ABSENCE_REQUEST',${absence.id},'SUCCEEDED',${JSON.stringify({ reason: input.reason })}::jsonb)`;

    return {
      absenceId: absence.id, status: "REJECTED" as AbsenceStatus, revision: Number(updated.revision),
      staffMemberId: absence.staffMemberId, localDate: absence.localDate, startMinute: absence.startMinute, endMinute: absence.endMinute
    };
  });

  return { ...result.data, replayed: result.replayed };
}

/** CAP-03-07-R5 · Retirar (`PENDING|APPROVED → WITHDRAWN`, terminal). */
export async function withdrawAbsence(input: { actor: Actor; absenceId: string; expectedRevision: number; reason?: string; operationId: string }): Promise<AbsenceResult> {
  const result = await executePrincipalOperation<Omit<AbsenceResult, "replayed">>({
    operationId: input.operationId,
    command: WITHDRAW_COMMAND,
    principal: { kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId },
    payload: { absenceId: input.absenceId, expectedRevision: input.expectedRevision, reason: input.reason ?? null }
  }, async (tx) => {
    const businessId = input.actor.businessId;
    const absence = await loadAbsence(tx, businessId, input.absenceId);
    assertAbsenceScope(input.actor, absence.staffMemberId);
    assertAbsenceTransition(absence.status, "WITHDRAWN");
    assertRevision(absence.revision, input.expectedRevision);

    const [updated] = await tx`
      update absence.absence_requests
         set status='WITHDRAWN', revision=revision+1, updated_at=now()
       where business_id=${businessId} and id=${input.absenceId} and revision=${input.expectedRevision}
       returning revision::int revision`;
    if (!updated) throw new DomainError("STALE_REVISION", "The absence was modified concurrently", 409);

    await appendAbsenceEvent(tx, {
      businessId, absenceRequestId: absence.id, eventType: "ABSENCE_WITHDRAWN", operationId: input.operationId,
      actor: input.actor, beforeRevision: absence.revision, afterRevision: absence.revision + 1,
      changes: { status: { before: absence.status, after: "WITHDRAWN" } }, reasonCode: input.reason ?? null,
      staffMemberId: absence.staffMemberId
    });

    await tx`
      insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${businessId},${input.actor.accountId},${input.operationId},'absence.withdrawn','absence.withdraw',${JSON.stringify({ type: "BUSINESS", businessId })}::jsonb,'ABSENCE_REQUEST',${absence.id},'SUCCEEDED',${JSON.stringify({ reason: input.reason ?? null })}::jsonb)`;

    return {
      absenceId: absence.id, status: "WITHDRAWN" as AbsenceStatus, revision: Number(updated.revision),
      staffMemberId: absence.staffMemberId, localDate: absence.localDate, startMinute: absence.startMinute, endMinute: absence.endMinute
    };
  });

  return { ...result.data, replayed: result.replayed };
}

/**
 * CAP-03-07-R8 · Aplicar la ausencia (`APPROVED → APPLIED`).
 *
 * Antes de aplicar se REVALIDA el estado real del calendario dentro de la
 * misma transacción (allocations `FOR UPDATE`). Si queda algún compromiso
 * `CONFIRMED` incompatible, la operación falla con 409
 * `AVAILABILITY_IMPACT_CONFLICT`: una ausencia nunca deja compromisos
 * imposibles ni reservas huérfanas.
 */
export async function applyAbsence(input: { actor: Actor; absenceId: string; expectedRevision: number; resolutionReferences?: string[]; operationId: string }): Promise<AbsenceResult> {
  let result: { data: Omit<AbsenceResult, "replayed">; replayed: boolean };
  try {
    result = await executePrincipalOperation<Omit<AbsenceResult, "replayed">>({
      operationId: input.operationId,
      command: APPLY_COMMAND,
      principal: { kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId },
      payload: { absenceId: input.absenceId, expectedRevision: input.expectedRevision, resolutionReferences: input.resolutionReferences ?? [] }
    }, async (tx) => {
      const businessId = input.actor.businessId;
      // Orden de locks unificado: el guard de Availability va PRIMERO.
      await lockAvailabilityGuard(tx, businessId);

      const absence = await loadAbsence(tx, businessId, input.absenceId);
      assertAbsenceScope(input.actor, absence.staffMemberId);
      assertAbsenceTransition(absence.status, "APPLIED");
      assertRevision(absence.revision, input.expectedRevision);

      const timezone = await businessTimezone(tx, businessId);
      const affected = await detectAffectedCommitments(tx, {
        businessId, staffMemberId: absence.staffMemberId, localDate: absence.localDate,
        startMinute: absence.startMinute, endMinute: absence.endMinute, timezone
      });
      const blocking = affected.filter((item) => item.sourceType === "RESERVATION" && item.reservationStatus === "CONFIRMED");

      if (blocking.length) {
        // El artefacto de conflicto se persiste FUERA de esta transacción
        // (ver `recordAbsenceConflicts`): aquí la transacción falla y se deshace.
        throw new DomainError("AVAILABILITY_IMPACT_CONFLICT", "The absence still affects confirmed commitments", 409, {
          conflictingReservations: blocking.map((item) => item.reservationId)
        });
      }

      // Materializa la indisponibilidad efectiva (groundwork de Availability).
      await tx`
        insert into team.staff_effective_unavailability(business_id,staff_member_id,source_type,source_id,local_date,start_minute,end_minute)
        values (${businessId},${absence.staffMemberId},'APPLIED_ABSENCE',${absence.id},${absence.localDate},${absence.startMinute},${absence.endMinute})
        on conflict (business_id,source_type,source_id,local_date,start_minute,end_minute)
        do update set released_at=null, applied_at=now()`;

      // Los conflictos que ya no bloquean quedan resueltos por la aplicación.
      await tx`
        update availability.commitment_conflicts c
           set status='RESOLVED', resolved_at=now(), resolution_reference='ABSENCE_APPLIED'
         where c.business_id=${businessId} and c.reason_code=${ABSENCE_CONFLICT_REASON}
           and c.source_operation_id=${absence.createdOperationId}
           and c.status='OPEN'
           and c.allocation_id in (select id from availability.resource_allocations where business_id=${businessId} and staff_member_id=${absence.staffMemberId} and local_date=${absence.localDate})`;

      const [updated] = await tx`
        update absence.absence_requests
           set status='APPLIED', applied_at=now(), revision=revision+1, updated_at=now()
         where business_id=${businessId} and id=${input.absenceId} and revision=${input.expectedRevision}
         returning revision::int revision`;
      if (!updated) throw new DomainError("STALE_REVISION", "The absence was modified concurrently", 409);

      await appendAbsenceEvent(tx, {
        businessId, absenceRequestId: absence.id, eventType: "ABSENCE_APPLIED", operationId: input.operationId,
        actor: input.actor, beforeRevision: absence.revision, afterRevision: absence.revision + 1,
        changes: { status: { before: absence.status, after: "APPLIED" }, resolutionReferences: input.resolutionReferences ?? [] },
        staffMemberId: absence.staffMemberId
      });

      await tx`
        insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
        values (${businessId},${input.actor.accountId},${input.operationId},'absence.applied','absence.apply',${JSON.stringify({ type: "BUSINESS", businessId })}::jsonb,'ABSENCE_REQUEST',${absence.id},'SUCCEEDED',${JSON.stringify({ localDate: absence.localDate, startMinute: absence.startMinute, endMinute: absence.endMinute })}::jsonb)`;

      return {
        absenceId: absence.id, status: "APPLIED" as AbsenceStatus, revision: Number(updated.revision),
        staffMemberId: absence.staffMemberId, localDate: absence.localDate, startMinute: absence.startMinute, endMinute: absence.endMinute
      };
    });
  } catch (error) {
    // El intento falló por conflicto: se registra el compromiso afectado en una
    // transacción propia para que el operador pueda verlo y resolverlo.
    if (error instanceof DomainError && error.code === "AVAILABILITY_IMPACT_CONFLICT") {
      await recordAbsenceConflicts({ businessId: input.actor.businessId, absenceId: input.absenceId, actor: input.actor });
    }
    throw error;
  }

  return { ...result.data, replayed: result.replayed };
}

/**
 * Re-sincroniza los conflictos de una ausencia tras resolver compromisos con
 * las operaciones autorizadas de Booking (reasignar / cancelar).
 *
 * No resuelve nada por sí misma: sólo REFLEJA el estado real del calendario.
 * Los conflictos quedan `RESOLVED` cuando la allocation dejó de estar `ACTIVE`
 * o la reserva dejó de estar `CONFIRMED`, con la referencia del evento de
 * Booking que produjo la resolución.
 */
export async function syncAbsenceConflicts(input: { actor: Actor; absenceId: string; operationId: string }): Promise<{ absenceId: string; conflicts: Array<{ allocationId: string; reservationId: string | null; status: string; resolutionReference: string | null }> }> {
  const result = await executePrincipalOperation<{ absenceId: string; conflicts: Array<{ allocationId: string; reservationId: string | null; status: string; resolutionReference: string | null }> }>({
    operationId: input.operationId,
    command: CONFLICT_SYNC_COMMAND,
    principal: { kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId },
    payload: { absenceId: input.absenceId }
  }, async (tx) => {
    const businessId = input.actor.businessId;
    await lockAvailabilityGuard(tx, businessId);

    const absence = await loadAbsence(tx, businessId, input.absenceId);
    assertAbsenceScope(input.actor, absence.staffMemberId);
    if (absence.status === "PENDING") {
      throw new DomainError("CONFLICT", "Conflicts can only be synchronized for an approved absence", 409, { status: absence.status });
    }

    const timezone = await businessTimezone(tx, businessId);
    const affected = await detectAffectedCommitments(tx, {
      businessId, staffMemberId: absence.staffMemberId, localDate: absence.localDate,
      startMinute: absence.startMinute, endMinute: absence.endMinute, timezone
    });
    const blocking = affected.filter((item) => item.sourceType === "RESERVATION" && item.reservationStatus === "CONFIRMED");

    await upsertAbsenceConflicts(tx, { businessId, sourceOperationId: absence.createdOperationId, allocationIds: blocking.map((item) => item.allocationId) });

    // Los conflictos cuyo commitment ya no está activo se resuelven referencing
    // el último evento de Booking que produjo la resolución.
    const open = await tx`
      select c.id, c.allocation_id "allocationId", a.status::text "allocationStatus",
             r.id "reservationId", r.status::text "reservationStatus"
        from availability.commitment_conflicts c
        join availability.resource_allocations a on a.business_id=c.business_id and a.id=c.allocation_id
        left join booking.reservations r on r.business_id=a.business_id and r.id=a.source_id and a.source_type='RESERVATION'
       where c.business_id=${businessId} and c.reason_code=${ABSENCE_CONFLICT_REASON}
         and c.source_operation_id=${absence.createdOperationId}
       for update of c`;

    for (const conflict of open) {
      const stillBlocking = conflict.allocationStatus === "ACTIVE" && conflict.reservationStatus === "CONFIRMED";
      if (stillBlocking) continue;
      const [event] = await tx`
        select id, event_type::text "eventType" from booking.reservation_events
         where business_id=${businessId} and reservation_id=${conflict.reservationId}
         order by sequence desc limit 1`;
      const reference = event ? `${event.eventType}:${event.id}` : "COMMITMENT_RELEASED";
      await tx`
        update availability.commitment_conflicts
           set status='RESOLVED', resolved_at=now(), resolution_reference=${reference}
         where business_id=${businessId} and id=${conflict.id}`;
      await appendAbsenceEvent(tx, {
        businessId, absenceRequestId: absence.id, eventType: "ABSENCE_COMMITMENT_RESOLVED", operationId: input.operationId,
        actor: input.actor, beforeRevision: absence.revision, afterRevision: absence.revision,
        changes: { allocationId: conflict.allocationId, reservationId: conflict.reservationId, resolutionReference: reference },
        staffMemberId: absence.staffMemberId
      });
    }

    const current = await tx`
      select c.allocation_id "allocationId", a.source_id "reservationId", c.status::text status, c.resolution_reference "resolutionReference"
        from availability.commitment_conflicts c
        join availability.resource_allocations a on a.business_id=c.business_id and a.id=c.allocation_id
       where c.business_id=${businessId} and c.reason_code=${ABSENCE_CONFLICT_REASON}
         and c.source_operation_id=${absence.createdOperationId}
         and a.staff_member_id=${absence.staffMemberId} and a.local_date=${absence.localDate}
       order by a.visible_start_at`;

    return { absenceId: absence.id, conflicts: current as never };
  });

  return result.data;
}

/** Revisión monótona: una operación con revisión obsoleta se rechaza. */
function assertRevision(current: number, expected: number): void {
  if (current !== expected) {
    throw new DomainError("STALE_REVISION", "The absence was modified concurrently", 409, { currentRevision: current });
  }
}

export { intervalsOverlap };
