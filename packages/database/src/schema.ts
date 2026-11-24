import { bigint, boolean, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { iamSchema, systemSchema } from "./base.js";
export * from "./base.js";
export * from "./catalog.js";
export * from "./clients.js";
export * from "./client-auth.js";
export * from "./professionals.js";
export * from "./schedules.js";
export * from "./staff-services.js";
export * from "./availability.js";
export * from "./booking.js";
export * from "./absence.js";
export * from "./attendance.js";
export * from "./inventory.js";
export * from "./courses.js";
export * from "./economy.js";
export * from "./h05.js";

export const clientsSchema = pgSchema("clients");

export const persons = iamSchema.table("persons", { id: uuid("id").primaryKey(), firstName: text("first_name").notNull(), lastName: text("last_name"), phone: text("phone"), createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull() });
export const userAccounts = iamSchema.table("user_accounts", { id: uuid("id").primaryKey(), personId: uuid("person_id").notNull(), authUserId: uuid("auth_user_id"), verifiedEmail: text("verified_email"), status: text("status").notNull(), securityRevision: bigint("security_revision", { mode: "number" }).notNull(), credentialsChangedAt: timestamp("credentials_changed_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull() });
export const roleAssignments = iamSchema.table("role_assignments", { id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), staffMemberId: uuid("staff_member_id").notNull(), role: text("role").notNull(), effectiveAt: timestamp("effective_at", { withTimezone: true }), revokedAt: timestamp("revoked_at", { withTimezone: true }), assignedByAccountId: uuid("assigned_by_account_id"), revokedByAccountId: uuid("revoked_by_account_id"), revision: bigint("revision", { mode: "number" }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull() });
export const capabilityGrants = iamSchema.table("capability_grants", { id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), staffMemberId: uuid("staff_member_id").notNull(), roleAssignmentId: uuid("role_assignment_id").notNull(), capability: text("capability").notNull(), scope: jsonb("scope").notNull(), grantedByAccountId: uuid("granted_by_account_id").notNull(), validFrom: timestamp("valid_from", { withTimezone: true }).notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }), revokedAt: timestamp("revoked_at", { withTimezone: true }), revokedByAccountId: uuid("revoked_by_account_id"), createdAt: timestamp("created_at", { withTimezone: true }).notNull() });
export const accessSessions = iamSchema.table("access_sessions", { id: uuid("id").primaryKey(), accountId: uuid("account_id").notNull(), businessId: uuid("business_id").notNull(), staffMemberId: uuid("staff_member_id").notNull(), activeRoleAssignmentId: uuid("active_role_assignment_id"), contextRevision: bigint("context_revision", { mode: "number" }).notNull(), authSessionId: text("auth_session_id"), createdAt: timestamp("created_at", { withTimezone: true }).notNull(), lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), revokedAt: timestamp("revoked_at", { withTimezone: true }), revokedReason: text("revoked_reason") });
export const auditEvents = systemSchema.table("audit_events", { id: uuid("id").primaryKey(), businessId: uuid("business_id"), actorAccountId: uuid("actor_account_id"), operationId: uuid("operation_id"), action: text("action").notNull(), capability: text("capability"), scope: jsonb("scope"), resourceType: text("resource_type").notNull(), resourceId: uuid("resource_id"), outcome: text("outcome").notNull(), changes: jsonb("changes").notNull(), occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull() });

export const accountSecurityStates = iamSchema.table("account_security_states", { accountId: uuid("account_id").primaryKey(), compromisedAt: timestamp("compromised_at", { withTimezone: true }), recoveryRequired: boolean("recovery_required").notNull(), sessionsValidAfter: timestamp("sessions_valid_after", { withTimezone: true }).notNull(), revision: bigint("revision", { mode: "number" }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull() });
