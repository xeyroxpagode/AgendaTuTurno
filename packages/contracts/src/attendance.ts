import { z } from "zod";

/**
 * H03.U06 · CAP-03-08 · Prestación real (Attendance) — contratos compartidos.
 *
 * Attendance representa lo que OCURRIÓ en la barbería, no lo que el cliente
 * había reservado. Es una entidad distinta de `Reservation` (INV-ATT-01) y
 * no es llegada (INV-ATT-02) ni no-show (INV-ATT-03).
 *
 * CAP-03-06 (presencia y no-show) permanece en el dominio de Booking con las
 * capabilities `bookings.arrival` / `bookings.no_show` / `bookings.self.*`:
 * aquí sólo hay `attendance.*`, que gobierna la prestación real.
 */

/** Estados de la atención. `IN_PROGRESS` es opcional y no bloquea el registro directo de un terminal. */
export const attendanceStatuses = ["IN_PROGRESS", "COMPLETED", "PARTIAL", "INTERRUPTED"] as const;
export type AttendanceStatus = (typeof attendanceStatuses)[number];

/** Estados terminales: no se reabren por registro, sólo por corrección trazable. */
export const terminalAttendanceStatuses = ["COMPLETED", "PARTIAL", "INTERRUPTED"] as const;
export type TerminalAttendanceStatus = (typeof terminalAttendanceStatuses)[number];

/** Tipos de evento del ledger append-only de atenciones. */
export const attendanceEventTypes = [
  "ATTENDANCE_REGISTERED",
  "ATTENDANCE_WALKIN_REGISTERED",
  "ATTENDANCE_COMPLETED",
  "ATTENDANCE_PARTIAL",
  "ATTENDANCE_INTERRUPTED",
  "ATTENDANCE_CORRECTED",
] as const;
export type AttendanceEventType = (typeof attendanceEventTypes)[number];

const expectedRevision = z.number().int().positive();

/** Servicio efectivamente realizado. Puede diferir de `reservation_items`. */
export const performedServiceSchema = z.object({
  serviceId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  durationMinutes: z.number().int().min(0).max(1440),
  priceMinor: z.number().int().min(0).optional(),
  currency: z.literal("ARS").optional(),
}).strict();
export type PerformedService = z.infer<typeof performedServiceSchema>;

/**
 * Snapshot de contacto de la atención.
 * Es OBLIGATORIO para walk-in (`reservation_id = NULL`): es la única identidad
 * de una atención sin reserva. No crea ni vincula una cuenta CLIENT.
 */
export const attendanceContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(6).max(40),
  email: z.string().email().max(254).optional(),
}).strict();
export type AttendanceContact = z.infer<typeof attendanceContactSchema>;

/**
 * Registro de atención (CAP-03-08-R1 / R2).
 * · Con `reservationId`: atención desde una reserva legítima (`walkIn` debe ser `false`).
 * · Sin `reservationId` y con `walkIn: true`: atención sin reserva (walk-in legítimo).
 * Nunca se crea una Reservation ficticia ni una cuenta CLIENT.
 */
export const attendanceRegisterSchema = z.object({
  reservationId: z.string().uuid().optional(),
  staffMemberId: z.string().uuid().optional(),
  attendedByStaffMemberId: z.string().uuid().optional(),
  clientProfileId: z.string().uuid().optional(),
  walkIn: z.boolean().default(false),
  contactSnapshot: attendanceContactSchema.optional(),
  servicesPerformedSnapshot: z.array(performedServiceSchema).max(20).optional(),
  startedAt: z.string().datetime().optional(),
  status: z.enum(terminalAttendanceStatuses).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();
export type AttendanceRegisterInput = z.infer<typeof attendanceRegisterSchema>;

/** Transición a un estado terminal de la atención (CAP-03-08-R3). */
export const attendanceStateSchema = z.object({
  status: z.enum(terminalAttendanceStatuses),
  servicesPerformedSnapshot: z.array(performedServiceSchema).min(1).max(20),
  finishedAt: z.string().datetime().optional(),
  notes: z.string().trim().max(1000).optional(),
  expectedRevision,
}).strict();
export type AttendanceStateInput = z.infer<typeof attendanceStateSchema>;

/**
 * Corrección autorizada de una atención (CAP-03-08-R4).
 * El motivo es obligatorio: sin motivo la corrección es inválida (400).
 */
export const attendanceCorrectionSchema = z.object({
  status: z.enum(attendanceStatuses).optional(),
  attendedByStaffMemberId: z.string().uuid().optional(),
  contactSnapshot: attendanceContactSchema.optional(),
  servicesPerformedSnapshot: z.array(performedServiceSchema).max(20).optional(),
  notes: z.string().trim().max(1000).optional(),
  reason: z.string().trim().min(3).max(500),
  expectedRevision,
}).strict();
export type AttendanceCorrectionInput = z.infer<typeof attendanceCorrectionSchema>;

/** Filtros del historial de atenciones. */
export const attendanceQuerySchema = z.object({
  staffMemberId: z.string().uuid().optional(),
  clientProfileId: z.string().uuid().optional(),
  reservationId: z.string().uuid().optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(["ALL", "IN_PROGRESS", "COMPLETED", "PARTIAL", "INTERRUPTED"]).default("ALL"),
  walkIn: z.enum(["ALL", "ONLY", "EXCLUDE"]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type AttendanceQuery = z.infer<typeof attendanceQuerySchema>;

export type AttendanceSummary = {
  id: string;
  businessId: string;
  reservationId: string | null;
  staffMemberId: string;
  attendedByStaffMemberId: string;
  attendedByStaffMemberName: string | null;
  clientProfileId: string | null;
  walkIn: boolean;
  status: AttendanceStatus;
  startedAt: string;
  finishedAt: string | null;
  contact: { name: string | null; phone: string | null; email: string | null };
  servicesPerformed: Array<{ name: string; durationMinutes: number; priceMinor: number | null }>;
  reservedServices: Array<{ name: string; durationMinutes: number; priceMinor: number }>;
  notes: string | null;
  revision: number;
  correctionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AttendanceCorrection = {
  id: string;
  changedByAccountId: string;
  changedByName: string | null;
  changedAt: string;
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
  reason: string;
};

export type AttendanceEvent = {
  sequence: number;
  eventType: AttendanceEventType;
  principalType: string;
  actorAccountId: string | null;
  occurredAt: string;
  beforeRevision: number | null;
  afterRevision: number | null;
  changes: Record<string, unknown>;
  reasonCode: string | null;
};
