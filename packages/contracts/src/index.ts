import { z } from "zod";
export * from "@youngkingz/contracts/catalog";
export * from "@youngkingz/contracts/clients";
export * from "@youngkingz/contracts/client-auth";
export * from "@youngkingz/contracts/professionals";
export * from "@youngkingz/contracts/schedules";
export * from "@youngkingz/contracts/staff-services";
export * from "@youngkingz/contracts/availability";
export * from "@youngkingz/contracts/booking";
export * from "@youngkingz/contracts/absence";
export * from "@youngkingz/contracts/attendance";

export const roles = ["OWNER", "RECEPTIONIST", "BARBER"] as const;
export const roleSchema = z.enum(roles);
export type RoleCode = z.infer<typeof roleSchema>;

export const capabilities = [
  "iam.self.read", "iam.self.update", "iam.sessions.read", "iam.sessions.terminate",
  "iam.contexts.list", "iam.contexts.switch", "iam.staff.list", "iam.staff.read",
  "iam.staff.create", "iam.staff.update", "iam.invitations.issue",
  "iam.invitations.reissue", "iam.invitations.revoke", "iam.roles.read",
  "iam.roles.assign", "iam.roles.revoke", "iam.grants.read", "iam.grants.issue",
  "iam.grants.revoke", "iam.access.read", "iam.access.suspend",
  "iam.access.reactivate", "iam.access.revoke", "iam.access.offboard",
  "iam.access.reonboard", "iam.credentials.change", "iam.security.recover",
  "iam.audit.read", "iam.operations.read",
  "catalog.read", "catalog.services.create", "catalog.services.update_profile",
  "catalog.services.update_terms", "catalog.services.publish", "catalog.services.lifecycle",
  "catalog.categories.manage",
  "professionals.read", "professionals.create", "professionals.update",
  "professionals.lifecycle", "professionals.self.read", "professionals.self.update",
  "schedules.read", "schedules.manage", "schedules.self.read",
  "staff-services.read", "staff-services.manage", "staff-services.self.read",
  "clients.read", "clients.manage", "clients.notes.read", "clients.notes.manage", "clients.links.read", "clients.links.manage"
  ,"availability.read", "availability.manage", "availability.self.read", "availability.impacts.read"
  ,"bookings.read", "bookings.history.read", "bookings.contact.manage",
  "bookings.override.cancel", "bookings.override.reschedule", "bookings.guest_access.recover",
  // H03.U05 · Agenda Staff (D-02).
  // Alcance de creación asistida de reservas por parte de Staff.
  "bookings.create",
  // Alcance de llegada (registro de presencia, NO attendance).
  "bookings.arrival",
  // Alcance de confirmación explícita de no-show.
  "bookings.no_show",
  // Ámbito propio: agenda, llegada y no-show sobre las reservas asignadas
  // al propio profesional. Sigue la convención `*.self.*` ya usada por
  // `availability.self.read`, `schedules.self.read` y `staff-services.self.read`.
  "bookings.self.read", "bookings.self.arrival", "bookings.self.no_show",
  // ─────────────────────────────────────────────────────────────────────────
  // H03.U06 · CAP-03-07 · Ausencias y conflictos.
  // Solicitud, consulta, aprobación, rechazo, retirada y APLICACIÓN de la
  // ausencia. El alcance profesional (propio vs. todo el Business) se
  // resuelve en servidor, nunca en el cliente.
  "absence.request", "absence.read", "absence.approve", "absence.reject",
  "absence.withdraw", "absence.apply",
  // ─────────────────────────────────────────────────────────────────────────
  // H03.U06 · CAP-03-08 · Prestación real (Attendance).
  // Registro desde reserva o walk-in, estados terminales, historial y
  // corrección trazable. `attendance.read.all` es el alcance de Business
  // completo; `attendance.read` es el alcance propio del profesional.
  "attendance.register", "attendance.read", "attendance.read.all", "attendance.correct"
] as const;
export const capabilitySchema = z.enum(capabilities);
export type Capability = z.infer<typeof capabilitySchema>;

export const delegableCapabilities: readonly Capability[] = [
  "iam.staff.list", "iam.staff.read", "iam.staff.create", "iam.staff.update",
  "iam.invitations.issue", "iam.invitations.reissue", "iam.invitations.revoke",
  "catalog.services.create", "catalog.services.update_profile", "catalog.services.update_terms",
  "catalog.services.publish", "catalog.services.lifecycle", "catalog.categories.manage",
  "professionals.create", "professionals.update", "professionals.lifecycle",
  "schedules.manage"
  ,"availability.manage", "availability.impacts.read"
  ,"bookings.read", "bookings.history.read"
];

