import { sql } from "drizzle-orm";
import {
  bigint, check, date, foreignKey, index, integer,
  jsonb, pgSchema, text, timestamp, unique, uuid
} from "drizzle-orm/pg-core";

/**
 * H03.U06 · CAP-03-07 · Ausencias y conflictos — esquema Drizzle.
 *
 * Refleja exactamente la migración `202611120001_h03_u06_absence.sql`.
 *
 * Reconciliación con C01 `01_CURRENT_TARGET_AND_PERSISTENCE.md`:
 *  · la indisponibilidad efectiva vive en `team.staff_effective_unavailability`
 *    (no en `availability.staff_effective_unavailability`); se reutiliza con
 *    `source_type = 'APPLIED_ABSENCE'` y `source_id` = id de la solicitud;
 *  · `iam.user_accounts` es global (sin `business_id`): las FKs de actor son
 *    sobre `id` y el aislamiento por Business lo garantiza `business_id` junto
 *    con la FK compuesta a `team.staff_members(business_id, id)`.
 *
 * Patrón de proyecciones locales (igual que `clients.ts`): evita importar
 * `schema.ts` desde un módulo de dominio y, por tanto, evita ciclos.
 */

export const absenceSchema = pgSchema("absence");

/* ── Proyecciones mínimas para FKs cross-schema (patrón clients.ts) ─────── */

const absenceBusinesses = absenceSchema.table("businesses", {
  id: uuid("id").notNull()
}, (table) => [unique("absence_businesses_id_key").on(table.id)]);

const absenceUserAccounts = absenceSchema.table("user_accounts", {
  id: uuid("id").notNull()
}, (table) => [unique("absence_user_accounts_id_key").on(table.id)]);

const absenceStaffMembers = absenceSchema.table("staff_members", {
  id: uuid("id").notNull(), businessId: uuid("business_id").notNull()
}, (table) => [unique("absence_staff_members_business_id_id_key").on(table.businessId, table.id)]);

const absenceOperationAttempts = absenceSchema.table("operation_attempts", {
  operationId: uuid("operation_id").notNull()
}, (table) => [unique("absence_operation_attempts_operation_id_key").on(table.operationId)]);

/* ── absence.absence_requests ───────────────────────────────────────────── */

export const absenceRequests = absenceSchema.table("absence_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  staffMemberId: uuid("staff_member_id").notNull(),
  requestedByAccountId: uuid("requested_by_account_id").notNull(),
  createdOperationId: uuid("created_operation_id").notNull(),
  localDate: date("local_date").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("PENDING"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  approvedByAccountId: uuid("approved_by_account_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  rejectReason: text("reject_reason"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("absence_requests_interval_check", sql`${table.startMinute} < ${table.endMinute}`),
  check("absence_requests_start_minute_check", sql`${table.startMinute} >= 0 and ${table.startMinute} < 1440`),
  check("absence_requests_end_minute_check", sql`${table.endMinute} > 0 and ${table.endMinute} <= 1440`),
  check("absence_requests_status_check", sql`${table.status} in ('PENDING','APPROVED','APPLIED','REJECTED','WITHDRAWN')`),
  check("absence_requests_revision_check", sql`${table.revision} >= 1`),
  unique("absence_requests_unique_business_id_id").on(table.businessId, table.id),
  foreignKey({ columns: [table.businessId], foreignColumns: [absenceBusinesses.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.staffMemberId], foreignColumns: [absenceStaffMembers.businessId, absenceStaffMembers.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.requestedByAccountId], foreignColumns: [absenceUserAccounts.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.approvedByAccountId], foreignColumns: [absenceUserAccounts.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.createdOperationId], foreignColumns: [absenceOperationAttempts.operationId] }).onDelete("restrict"),
  index("absence_requests_staff_date").on(table.businessId, table.staffMemberId, table.localDate),
  index("absence_requests_status").on(table.businessId, table.status),
]);

/* ── absence.absence_events (append-only) ───────────────────────────────── */

export const absenceEvents = absenceSchema.table("absence_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  absenceRequestId: uuid("absence_request_id").notNull(),
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
  check("absence_events_sequence_check", sql`${table.sequence} >= 1`),
  check("absence_events_event_type_check", sql`${table.eventType} in ('ABSENCE_REQUESTED','ABSENCE_APPROVED','ABSENCE_REJECTED','ABSENCE_WITHDRAWN','ABSENCE_APPLIED','ABSENCE_CONFLICT_DETECTED','ABSENCE_COMMITMENT_RESOLVED')`),
  unique("absence_events_unique_sequence").on(table.businessId, table.absenceRequestId, table.sequence),
  foreignKey({ columns: [table.businessId], foreignColumns: [absenceBusinesses.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.absenceRequestId], foreignColumns: [absenceRequests.businessId, absenceRequests.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.operationId], foreignColumns: [absenceOperationAttempts.operationId] }).onDelete("restrict"),
  index("absence_events_request").on(table.businessId, table.absenceRequestId, table.sequence),
]);
