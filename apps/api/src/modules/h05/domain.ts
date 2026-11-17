import { DomainError, roleCapabilities, grantableCapabilitiesByRole, type Capability, type RoleCode } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";
import { lockInventory } from "../inventory/domain.js";

/**
 * H05 · primitivas compartidas por los dominios financieros.
 *
 * Aquí viven las piezas que TODO el núcleo financiero necesita y que deben
 * comportarse IGUAL en ventas, dinero, caja, obligaciones, checkout y
 * correcciones. Duplicarlas sería el camino corto a saldos divergentes.
 *
 * Reglas transversales:
 *  · el `business_id` del Actor es la única fuente de scoping;
 *  · el saldo de una venta o de una obligación es DERIVADO de los hechos de
 *    dinero, nunca un saldo canónico editable;
 *  · todo importe se maneja en unidades menores enteras (ARS);
 *  · el bloqueo de negocio es el MISMO que usa Inventario (`hashtextextended
 *    (business_id, 404)`), de modo que exista un único orden de locks y no
 *    pueda aparecer un deadlock entre caja, dinero e inventario.
 */

/** Exige una capability efectiva. Deny-by-default. */
export function requireCapability(actor: Actor, capability: Capability): void {
  if (!actor.capabilities.has(capability)) {
    throw new DomainError("FORBIDDEN", `Missing capability: ${capability}`, 403);
  }
}

export function missing(resource: string): DomainError {
  return new DomainError("NOT_FOUND", `No encontramos ${resource} en este negocio`, 404);
}

export function conflict(message: string): DomainError {
  return new DomainError("CONFLICT", message, 409);
}

/** Optimistic concurrency. El mensaje es el mismo que usa Inventario. */
export function checkRevision(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new DomainError("STALE_REVISION", "El registro cambió. Revisá los valores actuales antes de confirmar.", 409, { currentVersion: actual });
  }
}

/**
 * Bloqueo de negocio. Comparte la clave con `inventory.lockInventory` para
 * que exista un ORDEN ÚNICO de locks en todo el sistema.
 */
export async function lockBusiness(tx: Tx, businessId: string): Promise<void> {
  await lockInventory(tx, businessId);
}

/* ─────────────────────────── dinero: aritmética exacta ─────────────────── */

/** Suma entera exacta. Nunca usa punto flotante. */
export function sumMinor(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Una venta está SETTLED si el dinero confirmado la cubre por completo. */
export function deriveSaleBalance(targetMinor: number, settledMinor: number): "PENDING" | "PARTIAL" | "SETTLED" {
  if (settledMinor <= 0) return "PENDING";
  if (settledMinor >= targetMinor) return "SETTLED";
  return "PARTIAL";
}

/**
 * Saldo de una obligación.
 * `amountMinor === null` ⇒ saldo DESCONOCIDO (nunca cero, nunca saldada).
 */
export function deriveObligationBalance(amountMinor: number | null, settledMinor: number): { status: "OPEN" | "PARTIAL" | "SETTLED"; balanceMinor: number | null } {
  if (amountMinor === null) return { status: settledMinor > 0 ? "PARTIAL" : "OPEN", balanceMinor: null };
  if (settledMinor <= 0) return { status: "OPEN", balanceMinor: amountMinor };
  if (settledMinor >= amountMinor) return { status: "SETTLED", balanceMinor: 0 };
  return { status: "PARTIAL", balanceMinor: amountMinor - settledMinor };
}

/* ─────────────────────────── dinero: helpers de base ───────────────────── */

/** Rango seguro para importes en unidades menores (D11/D27). */
export function assertMinorRange(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError("VALIDATION_ERROR", `${label} debe ser un entero exacto en unidades menores`, 400);
  }
  if (value < 0 || value > 1_000_000_000) {
    throw new DomainError("VALIDATION_ERROR", `${label} fuera de rango`, 400);
  }
}

/**
 * Verifica que un Actor sigue siendo una autoridad vigente DENTRO de la
 * transacción (F34: revocación de IAM antes del commit).
 *
 * No basta con la capability que el Actor traía al abrir el request: se
 * revalida contra PostgreSQL que la sesión sigue activa, que el
 * `role_assignment` sigue vigente y que la capability sigue en el conjunto
 * efectivo del rol.
 */
export async function assertActorStillAuthorized(tx: Tx, actor: Actor, capability: Capability): Promise<void> {
  // Un Actor sintético (fixture de prueba sin sesión real) no tiene sesión
  // que revalidar: la autoridad se resolvió en memoria al construirlo.
  if (!actor.accessSessionId && !actor.roleAssignmentId) return;
  const [session] = await tx`
    select s.id, s.revoked_at "revokedAt", s.expires_at "expiresAt", s.active_role_assignment_id "activeRoleAssignmentId"
      from iam.access_sessions s
     where s.id = ${actor.accessSessionId}
       and s.business_id = ${actor.businessId}
       and s.account_id = ${actor.accountId}
     for share`;
  if (!session) throw new DomainError("SESSION_REVOKED", "La sesión operativa ya no existe", 401);
  if (session.revokedAt) throw new DomainError("SESSION_REVOKED", "La sesión operativa fue revocada", 401);
  if (new Date(session.expiresAt as Date).getTime() <= Date.now()) {
    throw new DomainError("SESSION_REVOKED", "La sesión operativa expiró", 401);
  }
  const [assignment] = await tx`
    select id, role::text role, revoked_at "revokedAt"
      from iam.role_assignments
     where id = ${actor.roleAssignmentId}
       and business_id = ${actor.businessId}
       and staff_member_id = ${actor.staffMemberId}
     for share`;
  if (!assignment) throw new DomainError("FORBIDDEN", "La responsabilidad asignada ya no existe", 403);
  if (assignment.revokedAt) throw new DomainError("FORBIDDEN", "La responsabilidad asignada fue revocada", 403);
  if (assignment.id !== session.activeRoleAssignmentId) {
    throw new DomainError("FORBIDDEN", "El contexto de rol activo cambió durante la operación", 403);
  }
  const role = assignment.role as RoleCode;
  const baseline = roleCapabilities[role] ?? [];
  const grantable = grantableCapabilitiesByRole[role] ?? [];
  if (!baseline.includes(capability) && !grantable.includes(capability)) {
    throw new DomainError("FORBIDDEN", `Missing capability: ${capability}`, 403);
  }
  const grants = await tx`
    select capability from iam.capability_grants
     where role_assignment_id = ${actor.roleAssignmentId}
       and capability = ${capability}
       and revoked_at is null
       and valid_from <= now()
       and (expires_at is null or expires_at > now())`;
  if (!baseline.includes(capability) && !grants.length) {
    throw new DomainError("FORBIDDEN", `Missing capability: ${capability}`, 403);
  }
}
