import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, customType, date, foreignKey, index, integer,
  pgSchema, text, timestamp, unique, uniqueIndex, uuid
} from "drizzle-orm/pg-core";

const tstzrange = customType<{ data: string }>({ dataType: () => "tstzrange" });

export const availabilitySchema = pgSchema("availability");
export const availabilityBusinessSchema = pgSchema("business");
export const availabilityTeamSchema = pgSchema("team");

export const allocationStatus = availabilitySchema.enum("allocation_status", ["ACTIVE", "RELEASED"]);
export const allocationSource = availabilitySchema.enum("allocation_source", ["RESERVATION", "OPERATIONAL_BLOCK", "COURSE_SESSION"]);
export const commitmentConflictStatus = availabilitySchema.enum("conflict_status", ["OPEN", "RESOLVED"]);
export const effectiveUnavailabilitySource = availabilityTeamSchema.enum("effective_unavailability_source", ["APPLIED_ABSENCE", "OPERATIONAL_BLOCK"]);

export const businessHoursConfigs = availabilityBusinessSchema.table("business_hours_configs", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, table => [unique("business_hours_configs_business_id_key").on(table.businessId), unique("business_hours_configs_business_id_id_key").on(table.businessId, table.id)]);

export const businessHoursIntervals = availabilityBusinessSchema.table("business_hours_intervals", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), configId: uuid("config_id").notNull(),
  weekday: integer("weekday").notNull(), startMinute: integer("start_minute").notNull(), endMinute: integer("end_minute").notNull()
}, table => [
  foreignKey({ columns: [table.businessId, table.configId], foreignColumns: [businessHoursConfigs.businessId, businessHoursConfigs.id] }).onDelete("cascade"),
  check("business_hours_interval_order", sql`${table.startMinute} < ${table.endMinute}`),
  index("business_hours_intervals_lookup").on(table.businessId, table.configId, table.weekday, table.startMinute)
]);

export const businessDateExceptions = availabilityBusinessSchema.table("business_date_exceptions", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), localDate: date("local_date").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(), reason: text("reason"), createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, table => [unique("business_date_exceptions_business_date_key").on(table.businessId, table.localDate), unique("business_date_exceptions_business_id_id_key").on(table.businessId, table.id)]);

export const businessDateExceptionIntervals = availabilityBusinessSchema.table("business_date_exception_intervals", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), exceptionId: uuid("exception_id").notNull(),
  startMinute: integer("start_minute").notNull(), endMinute: integer("end_minute").notNull()
}, table => [foreignKey({ columns: [table.businessId, table.exceptionId], foreignColumns: [businessDateExceptions.businessId, businessDateExceptions.id] }).onDelete("cascade")]);

export const bookingPolicyVersions = availabilityBusinessSchema.table("booking_policy_versions", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), versionNumber: bigint("version_number", { mode: "number" }).notNull(),
  publicBookingEnabled: boolean("public_booking_enabled").notNull(), horizonCalendarDates: integer("horizon_calendar_dates").notNull(),
  minLeadMinutes: integer("min_lead_minutes").notNull(), startStepMinutes: integer("start_step_minutes").notNull(),
  cancelCutoffMinutes: integer("cancel_cutoff_minutes").notNull(), rescheduleCutoffMinutes: integer("reschedule_cutoff_minutes").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(), createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, table => [unique("booking_policy_versions_business_version_key").on(table.businessId, table.versionNumber), unique("booking_policy_versions_business_id_id_key").on(table.businessId, table.id)]);

export const bookingPolicyStates = availabilityBusinessSchema.table("booking_policy_states", {
  businessId: uuid("business_id").primaryKey(), currentVersionId: uuid("current_version_id").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, table => [foreignKey({ columns: [table.businessId, table.currentVersionId], foreignColumns: [bookingPolicyVersions.businessId, bookingPolicyVersions.id] })]);

export const staffDateExceptions = availabilityTeamSchema.table("staff_date_exceptions", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), staffMemberId: uuid("staff_member_id").notNull(),
  localDate: date("local_date").notNull(), revision: bigint("revision", { mode: "number" }).notNull(), reason: text("reason"),
  createdBy: uuid("created_by"), createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, table => [unique("staff_date_exceptions_business_staff_date_key").on(table.businessId, table.staffMemberId, table.localDate), unique("staff_date_exceptions_business_id_id_key").on(table.businessId, table.id)]);

