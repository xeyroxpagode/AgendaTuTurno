import { z } from "zod";
import { localDateSchema } from "@youngkingz/contracts/availability";

/**
 * H03.U06 · CAP-03-07 · Ausencias y conflictos — contratos compartidos.
 *
 * Estados normativos (B01 §01):
 *   PENDING → APPROVED → APPLIED
 *   PENDING → REJECTED / WITHDRAWN
 *
 * Invariantes que el contrato NO puede imponer y sí impone la persistencia:
 *  · INV-ABS-01 `PENDING` no bloquea disponibilidad.
 *  · INV-ABS-02 `APPROVED` no cancela reservas automáticamente.
 *  · INV-ABS-03 `APPLIED` exige compromisos incompatibles resueltos.
 *  · INV-ABS-04 aprobar y aplicar pueden coincidir si no hay conflictos.
 */

/** Estados de la solicitud de ausencia. `APPLIED`, `REJECTED` y `WITHDRAWN` son terminales. */
export const absenceStatuses = ["PENDING", "APPROVED", "APPLIED", "REJECTED", "WITHDRAWN"] as const;
export type AbsenceStatus = (typeof absenceStatuses)[number];

/** Tipos de evento del ledger append-only de ausencias. */
export const absenceEventTypes = [
  "ABSENCE_REQUESTED",
  "ABSENCE_APPROVED",
  "ABSENCE_REJECTED",
  "ABSENCE_WITHDRAWN",
  "ABSENCE_APPLIED",
  "ABSENCE_CONFLICT_DETECTED",
  "ABSENCE_COMMITMENT_RESOLVED",
] as const;
export type AbsenceEventType = (typeof absenceEventTypes)[number];

const minuteOfDay = z.number().int().min(0).max(1439);
const expectedRevision = z.number().int().positive();

/**
 * Solicitud de ausencia (CAP-03-07-R1).
 * El intervalo es local del Business: `[startMinute, endMinute)` en minutos
 * desde la medianoche, con `startMinute < endMinute` (verificado en dominio).
 */
export const absenceRequestSchema = z.object({
  staffMemberId: z.string().uuid(),
  localDate: localDateSchema,
  startMinute: minuteOfDay,
  endMinute: z.number().int().min(1).max(1440),
  reason: z.string().trim().min(3).max(500).optional(),
}).strict();
export type AbsenceRequestInput = z.infer<typeof absenceRequestSchema>;

/** Aprobar una ausencia `PENDING`. */
export const absenceApproveSchema = z.object({
  expectedRevision,
}).strict();

/** Rechazar una ausencia `PENDING` o `APPROVED`. El motivo es obligatorio. */
export const absenceRejectSchema = z.object({
  expectedRevision,
  reason: z.string().trim().min(3).max(500),
}).strict();

/** Retirar una ausencia propia `PENDING` o `APPROVED`. */
export const absenceWithdrawSchema = z.object({
  expectedRevision,
  reason: z.string().trim().min(3).max(500).optional(),
}).strict();

/**
 * Aplicar una ausencia `APPROVED` (CAP-03-07-R8).
 * `resolutionReferences` documenta las resoluciones de compromiso ya
 * ejecutadas por las operaciones autorizadas de Booking; la revalidación
 * real ocurre dentro de la transacción autoritativa, no contra esta lista.
 */
export const absenceApplySchema = z.object({
  expectedRevision,
  resolutionReferences: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
}).strict();

/** Re-sincronizar los conflictos de una ausencia tras resolver compromisos con Booking. */
export const absenceConflictSyncSchema = z.object({
  expectedRevision: expectedRevision.optional(),
}).strict();

/** Filtros de consulta del listado de ausencias. */
export const absenceQuerySchema = z.object({
  staffMemberId: z.string().uuid().optional(),
  localDate: localDateSchema.optional(),
  fromDate: localDateSchema.optional(),
  toDate: localDateSchema.optional(),
  status: z.enum(["ALL", "PENDING", "APPROVED", "APPLIED", "REJECTED", "WITHDRAWN"]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type AbsenceQuery = z.infer<typeof absenceQuerySchema>;

export type AbsenceSummary = {
  id: string;
  businessId: string;
  staffMemberId: string;
  staffMemberName: string | null;
  requestedByAccountId: string;
  localDate: string;
  startMinute: number;
  endMinute: number;
  reason: string | null;
  status: AbsenceStatus;
  revision: number;
  approvedByAccountId: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AbsenceEvent = {
  sequence: number;
  eventType: AbsenceEventType;
  principalType: string;
  actorAccountId: string | null;
  occurredAt: string;
  beforeRevision: number | null;
  afterRevision: number | null;
  changes: Record<string, unknown>;
  reasonCode: string | null;
};

/** Compromiso afectado por la ausencia: una reserva `CONFIRMED` que solapa el intervalo. */
export type AbsenceAffectedReservation = {
  reservationId: string;
  allocationId: string;
  staffMemberId: string;
  localDate: string;
  visibleStartAt: string;
  visibleEndAt: string;
  startsAt: string;
  endsAt: string;
  customerName: string | null;
  status: string;
  revision: number;
  serviceNames: string[];
  conflictId: string | null;
  conflictStatus: "OPEN" | "RESOLVED" | null;
  resolutionReference: string | null;
};
