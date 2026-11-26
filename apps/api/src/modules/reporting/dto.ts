/**
 * H09 · Utilidades de DTO y de lectura transaccional.
 *
 * Reporting NO crea esquema, tablas, vistas materializadas ni cachés. Cada
 * endpoint abre UNA transacción de sólo lectura, revalida autoridad dentro de
 * ella y proyecta exclusivamente fuentes propietarias. El `to` local ya es
 * exclusivo: se convierte una sola vez a instante y NUNCA se le suma un día
 * ni se le resta un milisegundo.
 */
import { DomainError, type Capability } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { authorizationService } from "../iam/authorization.js";
import { revalidateAuthority, type Tx } from "../system/operations.js";
import { database } from "../../lib/runtime.js";
import { addLocalDays, businessLocalDate, localDateTimeToInstant } from "../availability/temporal.js";
import type { Block, BlockCompleteness, ReadState, ReportingInterval } from "@youngkingz/contracts";

export interface ReportingContext {
  timezone: string;
  /** Fecha local del negocio en el momento de la lectura. */
  today: string;
  /** Instante ISO de la lectura (asOf / generatedAt). */
  asOf: string;
}

export interface TimeInterval {
  fromLocalDate: string;
  toLocalDate: string;
  fromInstant: Date;
  toInstant: Date;
  /** Instantes ISO ya convertidos; se enlazan con `::timestamptz` en la query. */
  from: string;
  to: string;
  interval: ReportingInterval;
}

export interface CapabilityRequirement {
  capability: Capability;
  scope?: { staffMemberId?: string };
}

/** Rechaza scopes conflictivos antes de cualquier consulta (deny-by-default). */
export function assertCapability(actor: Actor, capability: Capability, scope?: { staffMemberId?: string }): void {
  const granted = actor.grantScopes.get(capability);
  if (granted && typeof granted === "object" && (granted as { staffMemberId?: string }).staffMemberId === "__CONFLICT__") {
    throw new DomainError("FORBIDDEN", `Capability ${capability} has conflicting grants`, 403);
  }
  authorizationService.require(actor, capability, scope);
}

export function requireRole(actor: Actor, allowed: readonly Actor["role"][]): void {
  if (!allowed.includes(actor.role)) throw new DomainError("FORBIDDEN", "Insufficient role for this reporting block", 403);
}

/**
 * Scope profesional efectivo. BARBER queda forzado a su propia identidad;
 * intentar consultar otro profesional es 403 (no un conjunto vacío ambiguo).
 */
export function resolveStaffScope(actor: Actor, requested?: string): { staffMemberId?: string } {
  if (actor.role === "BARBER") {
    if (requested && requested !== actor.staffMemberId) throw new DomainError("FORBIDDEN", "Cannot read another professional's data", 403);
    return { staffMemberId: actor.staffMemberId };
  }
  return requested ? { staffMemberId: requested } : {};
}

/**
 * Reintento acotado de la Tx de lectura ante `40001` (serialization_failure).
 *
 * Causa comprobada: cada autenticación actualiza
 * `iam.access_sessions.last_seen_at`; cuando la UI dispara GETs paralelos, ese
 * UPDATE concurrente hace que el `SELECT ... FOR SHARE` de
 * `revalidateAuthority` dentro de REPEATABLE READ falle con 40001. No se
 * debilita la autoridad: cada intento ABRE UNA Tx NUEVA y vuelve a ejecutar
 * `revalidateAuthority`, por lo que una revocación confirmada entre intentos
 * se observa y se traduce en 403/401. Tampoco se cambia el aislamiento: se
 * conserva REPEATABLE READ para que todas las proyecciones de un intento vean
 * el mismo snapshot. Backoff determinista (5 ms, 10 ms), sin azar.
 */
const REPORTING_READ_ATTEMPTS = 3;
function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "40001";
}

