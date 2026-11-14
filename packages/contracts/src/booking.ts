import { z } from "zod";
import { localDateSchema, professionalPreferenceSchema } from "@youngkingz/contracts/availability";

/* ─────────────────────────── Estados e identidad ─────────────────────────── */

/**
 * H03.U05 · Estado de reserva.
 *
 * `NO_SHOW` es el único identificador normativo del estado "no se presentó"
 * (B01 §B4.1 y §RB-01, C01 §1.2). No existe un estado equivalente
 * `NO_SHOW_CONFIRMED`: ese literal es el nombre del EVENTO de historial
 * (B01 §B4.5) y nunca un valor de `booking.reservations.status`.
 */
export const reservationStatuses = ["CONFIRMED", "CANCELLED", "NO_SHOW"] as const;
export type ReservationStatus = (typeof reservationStatuses)[number];
export const ownerTypes = ["CLIENT", "GUEST"] as const;
export type OwnerType = (typeof ownerTypes)[number];
export const guestCredentialStatuses = ["ACTIVE", "REVOKED"] as const;
export type GuestCredentialStatus = (typeof guestCredentialStatuses)[number];
export const recoveryCaseStatuses = ["REQUESTED", "VERIFIED", "COMPLETED", "REJECTED"] as const;
export type RecoveryCaseStatus = (typeof recoveryCaseStatuses)[number];
/**
 * H03.U05 · Tipos de evento del historial de reservas.
 *
 * Los dos eventos nuevos usan los nombres del Specify B01 §B4.5
 * (`NO_SHOW_CONFIRMED`, `ARRIVAL_REGISTERED`), que son distintos del
 * identificador de estado `NO_SHOW`: un evento describe una acción
 * registrada, el estado describe la situación vigente de la reserva.
 *
 * H03.U06 · U05-CORR-07: `RESERVATION_REASSIGNED` distingue la reasignación
 * de profesional (conserva fecha y hora) de la reprogramación (cambia el turno).
 */
export const bookingEventTypes = [
  "RESERVATION_CONFIRMED",
  "RESERVATION_CANCELLED",
  "RESERVATION_RESCHEDULED",
  "RESERVATION_REASSIGNED",
  "RESERVATION_CONTACT_UPDATED",
  "RESERVATION_ACCOUNT_ASSOCIATED",
  "GUEST_ACCESS_REVOKED",
  "GUEST_ACCESS_REISSUED",
  "STAFF_EXCEPTION_APPLIED",
  "NO_SHOW_CONFIRMED",
  "ARRIVAL_REGISTERED",
] as const;
export type BookingEventType = (typeof bookingEventTypes)[number];

/* ─────────────────────────── Principales ─────────────────────────── */

export type BookingPrincipal =
  | { kind: "STAFF"; businessId: string; staffMemberId: string; accountId: string }
  | { kind: "CLIENT"; businessId: string; accountId: string; authSessionId: string }
  | { kind: "GUEST_INTENT"; businessId: string; intentId: string; proofDigest: string }
  | { kind: "GUEST_RESERVATION"; businessId: string; reservationId: string; credentialId: string };

export const bookingErrorCodes = [
  "BOOKING_QUOTE_EXPIRED", "COMMERCIAL_TERMS_CHANGED", "BOOKING_NOT_AVAILABLE", "BOOKING_NOT_OWNED",
  "BOOKING_NOT_FOUND", "GUEST_ACCESS_INVALID", "GUEST_RECOVERY_NOT_VERIFIED", "BOOKING_CUTOFF_EXPIRED",
  "BOOKING_ALREADY_CANCELLED", "BOOKING_OPERATION_CONFLICT", "STALE_REVISION", "IDEMPOTENCY_CONFLICT",
  "OPERATION_PENDING", "BOOKING_OPERATION_NOT_RECOVERABLE", "CLIENT_AUTH_INSUFFICIENT", "FORBIDDEN",
  "RATE_LIMITED", "BOOKING_POLICY_UNAVAILABLE", "SLOT_CONFLICT", "BOOKING_QUOTE_INVALID",
  "BOOKING_NO_SHOW_WINDOW_NOT_OPEN",
] as const;
export type BookingErrorCode = (typeof bookingErrorCodes)[number];

/* ─────────────────────────── Cotización (TTL 5 min) ─────────────────────────── */

export const BOOKING_QUOTE_TTL_SECONDS = 300;
export const BOOKING_MAX_SERVICES = 10;

export const serviceIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(BOOKING_MAX_SERVICES)
  .refine(ids => new Set(ids).size === ids.length, "Service IDs must be distinct");

export const bookingQuoteRequestSchema = z.object({
  serviceIds: serviceIdsSchema,
  professionalPreference: professionalPreferenceSchema,
  localDate: localDateSchema,
  visibleStart: z.string().regex(/^([01]\d|2[0-3]):[0-5][0-9]$/, "Time must be HH:mm"),
}).strict();
export type BookingQuoteRequest = z.infer<typeof bookingQuoteRequestSchema>;

export const bookingContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(6).max(40),
  email: z.string().email().max(254).optional(),
}).strict();
export type BookingContact = z.infer<typeof bookingContactSchema>;

/** Contenido canónico de la cotización firmada (HMAC-SHA256). */
export type BookingQuotePayload = {
  v: 1;
  businessId: string;
  serviceIds: string[];
  termsVersionIds: string[];
  professionalPreference: z.infer<typeof professionalPreferenceSchema>;
  localDate: string;
  visibleStartMinute: number;
  policyVersionId: string;
  policyVersionNumber: number;
  policyRevision: number;
  currency: "ARS";
  commercialTotalMinor: number;
  items: Array<{
    serviceId: string;
    termsVersionId: string;
    durationMinutes: number;
    preBufferMinutes: number;
    postBufferMinutes: number;
    priceMinor: number;
    currency: "ARS";
  }>;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
};

