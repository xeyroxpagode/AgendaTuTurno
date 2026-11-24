/**
 * H03.U06 · CAP-03-08 · Prestación real (Attendance) — comandos.
 *
 * Autoridad del módulo:
 *  · `attendance.attendances` es la ÚNICA fuente de verdad de lo que se
 *   Prestó. No modifica el estado de la reserva: Attendance ≠ Reservation.
 *  · Un walk-in legítimo se representa con `reservation_id = NULL` y
 *    `walk_in = true`. NO se crea ninguna Reservation ficticia, NO se crea ni
 *    vincula una cuenta CLIENT, NO se generan ventas, pagos ni movimientos de
 *    stock (el módulo sólo escribe en el esquema `attendance` y en
 *    `system.audit_events`).
 *  · Toda mutación es idempotente por `operation_id`
 *    (`executePrincipalOperation`) y serializada por `lockAvailabilityGuard`.
 *  · Las correcciones nunca borran: escriben en
 *    `attendance.attendance_corrections` con el estado anterior, el posterior,
 *    el autor, el momento y el motivo.
 */
import { DomainError } from "@youngkingz/contracts";
import type { AttendanceStatus, PerformedService, TerminalAttendanceStatus } from "@youngkingz/contracts";
import { executePrincipalOperation, type Tx } from "../system/operations.js";
import { lockAvailabilityGuard } from "../availability/guard.js";
import type { Actor } from "../iam/authorization.js";
import { assertAttendanceShape, assertAttendanceTransition } from "./domain.js";

const REGISTER_COMMAND = "attendance.register";
const STATE_COMMAND = "attendance.state";
const CORRECT_COMMAND = "attendance.correct";

export type AttendanceResult = {
  attendanceId: string;
  status: AttendanceStatus;
  revision: number;
  reservationId: string | null;
  attendedByStaffMemberId: string;
  walkIn: boolean;
  startedAt: string;
  finishedAt: string | null;
  replayed: boolean;
};

/* ─────────────────────────── alcance ─────────────────────────── */

/**
 * Alcance de lectura de atenciones (B01 §5).
 * · `attendance.read.all` → historial completo del Business (OWNER, RECEPTIONIST).
 * · `attendance.read`      → únicamente las atenciones del propio profesional.
 */
export function resolveAttendanceScope(actor: Actor): { staffMemberId?: string } {
  if (actor.capabilities.has("attendance.read.all")) return {};
  if (actor.capabilities.has("attendance.read")) return { staffMemberId: actor.staffMemberId };
  throw new DomainError("FORBIDDEN", "Missing capability: attendance.read", 403);
}

/**
 * Alcance de escritura: el BARBER sólo registra atenciones de las que es
 * responsable. OWNER y RECEPTIONIST pueden registrar para cualquier
 * profesional del Business.
 */