export async function reportingRead<T>(
  actor: Actor,
  requirements: readonly CapabilityRequirement[],
  handler: (tx: Tx, context: ReportingContext) => Promise<T>
): Promise<T> {
  // `require()` se ejecuta fuera y dentro: la revalidación usa `.some()` y no
  // replica el deny-by-default `__CONFLICT__` de `authenticate()`.
  for (const requirement of requirements) assertCapability(actor, requirement.capability, requirement.scope);
  for (let attempt = 1; attempt <= REPORTING_READ_ATTEMPTS; attempt += 1) {
    try {
      // `revalidateAuthority` usa SELECT ... FOR SHARE: PostgreSQL lo prohíbe en
      // transacciones con modo SQL READ ONLY. La Tx es de SÓLO LECTURA en el
      // sentido contractual (ningún INSERT/UPDATE/DELETE/AUDIT), con aislamiento
      // REPEATABLE READ para que todas las proyecciones vean el mismo snapshot.
      const result = await database.client.begin("isolation level repeatable read", async (tx) => {
        for (const requirement of requirements) await revalidateAuthority(tx, actor, requirement.capability, requirement.scope);
        const rows = await tx`select timezone::text timezone from business.businesses where id=${actor.businessId} and status='ACTIVE'`;
        if (!rows.length) throw new DomainError("FORBIDDEN", "Business is not active", 403);
        const timezone = String(rows[0]!.timezone);
        const now = new Date();
        return handler(tx, { timezone, today: businessLocalDate(now, timezone), asOf: now.toISOString() });
      });
      return result as unknown as T;
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === REPORTING_READ_ATTEMPTS) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 5));
    }
  }
  throw new Error("Reporting read retries exhausted");
}

/** Parsea `[from,to)` local y convierte cada límite una sola vez a instante. */
export function resolveInterval(context: ReportingContext, from?: string, to?: string, date?: string): TimeInterval {
  const fromLocalDate = from ?? date ?? context.today;
  const toLocalDate = to ?? (date ? addLocalDays(date, 1) : addLocalDays(fromLocalDate, 1));
  if (toLocalDate <= fromLocalDate) throw new DomainError("VALIDATION_ERROR", "`to` must be later than `from`", 400);
  const fromInstant = localDateTimeToInstant(fromLocalDate, 0, context.timezone);
  const toInstant = localDateTimeToInstant(toLocalDate, 0, context.timezone);
  const interval: ReportingInterval = { from: fromInstant.toISOString(), to: toInstant.toISOString(), timezone: context.timezone };
  return {
    fromLocalDate,
    toLocalDate,
    fromInstant,
    toInstant,
    from: interval.from,
    to: interval.to,
    interval
  };
}

export function makeBlock<T>(
  state: ReadState,
  data: T | null,
  completeness: BlockCompleteness,
  asOf: string | null,
  interval?: ReportingInterval,
  error?: Block<unknown>["error"]
): Block<T> {
  const block: Block<T> = { state, data, completeness, asOf };
  if (interval) block.interval = interval;
  if (error) block.error = error;
  return block;
}

export function deniedBlock<T>(asOf: string | null, interval?: ReportingInterval): Block<T> {
  return makeBlock<T>("DENIED", null, "UNKNOWN", asOf, interval);
}

export function notConfiguredBlock<T>(asOf: string | null, interval?: ReportingInterval): Block<T> {
  return makeBlock<T>("NOT_CONFIGURED", null, "NOT_CONFIGURED", asOf, interval);
}

export function countState(count: number): ReadState { return count > 0 ? "SUCCESS" : "ZERO"; }

/* ── Cursores opacos ────────────────────────────────────────────────────── */

export interface HistoryCursor {
  occurredAt: string;
  objectId: string;
  sequence: number | null;
  eventId: string;
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeHistoryCursor(raw: string): HistoryCursor {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { throw new DomainError("VALIDATION_ERROR", "Invalid history cursor", 400); }
  if (!value || typeof value !== "object") throw new DomainError("VALIDATION_ERROR", "Invalid history cursor", 400);
  const item = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof item.occurredAt !== "string" || Number.isNaN(Date.parse(item.occurredAt)) ||
      typeof item.objectId !== "string" || !uuid.test(item.objectId) ||
      typeof item.eventId !== "string" || item.eventId.length === 0 || item.eventId.length > 300 ||
      [...item.eventId].some((character) => character.charCodeAt(0) < 32) ||
      (item.sequence !== null && (!Number.isInteger(item.sequence) || Number(item.sequence) < 0))) {
    throw new DomainError("VALIDATION_ERROR", "Invalid history cursor", 400);
  }
  return { occurredAt: new Date(item.occurredAt).toISOString(), objectId: item.objectId, sequence: item.sequence as number | null, eventId: item.eventId };
}

export function encodeOccupancyCursor(startsAt: string, allocationId: string): string {
  return Buffer.from(`${startsAt}|${allocationId}`, "utf8").toString("base64url");
}

export function decodeOccupancyCursor(raw: string): { startsAt: string; allocationId: string } {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator < 1) throw new DomainError("VALIDATION_ERROR", "Invalid course occupancy cursor", 400);
  const startsAt = decoded.slice(0, separator), allocationId = decoded.slice(separator + 1);
  if (Number.isNaN(Date.parse(startsAt)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(allocationId)) {
    throw new DomainError("VALIDATION_ERROR", "Invalid course occupancy cursor", 400);
  }
  return { startsAt: new Date(startsAt).toISOString(), allocationId };
}