/**
 * H03.U06 · Compatibilidad rol ↔ capability para concessions (D-04).
 *
 * Un `capability_grant` sólo es EFECTIVO si la capability pertenece al
 * alcance del rol que la recibe:
 *  · el conjunto base del rol (`roleCapabilities`), o
 *  · el conjunto explícito de capacidades adicionales delegables a ese rol.
 *
 * `BARBER` no tiene ninguna capacidad adicional delegable: el barbero opera
 * exclusivamente dentro de su ámbito profesional (`*.self.*`). Un grant a un
 * BARBER no otorga `bookings.read` (agenda compartida) ni ninguna otra
 * capability ajena a su rol — deny-by-default (Actor B, D-04).
 *
 * `absence.*` y `attendance.*` NO son delegables en H03.U06: se concede por
 * rol (`roleCapabilities`), nunca por grant.
 */
export const grantableCapabilitiesByRole: Readonly<Record<RoleCode, readonly Capability[]>> = {
  OWNER: delegableCapabilities,
  RECEPTIONIST: delegableCapabilities,
  BARBER: []
};

/**
 * ¿Puede un grant conferir esta capability a este rol?
 * `true` si la capability ya pertenece al conjunto base del rol (el grant es
 * un no-op innocuouso) o si está explícitamente delegable a ese rol.
 */
export function isGrantCompatibleWithRole(role: RoleCode, capability: Capability): boolean {
  return roleCapabilities[role].includes(capability) || grantableCapabilitiesByRole[role].includes(capability);
}

export const createStaffSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().trim().max(40).optional(),
  inviteNow: z.boolean().default(false),
  roles: z.array(roleSchema).max(3).default([])
}).superRefine((value, context) => {
  if (value.inviteNow && !value.email) context.addIssue({ code: "custom", path: ["email"], message: "Email is required to send an invitation" });
});

export const updateStaffSchema = z.object({ firstName: z.string().trim().min(1).max(100).optional(), lastName: z.string().trim().max(100).nullable().optional(), phone: z.string().trim().max(40).nullable().optional(), revision: z.number().int().positive() });
export const updateRolesSchema = z.object({ roles: z.array(roleSchema).max(3), revision: z.number().int().positive(), sensitiveConfirmation: z.string().optional() });
export const issueInvitationSchema = z.object({ email: z.string().email() });
export const acceptInvitationSchema = z.object({ token: z.string().min(32) });
export const grantSchema = z.object({ capability: capabilitySchema, expiresAt: z.string().datetime().optional(), roleAssignmentId: z.string().uuid() });
export const contextSwitchSchema = z.object({ roleAssignmentId: z.string().uuid(), revision: z.number().int().nonnegative() });
export const lifecycleSchema = z.object({ revision: z.number().int().positive(), reason: z.string().trim().min(3).max(500) });
export const terminateSessionsSchema = z.object({ scope: z.enum(["CURRENT", "OTHERS", "ALL"]), sessionId: z.string().uuid().optional() });

