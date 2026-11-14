import { sql } from "drizzle-orm";
import {
  bigint, check, date, foreignKey, integer,
  jsonb, pgSchema, text, timestamp, unique, uniqueIndex, uuid
} from "drizzle-orm/pg-core";
import { businesses, staffMembers, operationAttempts } from "./base.js";
import { bookingPolicyVersions, resourceAllocations } from "./availability.js";
import { clientProfiles } from "./clients.js";
import { services, serviceTermsVersions } from "./catalog.js";

export const bookingSchema = pgSchema("booking");

export const reservationStatuses = ["CONFIRMED", "CANCELLED", "NO_SHOW"] as const;
export const ownerTypes = ["CLIENT", "GUEST"] as const;
export const guestCredentialStatuses = ["ACTIVE", "REVOKED"] as const;
export const recoveryCaseStatuses = ["REQUESTED", "VERIFIED", "COMPLETED", "REJECTED"] as const;

export const reservations = bookingSchema.table("reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  status: text("status").notNull(),
  ownerType: text("owner_type").notNull(),
  ownerAccountId: uuid("owner_account_id"),
  clientProfileId: uuid("client_profile_id"),
  contactSnapshot: jsonb("contact_snapshot").notNull(),
  staffMemberId: uuid("staff_member_id").notNull(),
  policyVersionId: uuid("policy_version_id").notNull(),
  policySnapshot: jsonb("policy_snapshot").notNull(),
  commercialTotalMinor: bigint("commercial_total_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  currentAllocationId: uuid("current_allocation_id"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  occupiedStartsAt: timestamp("occupied_starts_at", { withTimezone: true }).notNull(),
  occupiedEndsAt: timestamp("occupied_ends_at", { withTimezone: true }).notNull(),
  businessLocalDate: date("business_local_date").notNull(),
  businessTimezoneSnapshot: text("business_timezone_snapshot").notNull(),
  createdOperationId: uuid("created_operation_id").notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  /** H03.U05 · marca temporal del no-show explícito (sólo cuando status = NO_SHOW). */
  noShowAt: timestamp("no_show_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("revision_positive", sql`${table.revision} >= 1`),
  check("commercial_total_minor_non_negative", sql`${table.commercialTotalMinor} >= 0`),
  check("ends_after_starts", sql`${table.endsAt} > ${table.startsAt}`),
  check("occupied_starts_before_starts", sql`${table.occupiedStartsAt} <= ${table.startsAt}`),
  check("ends_before_or_equal_occupied_ends", sql`${table.endsAt} <= ${table.occupiedEndsAt}`),
  check("occupied_starts_before_occupied_ends", sql`${table.occupiedStartsAt} < ${table.occupiedEndsAt}`),
  check("owner_account_consistency", sql`(${table.ownerType} = 'CLIENT' and ${table.ownerAccountId} is not null) or (${table.ownerType} = 'GUEST' and ${table.ownerAccountId} is null)`),
  check("owner_type_check", sql`${table.ownerType} in ('CLIENT','GUEST')`),
  // H03.U06 · WP-03 · sincronía Drizzle <-> SQL U05.
  // El dominio de status congelado (U04/U05) es EXACTAMENTE
  // CONFIRMED | CANCELLED | NO_SHOW. `NO_SHOW_CONFIRMED` es el nombre del
  // EVENTO de historial, nunca un valor de `reservations.status`.
  check("booking_reservations_status_check", sql`${table.status} in ('CONFIRMED','CANCELLED','NO_SHOW')`),
  check("status_cancelled_consistency", sql`(${table.status} = 'CONFIRMED' and ${table.cancelledAt} is null) or (${table.status} = 'CANCELLED' and ${table.cancelledAt} is not null) or (${table.status} = 'NO_SHOW' and ${table.cancelledAt} is null)`),
  check("no_show_at_consistency", sql`(${table.status} = 'NO_SHOW' and ${table.noShowAt} is not null) or (${table.status} <> 'NO_SHOW' and ${table.noShowAt} is null)`),
  unique("reservations_business_id_id_key").on(table.businessId, table.id),
  foreignKey({ columns: [table.businessId], foreignColumns: [businesses.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.staffMemberId], foreignColumns: [staffMembers.businessId, staffMembers.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.policyVersionId], foreignColumns: [bookingPolicyVersions.businessId, bookingPolicyVersions.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.clientProfileId], foreignColumns: [clientProfiles.businessId, clientProfiles.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.currentAllocationId], foreignColumns: [resourceAllocations.businessId, resourceAllocations.id] }).onDelete("restrict"),
]);

export const reservationItems = bookingSchema.table("reservation_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  reservationId: uuid("reservation_id").notNull(),
  position: integer("position").notNull(),
  serviceId: uuid("service_id").notNull(),
  serviceNameSnapshot: text("service_name_snapshot").notNull(),
  termsVersionId: uuid("terms_version_id").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  preBufferMinutes: integer("pre_buffer_minutes").notNull(),
  postBufferMinutes: integer("post_buffer_minutes").notNull(),
  priceMinor: bigint("price_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  conditionsSnapshot: text("conditions_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("position_positive", sql`${table.position} >= 1`),
  check("duration_minutes_positive", sql`${table.durationMinutes} > 0`),
  check("price_minor_non_negative", sql`${table.priceMinor} >= 0`),
  check("currency_ars", sql`${table.currency} = 'ARS'`),
  unique("reservation_items_business_reservation_position_key").on(table.businessId, table.reservationId, table.position),
  unique("reservation_items_business_reservation_service_key").on(table.businessId, table.reservationId, table.serviceId),
  foreignKey({ columns: [table.businessId, table.reservationId], foreignColumns: [reservations.businessId, reservations.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.serviceId], foreignColumns: [services.businessId, services.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.termsVersionId], foreignColumns: [serviceTermsVersions.businessId, serviceTermsVersions.id] }).onDelete("restrict"),
]);

export const reservationEvents = bookingSchema.table("reservation_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  reservationId: uuid("reservation_id").notNull(),
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
  auditReference: text("audit_reference"),
}, table => [
  check("sequence_positive", sql`${table.sequence} >= 1`),
  unique("reservation_events_business_reservation_sequence_key").on(table.businessId, table.reservationId, table.sequence),
  foreignKey({ columns: [table.businessId, table.reservationId], foreignColumns: [reservations.businessId, reservations.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.operationId], foreignColumns: [operationAttempts.businessId, operationAttempts.operationId] }).onDelete("restrict"),
]);

