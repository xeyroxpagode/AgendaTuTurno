import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, foreignKey, index,
  jsonb, pgSchema, text, timestamp, unique, uniqueIndex, uuid
} from "drizzle-orm/pg-core";
import { clientProfiles } from "./clients.js";

/**
 * H03.U06 · CAP-03-08 · Prestación real (Attendance) — esquema Drizzle.
 *
 * Refleja exactamente la migración `202611120002_h03_u06_attendance.sql`.
 *
 * Reconciliación con C01 `01_CURRENT_TARGET_AND_PERSISTENCE.md`:
 *  · la representación legítima de walk-in es `reservation_id = NULL` con
 *    `walk_in = true`. Ningún CHECK la prohíbe: los CHECKS obligan a que
 *    `walk_in ⇒ reservation_id IS NULL` y `NOT walk_in ⇒ reservation_id IS NOT NULL`,
 *    lo que impide tanto la reserva ficticia como la atención sin reserva mal formada;
 *  · una reserva admite como mucho UNA atención terminal
 *    (índice único parcial `attendances_one_terminal_per_reservation`).
 */

export const attendanceSchema = pgSchema("attendance");

/* ── Proyecciones mínimas para FKs cross-schema (patrón clients.ts) ─────── */

const attendanceBusinesses = attendanceSchema.table("businesses", {
  id: uuid("id").notNull()
}, (table) => [unique("attendance_businesses_id_key").on(table.id)]);

const attendanceUserAccounts = attendanceSchema.table("user_accounts", {
  id: uuid("id").notNull()
}, (table) => [unique("attendance_user_accounts_id_key").on(table.id)]);

const attendanceStaffMembers = attendanceSchema.table("staff_members", {
  id: uuid("id").notNull(), businessId: uuid("business_id").notNull()
}, (table) => [unique("attendance_staff_members_business_id_id_key").on(table.businessId, table.id)]);

const attendanceReservations = attendanceSchema.table("reservations", {
  id: uuid("id").notNull(), businessId: uuid("business_id").notNull()
}, (table) => [unique("attendance_reservations_business_id_id_key").on(table.businessId, table.id)]);

const attendanceOperationAttempts = attendanceSchema.table("operation_attempts", {
  operationId: uuid("operation_id").notNull()
}, (table) => [unique("attendance_operation_attempts_operation_id_key").on(table.operationId)]);

/* ── attendance.attendances ─────────────────────────────────────────────── */