export type DomainErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION_ERROR" | "CONFLICT" | "STALE_REVISION" | "LAST_OWNER_PROTECTED" | "SESSION_REVOKED" | "ACCESS_RESTRICTED" | "ACCOUNT_RESTRICTED" | "PHONE_UNVERIFIED" | "MFA_REQUIRED" | "RECOVERY_REQUIRED" | "RECOVERY_CODE_INVALID" | "RECOVERY_CODE_USED" | "INVITATION_INVALID" | "INVITATION_EXPIRED" | "IDEMPOTENCY_CONFLICT" | "EXTERNAL_OUTCOME_UNKNOWN" | "SERVICE_NOT_PUBLISHABLE" | "SERVICE_ARCHIVED" | "CATEGORY_UNAVAILABLE" | "CATEGORY_IN_USE" | "CATEGORY_ARCHIVED" | "PROFESSIONAL_PROFILE_EXISTS" | "PROFESSIONAL_STAFF_NOT_ACTIVE" | "SCHEDULE_STAFF_NOT_EDITABLE" | "STAFF_SERVICES_STAFF_NOT_EDITABLE" | "BUSINESS_NOT_BOOKABLE" | "BOOKING_POLICY_MISSING" | "BOOKING_POLICY_INVALID" | "SERVICE_NOT_BOOKABLE" | "PROFESSIONAL_NOT_ELIGIBLE" | "OUTSIDE_BOOKING_HORIZON" | "START_TIME_NOT_ALLOWED" | "PAST_START_TIME" | "NO_AVAILABILITY" | "SLOT_CONFLICT" | "AVAILABILITY_IMPACT_CONFLICT" | "TIMEZONE_AMBIGUOUS"
  | "BOOKING_QUOTE_EXPIRED" | "COMMERCIAL_TERMS_CHANGED" | "BOOKING_NOT_AVAILABLE" | "BOOKING_NOT_OWNED"
  | "BOOKING_NOT_FOUND" | "GUEST_ACCESS_INVALID" | "GUEST_RECOVERY_NOT_VERIFIED" | "BOOKING_CUTOFF_EXPIRED"
  | "BOOKING_ALREADY_CANCELLED" | "BOOKING_OPERATION_CONFLICT" | "OPERATION_PENDING"
  | "BOOKING_OPERATION_NOT_RECOVERABLE" | "CLIENT_AUTH_INSUFFICIENT" | "RATE_LIMITED"
  | "BOOKING_QUOTE_INVALID" | "BOOKING_POLICY_UNAVAILABLE" | "BOOKING_NO_SHOW_WINDOW_NOT_OPEN";
export class DomainError extends Error { constructor(public readonly code: DomainErrorCode, message: string, public readonly statusCode = 400, public readonly details?: unknown) { super(message); } }

export const roleCapabilities: Readonly<Record<RoleCode, readonly Capability[]>> = {
  // OWNER · autoridad general del Business (todas las capabilities salvo
  // `iam.security.recover`, que es exclusiva del proceso de recuperación).
  OWNER: capabilities.filter((capability) => capability !== "iam.security.recover"),
  // RECEPTIONIST · agenda compartida y operaciones de recepción:
  // consulta, historial, creación asistida, reprogramación, reasignación,
  // cancelación, llegada y no-show sobre las reservas del Business.
  // H03.U06: además opera ausencias (solicitar, revisar, resolver conflictos,
  // aplicar) y atenciones (registrar, consultar, corregir) del Business.
  RECEPTIONIST: ["iam.self.read", "iam.self.update", "iam.sessions.read", "iam.sessions.terminate", "iam.contexts.list", "iam.contexts.switch", "catalog.read", "professionals.read", "professionals.self.read", "professionals.self.update", "schedules.read", "schedules.self.read", "staff-services.read", "staff-services.self.read", "clients.read", "clients.manage", "clients.notes.read", "clients.notes.manage", "clients.links.read", "availability.read", "availability.impacts.read", "bookings.read", "bookings.history.read", "bookings.create", "bookings.override.cancel", "bookings.override.reschedule", "bookings.arrival", "bookings.no_show",
    // CAP-03-07 · Ausencias y conflictos (ámbito Business).
    "absence.request", "absence.read", "absence.approve", "absence.reject", "absence.withdraw", "absence.apply",
    // CAP-03-08 · Prestación real (ámbito Business).
    "attendance.register", "attendance.read", "attendance.read.all", "attendance.correct"],
  // BARBER · agenda propia y acciones explícitamente autorizadas sobre su ámbito:
  // lee únicamente sus propias reservas (`bookings.self.read`, sin
  // `bookings.read`), y registra llegada / no-show sólo sobre reservas
  // asignadas a sí mismo (el alcance se resuelve en servidor).
  // H03.U06: solicita y consulta SUS ausencias, y registra/corrige SUS
  // atenciones. NO aprueba, rechaza ni aplica ausencias (segregación de
  // funciones: quien solicita no se auto-aprueba) y NO lee el historial
  // completo de atenciones del Business.
  BARBER: ["iam.self.read", "iam.self.update", "iam.sessions.read", "iam.sessions.terminate", "iam.contexts.list", "iam.contexts.switch", "professionals.self.read", "professionals.self.update", "schedules.self.read", "staff-services.self.read", "availability.self.read", "bookings.self.read", "bookings.self.arrival", "bookings.self.no_show",
    // CAP-03-07 · Ausencias: sólo las propias (el alcance se resuelve en servidor).
    "absence.request", "absence.read", "absence.withdraw",
    // CAP-03-08 · Prestación real: sólo la propia (el alcance se resuelve en servidor).
    "attendance.register", "attendance.read", "attendance.correct"]
};
