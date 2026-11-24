import { bigint, index, unique, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * H08 · M8 · Espejo Drizzle de H05 (F-23 / N-10).
 * Refleja `202611160001_h05_finances.sql`. ANTES no existía: la economía del
 * personal consume-estas tablas, nunca crea un ledger monetario paralelo.
 * Los importes son bigint (unidades menores de ARS) y se modelan como
 * `bigint` de JS (E-17): `mode: "number"` convertía silentemente a Number y
 * podía perder precisión por encima de 2^53 aunque el SQL crudo use strings.
 */

export const salesSchema = pgSchema("sales");
export const moneySchema = pgSchema("money");
export const obligationsSchema = pgSchema("obligations");

export const sales = salesSchema.table("sales", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  attendanceId: uuid("attendance_id"),
  totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
  currency: text("currency").notNull(),
  operationId: uuid("operation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, (table) => [index("sales_business_status").on(table.businessId, table.status)]);

export const saleLines = salesSchema.table("sale_lines", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  saleId: uuid("sale_id").notNull(),
  kind: text("kind").notNull(),
  serviceId: uuid("service_id"),
  quantity: bigint("quantity", { mode: "bigint" }).notNull(),
  unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
  discountMinor: bigint("discount_minor", { mode: "bigint" }).notNull(),
  lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).notNull(),
  supersededAt: timestamp("superseded_at", { withTimezone: true })
}, (table) => [index("sale_lines_sale").on(table.businessId, table.saleId)]);

export const moneyOperations = moneySchema.table("money_operations", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  saleId: uuid("sale_id"),
  obligationId: uuid("obligation_id"),
  refundOfId: uuid("refund_of_id"),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  confirmedMinor: bigint("confirmed_minor", { mode: "bigint" }),
  receiverStaffMemberId: uuid("receiver_staff_member_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true })
}, (table) => [index("money_operations_lookup").on(table.businessId, table.saleId, table.status)]);

export const moneyAllocations = moneySchema.table("money_allocations", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  moneyOperationId: uuid("money_operation_id").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull()
}, (table) => [index("money_allocations_target").on(table.businessId, table.targetType, table.targetId)]);

export const expenseObligations = obligationsSchema.table("expense_obligations", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  counterpartyName: text("counterparty_name").notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }),
  amountState: text("amount_state").notNull(),
  currency: text("currency").notNull(),
  dueDate: timestamp("due_date"),
  status: text("status").notNull(),
  revision: bigint("revision", { mode: "bigint" }).notNull(),
  note: text("note"),
  settlementId: uuid("settlement_id"),
  operationId: uuid("operation_id").notNull()
}, (table) => [
  index("obligations_lookup").on(table.businessId, table.kind, table.status),
  unique("expense_obligations_operation_kind_key").on(table.operationId, table.kind)
]);

export const obligationPayments = obligationsSchema.table("obligation_payments", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  moneyOperationId: uuid("money_operation_id").notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  kind: text("kind").notNull()
});