export const bookingConfirmGuestSchema = z.object({
  quote: z.string().min(1),
  intentId: z.string().uuid(),
  intentProof: z.string().min(43).max(128),
  contact: bookingContactSchema,
  acceptTerms: z.literal(true),
}).strict();
export type BookingConfirmGuestInput = z.infer<typeof bookingConfirmGuestSchema>;

export const bookingConfirmClientSchema = z.object({
  quote: z.string().min(1),
  acceptTerms: z.literal(true),
}).strict();

/* ─────────────────────────── Mutaciones públicas ─────────────────────────── */

const expectedRevision = z.number().int().positive();

export const cancelReservationSchema = z.object({
  expectedRevision,
  reason: z.string().trim().max(500).optional(),
}).strict();

export const rescheduleReservationSchema = z.object({
  expectedRevision,
  localDate: localDateSchema,
  visibleStart: z.string().regex(/^([01]\d|2[0-3]):[0-5][0-9]$/),
  professionalPreference: professionalPreferenceSchema.optional(),
}).strict();

export const assistedRecoverySchema = z.object({
  reservationId: z.string().uuid(),
  verificationMethod: z.string().trim().min(3).max(80),
  evidenceReference: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(3).max(500),
  /** Desenlace del caso: verificado antes de emitir o rechazo registrado. */
  outcome: z.enum(["VERIFIED", "REJECTED"]),
}).strict();

export const staffOverrideCancelSchema = z.object({
  expectedRevision,
  reason: z.string().trim().min(3).max(500),
}).strict();
export const staffOverrideRescheduleSchema = rescheduleReservationSchema.extend({
  reason: z.string().trim().min(3).max(500),
});

/* ─────────────────────────── H03.U05 · Agenda Staff ─────────────────────────── */

/**
 * Filtros de la agenda staff. `status` acepta el valor de estado `NO_SHOW`
 * (mismo identificador que `booking.reservations.status`).
 */
export const staffAgendaQuerySchema = z.object({
  fromDate: localDateSchema.optional(),
  toDate: localDateSchema.optional(),
  status: z.enum(["ALL", "CONFIRMED", "CANCELLED", "NO_SHOW"]).default("ALL"),
  staffMemberId: z.string().uuid().optional(),
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type StaffAgendaQuery = z.infer<typeof staffAgendaQuerySchema>;

/** Creación asistida de reserva por parte de Staff (OWNER / RECEPTIONIST). */
export const staffCreateReservationSchema = z.object({
  serviceIds: serviceIdsSchema,
  localDate: localDateSchema,
  visibleStart: z.string().regex(/^([01]\d|2[0-3]):[0-5][0-9]$/, "Time must be HH:mm"),
  professionalPreference: professionalPreferenceSchema,
  contact: bookingContactSchema,
  reason: z.string().trim().min(3).max(500).optional(),
}).strict();
export type StaffCreateReservationInput = z.infer<typeof staffCreateReservationSchema>;

/**
 * Reasignación de profesional: conserva `reservation_id` y devuelve la reserva
 * al profesional destino elegible para TODOS los servicios de la reserva.
 */
export const staffReassignReservationSchema = z.object({
  expectedRevision,
  staffMemberId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type StaffReassignReservationInput = z.infer<typeof staffReassignReservationSchema>;

/**
 * Registro de llegada. No modifica el estado de la reserva (sigue `CONFIRMED`)
 * y no representa Attendance (U07): sólo deja constancia en el historial.
 */
export const staffArrivalReservationSchema = z.object({
  expectedRevision,
  arrivalMethod: z.enum(["PRESENCIAL", "TELEFONICO"]).optional(),
}).strict();
export type StaffArrivalReservationInput = z.infer<typeof staffArrivalReservationSchema>;

/**
 * Confirmación explícita de no-show. El cliente NO se presentó: la reserva
 * pasa a `NO_SHOW` (terminal) y libera su Allocation.
 */
export const staffNoShowReservationSchema = z.object({
  expectedRevision,
  reason: z.string().trim().min(3).max(500).optional(),
}).strict();
export type StaffNoShowReservationInput = z.infer<typeof staffNoShowReservationSchema>;

export type StaffReservationSummary = {
  id: string;
  status: ReservationStatus;
  revision: number;
  staffMemberId: string;
  startsAt: string;
  endsAt: string;
  localDate: string;
  commercialTotalMinor: number;
  currency: string;
  ownerType: "CLIENT" | "GUEST";
  customerName: string | null;
  serviceNames: string[];
  arrivedAt: string | null;
  noShowAt: string | null;
};

export type StaffReservationDetail = StaffReservationSummary & {
  contact: { name: string; phone: string; email: string | null };
  items: Array<{
    position: number;
    serviceId: string;
    serviceName: string;
    durationMinutes: number;
    priceMinor: number;
    currency: string;
  }>;
  events: Array<{
    sequence: number;
    eventType: BookingEventType;
    principalType: string;
    actorAccountId: string | null;
    occurredAt: string;
    beforeRevision: number | null;
    afterRevision: number | null;
    changes: Record<string, unknown>;
    reasonCode: string | null;
  }>;
};

/* ─────────────────────────── Política histórica ─────────────────────────── */

export type PolicySnapshot = {
  id: string;
  versionNumber: number;
  revision: number;
  horizonCalendarDates: number;
  minLeadMinutes: number;
  startStepMinutes: number;
  cancelCutoffMinutes: number;
  rescheduleCutoffMinutes: number;
  publicBookingEnabled: boolean;
};
