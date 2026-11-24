import { bigint, index, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** H08 · M8 · Espejo Drizzle de `econ.*`. Importes en unidades menores (bigint). */
export const econSchema = pgSchema("econ");

export const agreements = econSchema.table("agreements", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  staffMemberId: uuid("staff_member_id").notNull(),
  status: text("status").notNull(),
  createdByAccountId: uuid("created_by_account_id").notNull(),
  operationId: uuid("operation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, (table) => [index("agreements_lookup").on(table.businessId, table.staffMemberId)]);

export const agreementVersions = econSchema.table("agreement_versions", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  agreementId: uuid("agreement_id").notNull(),
  version: bigint("version", { mode: "number" }).notNull(),
  modality: text("modality").notNull(),
  commissionBase: text("commission_base"),
  bps: bigint("bps", { mode: "number" }),
  fixedAmountMinor: bigint("fixed_amount_minor", { mode: "number" }),
  rentAmountMinor: bigint("rent_amount_minor", { mode: "number" }),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  validTo: timestamp("valid_to", { withTimezone: true }).notNull(),
  termsHash: text("terms_hash").notNull(),
  status: text("status").notNull(),
  createdByAccountId: uuid("created_by_account_id").notNull(),
  operationId: uuid("operation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, (table) => [index("agreement_versions_effective_lookup").on(table.businessId, table.agreementId, table.validFrom, table.validTo)]);

export const estimates = econSchema.table("estimates", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  staffMemberId: uuid("staff_member_id").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  agreementVersionId: uuid("agreement_version_id"),
  termsHash: text("terms_hash"),
  sourceFingerprint: text("source_fingerprint").notNull(),
  totalPayableMinor: bigint("total_payable_minor", { mode: "number" }).notNull(),
  totalReceivableMinor: bigint("total_receivable_minor", { mode: "number" }).notNull(),
  lines: jsonb("lines").notNull(),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const settlements = econSchema.table("settlements", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  staffMemberId: uuid("staff_member_id").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  currency: text("currency").notNull(),
  agreementVersionId: uuid("agreement_version_id"),
  termsHash: text("terms_hash").notNull(),
  sourceFingerprint: text("source_fingerprint").notNull(),
  totalPayableMinor: bigint("total_payable_minor", { mode: "number" }).notNull(),
  totalReceivableMinor: bigint("total_receivable_minor", { mode: "number" }).notNull(),
  snapshot: jsonb("snapshot").notNull(),
  payableObligationId: uuid("payable_obligation_id"),
  receivableObligationId: uuid("receivable_obligation_id"),
  closedByAccountId: uuid("closed_by_account_id").notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
  operationId: uuid("operation_id")
}, (table) => [index("settlements_lookup").on(table.businessId, table.staffMemberId, table.periodStart)]);

export const settlementSources = econSchema.table("settlement_sources", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  settlementId: uuid("settlement_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: uuid("source_id").notNull(),
  component: text("component").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull()
});

export const settlementAdjustments = econSchema.table("settlement_adjustments", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  settlementId: uuid("settlement_id").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  sourceType: text("source_type"),
  sourceId: uuid("source_id"),
  createdByAccountId: uuid("created_by_account_id").notNull(),
  operationId: uuid("operation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});
