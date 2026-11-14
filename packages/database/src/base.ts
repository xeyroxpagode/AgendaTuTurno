import { bigint, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Tablas base compartidas por el esquema Drizzle.
 *
 * Existen en un módulo propio (y no en `schema.ts`) para que los módulos de
 * dominio —`booking.ts`, `absence.ts`, `attendance.ts`— puedan declarar sus
 * FKs compuestas sin crear un ciclo de importación con `schema.ts`, que a su
 * vez reexporta esos módulos.
 *
 * Las FKs declaradas en `schema.ts` (personas, cuentas, asignaciones de rol,
 * grants, sesiones de acceso) no se declaran aquí porque el modelo Drizzle de
 * H01 las modela por columnas, sin restricción compuesta en el ORM.
 */

export const businessSchema = pgSchema("business");
export const iamSchema = pgSchema("iam");
export const teamSchema = pgSchema("team");
export const systemSchema = pgSchema("system");

export const businesses = businessSchema.table("businesses", {
  id: uuid("id").primaryKey(), provisioningKey: text("provisioning_key").notNull(), displayName: text("display_name").notNull(), timezone: text("timezone").notNull(), status: text("status").notNull(), version: bigint("version", { mode: "number" }).notNull(), authorizationRevision: bigint("authorization_revision", { mode: "number" }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("business_provisioning_key").on(table.provisioningKey)]);

export const staffMembers = teamSchema.table("staff_members", {
  id: uuid("id").primaryKey(), businessId: uuid("business_id").notNull(), personId: uuid("person_id").notNull(), employmentStatus: text("employment_status").notNull(), accessStatus: text("access_status").notNull(), revision: bigint("revision", { mode: "number" }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("staff_members_business_id_id_key").on(table.businessId, table.id)]);

export const operationAttempts = systemSchema.table("operation_attempts", {
  operationId: uuid("operation_id").primaryKey(), businessId: uuid("business_id"), actorAccountId: uuid("actor_account_id"), commandName: text("command_name").notNull(), requestHash: text("request_hash").notNull(), status: text("status").notNull(), responseStatus: bigint("response_status", { mode: "number" }), responseBody: jsonb("response_body"), errorCode: text("error_code"), createdAt: timestamp("created_at", { withTimezone: true }).notNull(), completedAt: timestamp("completed_at", { withTimezone: true }).notNull()
});
