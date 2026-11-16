import { DomainError, type Capability } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";

export function requireInventory(actor: Actor, capability: Capability) {
  if (!actor.capabilities.has(capability)) throw new DomainError("FORBIDDEN", "No tenés permiso para esta operación de inventario", 403);
}
export const missing = () => new DomainError("NOT_FOUND", "No encontramos ese registro en este negocio", 404);
export const conflict = (message: string) => new DomainError("CONFLICT", message, 409);
export function checkVersion(actual: number, expected: number) {
  if (actual !== expected) throw new DomainError("STALE_REVISION", "El stock cambió. Revisá los valores actuales antes de confirmar.", 409, { currentVersion: actual });
}
// One business lock provides a deterministic order for multi-SKU receipts,
// inverse transfers, lifecycle, counts and future multi-line H06 transactions.
export async function lockInventory(tx: Tx, businessId: string) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${businessId},404))`;
}
export async function location(tx: Tx, actor: Actor, id: string, write = true) {
  const [row] = await tx`select * from inventory.locations where business_id=${actor.businessId} and id=${id}`;
  if (!row) throw missing();
  if (write && !row.active) throw conflict("La ubicación está desactivada");
  if (actor.role === "BARBER" && row.staff_member_id && row.staff_member_id !== actor.staffMemberId) {
    const allowed = await tx`select 1 from inventory.location_access where business_id=${actor.businessId} and location_id=${id} and staff_member_id=${actor.staffMemberId}`;
    if (!allowed.length) throw new DomainError("FORBIDDEN", "No tenés acceso a esas existencias atribuidas", 403);
  }
  return row;
}
export async function item(tx: Tx, actor: Actor, sku: string, write = true) {
  const [row] = await tx`select * from inventory.items where business_id=${actor.businessId} and sku=${sku}`;
  if (!row) throw missing();
  if (write && !row.active) throw conflict("El artículo está desactivado");
  if (actor.role === "BARBER" && row.use === "SALE") throw new DomainError("FORBIDDEN", "Este artículo no es un insumo de uso interno", 403);
  return row;
}
export async function professional(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx`select id from team.staff_members where business_id=${actor.businessId} and id=${id} and employment_status='ACTIVE'`;
  if (!row) throw missing();
}
