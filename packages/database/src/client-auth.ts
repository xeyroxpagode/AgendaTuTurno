import { bigint, boolean, check, index, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const clientIam = pgSchema("iam");

export const clientIdentityStates = clientIam.table("client_identity_states", {
  accountId: uuid("account_id").primaryKey(),
  status: text("status").notNull().default("PENDING_MFA"),
  verifiedPhoneE164: text("verified_phone_e164"),
  phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
  mfaRequired: boolean("mfa_required").notNull().default(true),
  mfaEnrolledAt: timestamp("mfa_enrolled_at", { withTimezone: true }),
  recoveryCodesVersion: bigint("recovery_codes_version", { mode: "number" }).notNull().default(0),
  recoveryCodesAcknowledgedAt: timestamp("recovery_codes_acknowledged_at", { withTimezone: true }),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  check("client_identity_status_check", sql`${table.status} in ('PENDING_MFA','RECOVERY_SETUP_REQUIRED','ACTIVE','RECOVERY_REQUIRED','RESTRICTED')`),
  check("client_identity_revision_check", sql`${table.revision} > 0`)
]);

export const clientAccessSessions = clientIam.table("client_access_sessions", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  providerSessionId: text("provider_session_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  securityRevisionAtCreation: bigint("security_revision_at_creation", { mode: "number" }).notNull()
}, (table) => [
  unique("client_access_sessions_account_provider_key").on(table.accountId, table.providerSessionId),
  index("client_access_sessions_account_idx").on(table.accountId, table.lastSeenAt)
]);

export const clientRecoveryCodes = clientIam.table("client_recovery_codes", {
  id: uuid("id").primaryKey(), accountId: uuid("account_id").notNull(),
  codeHash: text("code_hash").notNull(), salt: text("salt").notNull(),
  batchVersion: bigint("batch_version", { mode: "number" }).notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true })
}, (table) => [index("client_recovery_codes_account_batch_idx").on(table.accountId, table.batchVersion)]);

export const clientRecoveryOperations = clientIam.table("client_recovery_operations", {
  id: uuid("id").primaryKey(), accountId: uuid("account_id").notNull(),
  providerSessionId: text("provider_session_id").notNull(), status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }), safeResultCode: text("safe_result_code"),
  auditReference: uuid("audit_reference")
});

export const clientSecurityEvents = clientIam.table("client_security_events", {
  id: uuid("id").primaryKey(), accountId: uuid("account_id"), authUserId: uuid("auth_user_id"),
  eventType: text("event_type").notNull(), outcome: text("outcome").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  operationReference: uuid("operation_reference"), metadata: jsonb("metadata").notNull().default({})
}, (table) => [index("client_security_events_account_idx").on(table.accountId, table.occurredAt)]);

export const clientOperations = clientIam.table("client_operations", {
  operationId: uuid("operation_id").primaryKey(), authUserId: uuid("auth_user_id").notNull(),
  accountId: uuid("account_id"), providerSessionId: text("provider_session_id"),
  commandName: text("command_name").notNull(), requestFingerprint: text("request_fingerprint").notNull(),
  status: text("status").notNull(), responseStatus: bigint("response_status", { mode: "number" }),
  safeResponse: jsonb("safe_response"), errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true })
});

export const clientPhoneChangeStates = clientIam.table("client_phone_change_states", {
  accountId: uuid("account_id").primaryKey(),
  expectedIdentityRevision: bigint("expected_identity_revision", { mode: "number" }).notNull(),
  requestedPhoneHash: text("requested_phone_hash").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true })
});
