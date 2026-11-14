import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";
import { reservations } from "./booking.js";
import { staffEffectiveUnavailability } from "./availability.js";

export function createDatabase(connectionString: string) {
  const client = postgres(connectionString, { max: 10, prepare: false });
  return { db: drizzle(client, { schema }), client };
}

export type Database = ReturnType<typeof createDatabase>["db"];
export { schema };
export * from "./client-auth.js";
export * from "./availability.js";
export * from "./booking.js";
export * from "./absence.js";
export * from "./attendance.js";

/**
 * Texto plano de una expresión SQL de Drizzle.
 * `SQL.queryChunks` mezcla literales y columnas; los literales son los que
 * contienen la constraint transcendental (los valores de dominio).
 */
function sqlText(value: { queryChunks: unknown[] }): string {
  return value.queryChunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object") {
        const candidate = chunk as { value?: unknown; name?: unknown };
        if (candidate.value !== undefined) return String(candidate.value);
        if (typeof candidate.name === "string") return candidate.name;
      }
      return "";
    })
    .join("");
}

/**
 * Resumen verificable del esquema Drizzle frente al SQL desplegado.
 *
 * H03.U06 · WP-03 (ELEPHANT-020): el modelo ORM debe reflejar las
 * constraints reales del SQL. Este resumen permite comprobarlo desde las
 * pruebas sin depender de la internals de Drizzle en el paquete de tests.
 */
export function bookingSchemaSummary() {
  const reservationConfig = getTableConfig(reservations);
  const unavailabilityConfig = getTableConfig(staffEffectiveUnavailability);
  return {
    reservationColumns: reservationConfig.columns.map((column) => column.name),
    reservationChecks: reservationConfig.checks.map((check) => ({ name: check.name, sql: sqlText(check.value) })),
    effectiveUnavailabilityUniques: unavailabilityConfig.uniqueConstraints.map((unique) => unique.name),
    effectiveUnavailabilityColumns: unavailabilityConfig.columns.map((column) => column.name)
  };
}