export function assertAttendanceWriteScope(actor: Actor, staffMemberId: string, attendedByStaffMemberId: string): void {
  if (actor.role === "BARBER") {
    if (staffMemberId !== actor.staffMemberId || attendedByStaffMemberId !== actor.staffMemberId) {
      throw new DomainError("FORBIDDEN", "Attendance is not within the actor's professional scope", 403);
    }
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

async function loadAttendance(tx: Tx, businessId: string, attendanceId: string) {
  const [row] = await tx`
    select id, business_id "businessId", reservation_id "reservationId",
           staff_member_id "staffMemberId", attended_by_staff_member_id "attendedByStaffMemberId",
           client_profile_id "clientProfileId", walk_in "walkIn", status::text status,
           started_at "startedAt", finished_at "finishedAt",
           services_performed_snapshot "servicesPerformedSnapshot",
           contact_snapshot "contactSnapshot", notes, revision::int revision
      from attendance.attendances
     where business_id = ${businessId} and id = ${attendanceId}
     for update`;
  if (!row) throw new DomainError("NOT_FOUND", "Attendance not found", 404);
  return row as {
    id: string; businessId: string; reservationId: string | null;
    staffMemberId: string; attendedByStaffMemberId: string; clientProfileId: string | null;
    walkIn: boolean; status: AttendanceStatus; startedAt: Date; finishedAt: Date | null;
    servicesPerformedSnapshot: unknown; contactSnapshot: unknown; notes: string | null; revision: number;
  };
}

async function nextAttendanceSequence(tx: Tx, businessId: string, attendanceId: string): Promise<number> {
  const [row] = await tx`select coalesce(max(sequence),0)+1 "next" from attendance.attendance_events where business_id=${businessId} and attendance_id=${attendanceId}`;
  return Number(row!.next);
}

async function appendAttendanceEvent(tx: Tx, input: {
  businessId: string;
  attendanceId: string;
  eventType: string;
  operationId: string;
  actor: Actor;
  beforeRevision: number | null;
  afterRevision: number | null;
  changes: Record<string, unknown>;
  reasonCode?: string | null;
}) {
  const sequence = await nextAttendanceSequence(tx, input.businessId, input.attendanceId);
  await tx`
    insert into attendance.attendance_events(business_id,attendance_id,sequence,event_type,operation_id,principal_type,actor_account_id,staff_member_id,before_revision,after_revision,changes,reason_code)
    values (${input.businessId},${input.attendanceId},${sequence},${input.eventType},${input.operationId},'STAFF',${input.actor.accountId},${input.actor.staffMemberId},${input.beforeRevision},${input.afterRevision},${JSON.stringify(input.changes)}::jsonb,${input.reasonCode ?? null})`;
}

function snapshotOf(attendance: Awaited<ReturnType<typeof loadAttendance>>): Record<string, unknown> {
  return {
    status: attendance.status,
    attendedByStaffMemberId: attendance.attendedByStaffMemberId,
    clientProfileId: attendance.clientProfileId,
    walkIn: attendance.walkIn,
    reservationId: attendance.reservationId,
    startedAt: attendance.startedAt,
    finishedAt: attendance.finishedAt,
    servicesPerformedSnapshot: attendance.servicesPerformedSnapshot,
    contactSnapshot: attendance.contactSnapshot,
    notes: attendance.notes,
    revision: attendance.revision
  };
}

/* ─────────────────────────── comandos ─────────────────────────── */

export type RegisterAttendanceInput = {
  actor: Actor;
  reservationId?: string | null;
  staffMemberId?: string | null;
  attendedByStaffMemberId?: string | null;
  clientProfileId?: string | null;
  walkIn?: boolean;
  contactSnapshot?: { name: string; phone: string; email?: string } | null;
  servicesPerformedSnapshot?: PerformedService[] | null;
  startedAt?: string | null;
  status?: TerminalAttendanceStatus | null;
  notes?: string | null;
  operationId: string;
};

/**
 * CAP-03-08-R1 / R2 · Registrar la atención (desde reserva o walk-in).
 */
export async function registerAttendance(input: RegisterAttendanceInput): Promise<AttendanceResult> {
  const walkIn = input.walkIn === true;
  const staffMemberId = input.staffMemberId ?? input.actor.staffMemberId;
  const attendedByStaffMemberId = input.attendedByStaffMemberId ?? staffMemberId;

  assertAttendanceShape({
    reservationId: input.reservationId ?? null,
    walkIn,
    hasContact: Boolean(input.contactSnapshot?.name && input.contactSnapshot?.phone),
    hasClientProfile: Boolean(input.clientProfileId)
  });
  assertAttendanceWriteScope(input.actor, staffMemberId, attendedByStaffMemberId);

  const payload = {
    reservationId: input.reservationId ?? null,
    staffMemberId,
    attendedByStaffMemberId,
    clientProfileId: input.clientProfileId ?? null,
    walkIn,
    contactSnapshot: input.contactSnapshot ?? null,
    servicesPerformedSnapshot: input.servicesPerformedSnapshot ?? null,
    startedAt: input.startedAt ?? null,
    status: input.status ?? null,
    notes: input.notes ?? null
  };

  const result = await executePrincipalOperation<Omit<AttendanceResult, "replayed">>({
    operationId: input.operationId,
    command: REGISTER_COMMAND,
    principal: { kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId },
    payload
  }, async (tx) => {
    const businessId = input.actor.businessId;
    await lockAvailabilityGuard(tx, businessId);

    // Los profesionales deben pertenecer al Business.
    const staff = await tx`
      select id from team.staff_members
       where business_id=${businessId} and id = any(${[staffMemberId, attendedByStaffMemberId]}::uuid[])
         and employment_status='ACTIVE' and access_status='ACTIVE'`;
    if (staff.length !== new Set([staffMemberId, attendedByStaffMemberId]).size) {
      throw new DomainError("NOT_FOUND", "Professional not found in this Business", 404);
    }

    let clientProfileId: string | null = null;
    let contactSnapshot: unknown = null;
    let startedAt = new Date();
    let services = input.servicesPerformedSnapshot ?? null;

    if (!walkIn) {
      const reservationId = input.reservationId!;
      const [reservation] = await tx`
        select id, status::text status, client_profile_id "clientProfileId",
               contact_snapshot "contactSnapshot", starts_at "startsAt"
          from booking.reservations
         where business_id=${businessId} and id=${reservationId}
         for update`;
      if (!reservation) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);
      if (reservation.status !== "CONFIRMED") {
        // CN-10: una reserva cancelada o con no-show NO admite atención.
        throw new DomainError("CONFLICT", `Attendance requires a CONFIRMED reservation (current: ${reservation.status})`, 409, { status: reservation.status });
      }
      const [existing] = await tx`
        select id from attendance.attendances
         where business_id=${businessId} and reservation_id=${reservationId}
           and status in ('COMPLETED','PARTIAL','INTERRUPTED')`;
      if (existing) {
        // CN-11: una reserva admite como mucho una atención terminal.
        throw new DomainError("CONFLICT", "The reservation already has a terminal attendance", 409, { attendanceId: existing.id });
      }
      clientProfileId = (reservation.clientProfileId as string | null) ?? null;
      contactSnapshot = reservation.contactSnapshot;
      if (input.startedAt) startedAt = new Date(input.startedAt);
      if (services?.some((service) => service.serviceId)) {
        const booked = await tx`select service_id "serviceId", service_name_snapshot name, price_minor::int "priceMinor"
          from booking.reservation_items where business_id=${businessId} and reservation_id=${reservationId}`;
        services = services.map((service) => {
          const original = booked.find((item) => item.serviceId === service.serviceId);
          return original ? { ...service, name: String(original.name), priceMinor: Number(original.priceMinor), currency: "ARS" } : service;
        });
      }
    } else {
      // Walk-in: contacto mínimo obligatorio. No se crea ni se vincula ficha CRM.
      contactSnapshot = { name: input.contactSnapshot!.name, phone: input.contactSnapshot!.phone, email: input.contactSnapshot!.email ?? null };
      if (input.startedAt) startedAt = new Date(input.startedAt);

      // Un walk-in duplicado (mismo profesional, mismo día, mismo teléfono) se rechaza.
      const [duplicate] = await tx`
        select id from attendance.attendances
         where business_id=${businessId} and walk_in = true
           and attended_by_staff_member_id=${attendedByStaffMemberId}
           and (started_at at time zone (select timezone from business.businesses where id=${businessId}))::date = (${startedAt.toISOString()}::timestamptz at time zone (select timezone from business.businesses where id=${businessId}))::date
           and contact_snapshot->>'phone' = ${input.contactSnapshot!.phone}
         limit 1`;
      if (duplicate) {
        throw new DomainError("CONFLICT", "A walk-in with the same contact already exists for this professional", 409, { attendanceId: duplicate.id });
      }
    }

    const terminal = input.status ?? null;
    if (terminal && !services) {
      throw new DomainError("VALIDATION_ERROR", "A terminal attendance requires the performed services", 400);
    }
    const finishedAt = terminal ? startedAt : null;

    const [created] = await tx`
      insert into attendance.attendances(business_id,reservation_id,staff_member_id,attended_by_staff_member_id,client_profile_id,walk_in,status,started_at,finished_at,services_performed_snapshot,contact_snapshot,notes,revision)
      values (${businessId},${input.reservationId ?? null},${staffMemberId},${attendedByStaffMemberId},${clientProfileId},${walkIn},${terminal ?? 'IN_PROGRESS'},${startedAt.toISOString()},${finishedAt ? finishedAt.toISOString() : null},${services ? JSON.stringify(services) : null},${contactSnapshot ? JSON.stringify(contactSnapshot) : null},${input.notes ?? null},1)
      returning id, status::text status, revision::int revision, started_at "startedAt", finished_at "finishedAt"`;

    const eventType = walkIn ? "ATTENDANCE_WALKIN_REGISTERED" : "ATTENDANCE_REGISTERED";
    await appendAttendanceEvent(tx, {
      businessId, attendanceId: created!.id, eventType, operationId: input.operationId, actor: input.actor,
      beforeRevision: null, afterRevision: 1,
      changes: {
        reservationId: input.reservationId ?? null,
        attendedByStaffMemberId,
        walkIn,
        status: { before: null, after: created!.status },
        servicesPerformedSnapshot: services
      }
    });

    await tx`
      insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${businessId},${input.actor.accountId},${input.operationId},${walkIn ? 'attendance.walkin_registered' : 'attendance.registered'},'attendance.register',${JSON.stringify({ type: "BUSINESS", businessId })}::jsonb,'ATTENDANCE',${created!.id},'SUCCEEDED',${JSON.stringify({ reservationId: input.reservationId ?? null, attendedByStaffMemberId, walkIn })}::jsonb)`;

    return {
      attendanceId: created!.id as string,
      status: created!.status as AttendanceStatus,
      revision: Number(created!.revision),
      reservationId: input.reservationId ?? null,
      attendedByStaffMemberId,
      walkIn,
      startedAt: new Date(created!.startedAt as Date).toISOString(),
      finishedAt: created!.finishedAt ? new Date(created!.finishedAt as Date).toISOString() : null
    };
  });

  return { ...result.data, replayed: result.replayed };
}

/**
 * CAP-03-08-R3 · Establecer el estado terminal de la atención.
 * `IN_PROGRESS → COMPLETED | PARTIAL | INTERRUPTED`.
 */
export async function setAttendanceState(input: {
  actor: Actor;
  attendanceId: string;
  status: TerminalAttendanceStatus;
  servicesPerformedSnapshot: PerformedService[];
  finishedAt?: string | null;
  notes?: string | null;
  expectedRevision: number;
  operationId: string;
}): Promise<AttendanceResult> {
  const result = await executePrincipalOperation<Omit<AttendanceResult, "replayed">>({
    operationId: input.operationId,
    command: STATE_COMMAND,
    principal: { kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId },
    payload: { attendanceId: input.attendanceId, status: input.status, servicesPerformedSnapshot: input.servicesPerformedSnapshot, finishedAt: input.finishedAt ?? null, notes: input.notes ?? null, expectedRevision: input.expectedRevision }
  }, async (tx) => {
    const businessId = input.actor.businessId;
    await lockAvailabilityGuard(tx, businessId);

    const attendance = await loadAttendance(tx, businessId, input.attendanceId);
    assertAttendanceWriteScope(input.actor, attendance.staffMemberId, attendance.attendedByStaffMemberId);
    assertAttendanceTransition(attendance.status, input.status);
    if (attendance.revision !== input.expectedRevision) {
      throw new DomainError("STALE_REVISION", "The attendance was modified concurrently", 409, { currentRevision: attendance.revision });
    }

    const finishedAt = input.finishedAt ? new Date(input.finishedAt) : new Date();
    const [updated] = await tx`
      update attendance.attendances
         set status=${input.status}, finished_at=${finishedAt.toISOString()},
             services_performed_snapshot=${JSON.stringify(input.servicesPerformedSnapshot)}::jsonb,
             notes=coalesce(${input.notes ?? null}, notes),
             revision=revision+1, updated_at=now()
       where business_id=${businessId} and id=${input.attendanceId} and revision=${input.expectedRevision}
       returning revision::int revision, finished_at "finishedAt"`;
    if (!updated) throw new DomainError("STALE_REVISION", "The attendance was modified concurrently", 409);

    const eventType = input.status === "COMPLETED" ? "ATTENDANCE_COMPLETED"
      : input.status === "PARTIAL" ? "ATTENDANCE_PARTIAL" : "ATTENDANCE_INTERRUPTED";
    await appendAttendanceEvent(tx, {
      businessId, attendanceId: attendance.id, eventType, operationId: input.operationId, actor: input.actor,
      beforeRevision: attendance.revision, afterRevision: attendance.revision + 1,
      changes: {
        status: { before: attendance.status, after: input.status },
        servicesPerformedSnapshot: input.servicesPerformedSnapshot
      }
    });

    await tx`
      insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${businessId},${input.actor.accountId},${input.operationId},'attendance.state_changed','attendance.register',${JSON.stringify({ type: "BUSINESS", businessId })}::jsonb,'ATTENDANCE',${attendance.id},'SUCCEEDED',${JSON.stringify({ status: input.status })}::jsonb)`;

    return {
      attendanceId: attendance.id,
      status: input.status,
      revision: Number(updated.revision),
      reservationId: attendance.reservationId,
      attendedByStaffMemberId: attendance.attendedByStaffMemberId,
      walkIn: attendance.walkIn,
      startedAt: new Date(attendance.startedAt).toISOString(),
      finishedAt: new Date(updated.finishedAt as Date).toISOString()
    };
  });

  return { ...result.data, replayed: result.replayed };
}

/**
 * CAP-03-08-R4 · Corrección autorizada de una atención.
 * El motivo es obligatorio (CN-13) y el registro original NO se borra: se
 * conserva el estado anterior, el posterior, el autor y el momento.
 */
export async function correctAttendance(input: {
  actor: Actor;
  attendanceId: string;
  status?: AttendanceStatus | null;
  attendedByStaffMemberId?: string | null;
  contactSnapshot?: { name: string; phone: string; email?: string } | null;
  servicesPerformedSnapshot?: PerformedService[] | null;
  notes?: string | null;
  reason: string;
  expectedRevision: number;
  operationId: string;
}): Promise<AttendanceResult> {
  // CN-13: el motivo es obligatorio. La validación se repite en el comando
  // (y no sólo en el contrato HTTP) para que ninguna ruta de invocación
  // pueda saltarla.
  if (typeof input.reason !== "string" || input.reason.trim().length < 3) {
    throw new DomainError("VALIDATION_ERROR", "A correction requires a reason", 400);
  }
  const result = await executePrincipalOperation<Omit<AttendanceResult, "replayed">>({
    operationId: input.operationId,
    command: CORRECT_COMMAND,
    principal: { kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId },
    payload: {
      attendanceId: input.attendanceId, status: input.status ?? null,
      attendedByStaffMemberId: input.attendedByStaffMemberId ?? null,
      contactSnapshot: input.contactSnapshot ?? null,
      servicesPerformedSnapshot: input.servicesPerformedSnapshot ?? null,
      notes: input.notes ?? null, reason: input.reason, expectedRevision: input.expectedRevision
    }
  }, async (tx) => {
    const businessId = input.actor.businessId;
    await lockAvailabilityGuard(tx, businessId);

    const attendance = await loadAttendance(tx, businessId, input.attendanceId);
    assertAttendanceWriteScope(input.actor, attendance.staffMemberId, attendance.attendedByStaffMemberId);
    if (attendance.revision !== input.expectedRevision) {
      throw new DomainError("STALE_REVISION", "The attendance was modified concurrently", 409, { currentRevision: attendance.revision });
    }

    const nextStatus = input.status ?? attendance.status;
    const nextAttendedBy = input.attendedByStaffMemberId ?? attendance.attendedByStaffMemberId;
    const nextContact = input.contactSnapshot ?? (attendance.contactSnapshot as { name?: string; phone?: string; email?: string | null } | null);
    const nextServices = input.servicesPerformedSnapshot ?? attendance.servicesPerformedSnapshot;
    const nextNotes = input.notes ?? attendance.notes;

    assertAttendanceShape({
      reservationId: attendance.reservationId,
      walkIn: attendance.walkIn,
      hasContact: Boolean(nextContact?.name && nextContact?.phone),
      hasClientProfile: Boolean(attendance.clientProfileId)
    });

    const [target] = await tx`
      select id from team.staff_members
       where business_id=${businessId} and id=${nextAttendedBy}
         and employment_status='ACTIVE' and access_status='ACTIVE'`;
    if (!target) throw new DomainError("NOT_FOUND", "Professional not found in this Business", 404);

    const before = snapshotOf(attendance);
    const after = {
      ...before,
      status: nextStatus,
      attendedByStaffMemberId: nextAttendedBy,
      servicesPerformedSnapshot: nextServices,
      contactSnapshot: nextContact,
      notes: nextNotes,
      revision: attendance.revision + 1
    };

    const [updated] = await tx`
      update attendance.attendances
         set status=${nextStatus},
             attended_by_staff_member_id=${nextAttendedBy},
             contact_snapshot=${nextContact ? JSON.stringify(nextContact) : null}::jsonb,
             services_performed_snapshot=${nextServices ? JSON.stringify(nextServices) : null}::jsonb,
             notes=${nextNotes ?? null},
             finished_at=case when ${nextStatus} = 'IN_PROGRESS' then null else coalesce(finished_at, now()) end,
             revision=revision+1, updated_at=now()
       where business_id=${businessId} and id=${input.attendanceId} and revision=${input.expectedRevision}
       returning revision::int revision, finished_at "finishedAt"`;
    if (!updated) throw new DomainError("STALE_REVISION", "The attendance was modified concurrently", 409);

    await tx`
      insert into attendance.attendance_corrections(business_id,attendance_id,changed_by_account_id,before_snapshot,after_snapshot,reason)
      values (${businessId},${attendance.id},${input.actor.accountId},${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb,${input.reason})`;

    await appendAttendanceEvent(tx, {
      businessId, attendanceId: attendance.id, eventType: "ATTENDANCE_CORRECTED", operationId: input.operationId, actor: input.actor,
      beforeRevision: attendance.revision, afterRevision: attendance.revision + 1,
      changes: { before, after, reason: input.reason }, reasonCode: input.reason
    });

    await tx`
      insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${businessId},${input.actor.accountId},${input.operationId},'attendance.corrected','attendance.correct',${JSON.stringify({ type: "BUSINESS", businessId })}::jsonb,'ATTENDANCE',${attendance.id},'SUCCEEDED',${JSON.stringify({ reason: input.reason })}::jsonb)`;

    return {
      attendanceId: attendance.id,
      status: nextStatus,
      revision: Number(updated.revision),
      reservationId: attendance.reservationId,
      attendedByStaffMemberId: nextAttendedBy,
      walkIn: attendance.walkIn,
      startedAt: new Date(attendance.startedAt).toISOString(),
      finishedAt: updated.finishedAt ? new Date(updated.finishedAt as Date).toISOString() : null
    };
  });

  return { ...result.data, replayed: result.replayed };
}