export const attendances = attendanceSchema.table("attendances", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  /** NULL ⇒ atención sin reserva (walk-in legítimo). Nunca una reserva ficticia. */
  reservationId: uuid("reservation_id"),
  /** Profesional que REGISTRA la atención. */
  staffMemberId: uuid("staff_member_id").notNull(),
  /** Profesional RESPONSABLE de la atención. */
  attendedByStaffMemberId: uuid("attended_by_staff_member_id").notNull(),
  /** NULL ⇒ no hay ficha CRM asociada (walk-in no crea cuenta CLIENT). */
  clientProfileId: uuid("client_profile_id"),
  walkIn: boolean("walk_in").notNull().default(false),
  status: text("status").notNull().default("IN_PROGRESS"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** Servicios EFECTIVAMENTE realizados (pueden diferir de `reservation_items`). */
  servicesPerformedSnapshot: jsonb("services_performed_snapshot"),
  /** Nombre/teléfono: obligatorio en walk-in. */
  contactSnapshot: jsonb("contact_snapshot"),
  notes: text("notes"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("attendances_walk_in_requires_contact", sql`not ${table.walkIn} or ${table.contactSnapshot} is not null`),
  check("attendances_walk_in_has_no_reservation", sql`not ${table.walkIn} or ${table.reservationId} is null`),
  check("attendances_requires_reservation_or_walk_in", sql`${table.reservationId} is not null or ${table.walkIn}`),
  check("attendances_terminal_finished_check", sql`(${table.status} = 'IN_PROGRESS' and ${table.finishedAt} is null) or (${table.status} <> 'IN_PROGRESS' and ${table.finishedAt} is not null)`),
  check("attendances_terminal_services_check", sql`${table.status} = 'IN_PROGRESS' or ${table.servicesPerformedSnapshot} is not null`),
  check("attendances_status_check", sql`${table.status} in ('IN_PROGRESS','COMPLETED','PARTIAL','INTERRUPTED')`),
  check("attendances_revision_check", sql`${table.revision} >= 1`),
  unique("attendances_unique_business_id_id").on(table.businessId, table.id),
  foreignKey({ columns: [table.businessId], foreignColumns: [attendanceBusinesses.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.reservationId], foreignColumns: [attendanceReservations.businessId, attendanceReservations.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.staffMemberId], foreignColumns: [attendanceStaffMembers.businessId, attendanceStaffMembers.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.attendedByStaffMemberId], foreignColumns: [attendanceStaffMembers.businessId, attendanceStaffMembers.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.clientProfileId], foreignColumns: [clientProfiles.businessId, clientProfiles.id] }).onDelete("restrict"),
  index("attendances_reservation").on(table.businessId, table.reservationId),
  index("attendances_staff_started").on(table.businessId, table.attendedByStaffMemberId, table.startedAt),
  index("attendances_business_status").on(table.businessId, table.status, table.startedAt),
  uniqueIndex("attendances_one_terminal_per_reservation")
    .on(table.businessId, table.reservationId)
    .where(sql`${table.reservationId} is not null and ${table.status} in ('COMPLETED','PARTIAL','INTERRUPTED')`),
]);

/* ── attendance.attendance_corrections ──────────────────────────────────── */

export const attendanceCorrections = attendanceSchema.table("attendance_corrections", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  attendanceId: uuid("attendance_id").notNull(),
  changedByAccountId: uuid("changed_by_account_id").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  beforeSnapshot: jsonb("before_snapshot").notNull(),
  afterSnapshot: jsonb("after_snapshot").notNull(),
  reason: text("reason").notNull(),
}, table => [
  check("attendance_corrections_reason_check", sql`length(trim(${table.reason})) > 0`),
  unique("attendance_corrections_unique_business_id_id").on(table.businessId, table.id),
  foreignKey({ columns: [table.businessId], foreignColumns: [attendanceBusinesses.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.attendanceId], foreignColumns: [attendances.businessId, attendances.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.changedByAccountId], foreignColumns: [attendanceUserAccounts.id] }).onDelete("restrict"),
  index("attendance_corrections_attendance").on(table.businessId, table.attendanceId, table.changedAt),
]);

/* ── attendance.attendance_events (append-only) ─────────────────────────── */

export const attendanceEvents = attendanceSchema.table("attendance_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  attendanceId: uuid("attendance_id").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(),
  operationId: uuid("operation_id").notNull(),
  principalType: text("principal_type").notNull(),
  actorAccountId: uuid("actor_account_id"),
  staffMemberId: uuid("staff_member_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  beforeRevision: bigint("before_revision", { mode: "number" }),
  afterRevision: bigint("after_revision", { mode: "number" }),
  changes: jsonb("changes").notNull().default(sql`'{}'::jsonb`),
  reasonCode: text("reason_code"),
}, table => [
  check("attendance_events_sequence_check", sql`${table.sequence} >= 1`),
  check("attendance_events_event_type_check", sql`${table.eventType} in ('ATTENDANCE_REGISTERED','ATTENDANCE_WALKIN_REGISTERED','ATTENDANCE_COMPLETED','ATTENDANCE_PARTIAL','ATTENDANCE_INTERRUPTED','ATTENDANCE_CORRECTED')`),
  unique("attendance_events_unique_sequence").on(table.businessId, table.attendanceId, table.sequence),
  foreignKey({ columns: [table.businessId], foreignColumns: [attendanceBusinesses.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.attendanceId], foreignColumns: [attendances.businessId, attendances.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.operationId], foreignColumns: [attendanceOperationAttempts.operationId] }).onDelete("restrict"),
  index("attendance_events_attendance").on(table.businessId, table.attendanceId, table.sequence),
]);