export const guestCredentials = bookingSchema.table("guest_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  reservationId: uuid("reservation_id").notNull(),
  tokenDigest: text("token_digest").notNull(),
  generation: integer("generation").notNull().default(1),
  status: text("status").notNull().default('ACTIVE'),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, table => [
  check("status_active_or_revoked", sql`(${table.status} = 'ACTIVE' and ${table.revokedAt} is null) or (${table.status} = 'REVOKED' and ${table.revokedAt} is not null)`),
  unique("guest_credentials_token_digest_key").on(table.tokenDigest),
  unique("guest_credentials_business_reservation_generation_key").on(table.businessId, table.reservationId, table.generation),
  uniqueIndex("guest_credentials_one_active_per_reservation").on(table.businessId, table.reservationId).where(sql`${table.status} = 'ACTIVE'`),
  foreignKey({ columns: [table.businessId, table.reservationId], foreignColumns: [reservations.businessId, reservations.id] }).onDelete("restrict"),
]);

export const guestDeliveryEnvelopes = bookingSchema.table("guest_delivery_envelopes", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  operationId: uuid("operation_id").notNull(),
  reservationId: uuid("reservation_id").notNull(),
  intentProofDigest: text("intent_proof_digest").notNull(),
  encryptedPayload: text("encrypted_payload").notNull(),
  keyVersion: text("key_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, table => [
  unique("guest_delivery_envelopes_business_operation_key").on(table.businessId, table.operationId),
  foreignKey({ columns: [table.businessId, table.reservationId], foreignColumns: [reservations.businessId, reservations.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.operationId], foreignColumns: [operationAttempts.businessId, operationAttempts.operationId] }).onDelete("restrict"),
]);

export const guestRecoveryCases = bookingSchema.table("guest_recovery_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  reservationId: uuid("reservation_id").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  requestedByStaffId: uuid("requested_by_staff_id").notNull(),
  verificationMethod: text("verification_method").notNull(),
  evidenceReference: text("evidence_reference").notNull(),
  verifiedByStaffId: uuid("verified_by_staff_id"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  reason: text("reason").notNull(),
  status: text("status").notNull().default('REQUESTED'),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  auditReference: text("audit_reference"),
}, table => [
  check("recovery_case_status_valid", sql`${table.status} in ('REQUESTED','VERIFIED','COMPLETED','REJECTED')`),
  check("completed_case_has_timestamps", sql`(${table.status} = 'COMPLETED' and ${table.completedAt} is not null) or ${table.status} <> 'COMPLETED'`),
  check("verified_case_has_verifier", sql`(${table.status} in ('VERIFIED','COMPLETED') and ${table.verifiedByStaffId} is not null and ${table.verifiedAt} is not null) or ${table.status} in ('REQUESTED','REJECTED')`),
  foreignKey({ columns: [table.businessId, table.reservationId], foreignColumns: [reservations.businessId, reservations.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.requestedByStaffId], foreignColumns: [staffMembers.businessId, staffMembers.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.businessId, table.verifiedByStaffId], foreignColumns: [staffMembers.businessId, staffMembers.id] }).onDelete("restrict"),
]);
