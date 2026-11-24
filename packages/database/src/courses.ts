import { bigint, date, index, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * H07 · Cursos y sesiones — espejo Drizzle de las migraciones
 * `202611240003_h07_courses.sql` y `202611240004_h07_course_sessions.sql`.
 *
 * La ocupación canónica NO se duplica aquí: vive en
 * `availability.resource_allocations` con `source_type='COURSE_SESSION'`.
 */

export const coursesSchema = pgSchema("courses");

export const courses = coursesSchema.table("courses", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  description: text("description"),
  contactChannel: text("contact_channel"),
  contactValue: text("contact_value"),
  status: text("status").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdByAccountId: uuid("created_by_account_id").notNull(),
  operationId: uuid("operation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, (table) => [
  index("courses_business_status").on(table.businessId, table.status)
]);

export const courseEvents = coursesSchema.table("course_events", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  courseId: uuid("course_id").notNull(),
  eventType: text("event_type").notNull(),
  actorAccountId: uuid("actor_account_id").notNull(),
  operationId: uuid("operation_id"),
  changes: jsonb("changes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, (table) => [
  index("course_events_lookup").on(table.businessId, table.courseId, table.createdAt)
]);

export const courseSessions = coursesSchema.table("course_sessions", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  courseId: uuid("course_id").notNull(),
  instructorStaffMemberId: uuid("instructor_staff_member_id").notNull(),
  localDate: date("local_date").notNull(),
  timezone: text("timezone").notNull(),
  visibleStartAt: timestamp("visible_start_at", { withTimezone: true }),
  occupiedStartAt: timestamp("occupied_start_at", { withTimezone: true }).notNull(),
  occupiedEndAt: timestamp("occupied_end_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  operationId: uuid("operation_id"),
  confirmedByAccountId: uuid("confirmed_by_account_id"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  completedByAccountId: uuid("completed_by_account_id"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, (table) => [
  index("course_sessions_lookup").on(table.businessId, table.courseId, table.localDate),
  index("course_sessions_instructor").on(table.businessId, table.instructorStaffMemberId, table.occupiedStartAt)
]);

export const courseSessionEvents = coursesSchema.table("course_session_events", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  eventType: text("event_type").notNull(),
  actorAccountId: uuid("actor_account_id").notNull(),
  operationId: uuid("operation_id"),
  changes: jsonb("changes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, (table) => [
  index("course_session_events_lookup").on(table.businessId, table.sessionId, table.createdAt)
]);