export const staffDateExceptionIntervals = availabilityTeamSchema.table("staff_date_exception_intervals", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), exceptionId: uuid("exception_id").notNull(),
  startMinute: integer("start_minute").notNull(), endMinute: integer("end_minute").notNull()
}, table => [foreignKey({ columns: [table.businessId, table.exceptionId], foreignColumns: [staffDateExceptions.businessId, staffDateExceptions.id] }).onDelete("cascade")]);

export const staffEffectiveUnavailability = availabilityTeamSchema.table("staff_effective_unavailability", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), staffMemberId: uuid("staff_member_id").notNull(),
  sourceType: effectiveUnavailabilitySource("source_type").notNull(), sourceId: uuid("source_id").notNull(), localDate: date("local_date").notNull(),
  startMinute: integer("start_minute").notNull(), endMinute: integer("end_minute").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(), releasedAt: timestamp("released_at", { withTimezone: true })
}, table => [
  // H03.U06 · WP-03 · sincronía Drizzle <-> SQL (ELEPHANT-020):
  // la unique compuesta del SQL es (business_id, source_type, source_id,
  // local_date, start_minute, end_minute) y el id es único por Business.
  unique("staff_effective_unavailabilit_business_id_source_type_sourc_key").on(table.businessId, table.sourceType, table.sourceId, table.localDate, table.startMinute, table.endMinute),
  unique("staff_effective_unavailability_business_id_id_key").on(table.businessId, table.id),
  check("staff_effective_unavailability_check", sql`${table.startMinute} < ${table.endMinute}`),
  check("staff_effective_unavailability_start_minute_check", sql`${table.startMinute} >= 0 and ${table.startMinute} <= 1439`),
  check("staff_effective_unavailability_end_minute_check", sql`${table.endMinute} >= 1 and ${table.endMinute} <= 1440`),
  index("staff_effective_unavailability_lookup").on(table.businessId, table.staffMemberId, table.localDate)
]);

export const availabilityBusinessGuards = availabilitySchema.table("business_guards", {
  businessId: uuid("business_id").primaryKey(), revision: bigint("revision", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const resourceAllocations = availabilitySchema.table("resource_allocations", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), staffMemberId: uuid("staff_member_id").notNull(),
  sourceType: allocationSource("source_type").notNull(), sourceId: uuid("source_id").notNull(), localDate: date("local_date").notNull(),
  visibleStartAt: timestamp("visible_start_at", { withTimezone: true }).notNull(), visibleEndAt: timestamp("visible_end_at", { withTimezone: true }).notNull(),
  occupiedStartAt: timestamp("occupied_start_at", { withTimezone: true }).notNull(), occupiedEndAt: timestamp("occupied_end_at", { withTimezone: true }).notNull(),
  occupiedRange: tstzrange("occupied_range").notNull(), status: allocationStatus("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), releasedAt: timestamp("released_at", { withTimezone: true }), releaseReason: text("release_reason")
}, table => [
  unique("resource_allocations_business_id_id_key").on(table.businessId, table.id),
  uniqueIndex("one_active_allocation_per_source").on(table.businessId, table.sourceType, table.sourceId).where(sql`${table.status} = 'ACTIVE'`),
  index("resource_allocations_staff_date").on(table.businessId, table.staffMemberId, table.localDate, table.status)
]);

export const allocationServiceRequirements = availabilitySchema.table("allocation_service_requirements", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), allocationId: uuid("allocation_id").notNull(), serviceId: uuid("service_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, table => [unique("allocation_service_requirements_key").on(table.businessId, table.allocationId, table.serviceId)]);

export const commitmentConflicts = availabilitySchema.table("commitment_conflicts", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), allocationId: uuid("allocation_id").notNull(),
  reasonCode: text("reason_code").notNull(), sourceOperationId: uuid("source_operation_id"), detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  status: commitmentConflictStatus("status").notNull(), resolvedAt: timestamp("resolved_at", { withTimezone: true }), resolutionReference: text("resolution_reference")
}, table => [index("commitment_conflicts_open").on(table.businessId, table.status, table.detectedAt)]);
