import { randomUUID } from "node:crypto";
import { roleCapabilities, type Capability, type RoleCode } from "@youngkingz/contracts";
import { database } from "../../apps/api/src/lib/runtime.js";
import type { Actor } from "../../apps/api/src/modules/iam/authorization.js";

/**
 * Soporte de pruebas H05 sobre PostgreSQL QA AISLADO.
 *
 * Las identidades se crean directamente en PostgreSQL, igual que la suite
 * de integración de H04. Cada Actor lleva una sesión operativa REAL para que
 * la revalidación dentro de la transacción (F34) tenga algo que verificar.
 */

export async function assertQaDatabase(): Promise<string> {
  const [row] = await database.client`select current_database() name`;
  const name = String(row!.name);
  if (!name.startsWith("youngkingz_h05_")) {
    throw new Error(`Las pruebas H05 requieren una base QA aislada; conectada a '${name}'.`);
  }
  return name;
}

export async function seedBusiness(displayName = "H05 QA"): Promise<string> {
  const [row] = await database.client`
    insert into business.businesses(provisioning_key,display_name,timezone,status)
    values (${randomUUID()},${displayName},'America/Argentina/Buenos_Aires','ACTIVE')
    returning id`;
  return String(row!.id);
}

export type SeedActorOptions = {
  extraCapabilities?: readonly Capability[];
  withoutCapabilities?: readonly Capability[];
};

export async function seedActor(businessId: string, role: RoleCode, name: string, options: SeedActorOptions = {}): Promise<Actor> {
  const [person] = await database.client`insert into iam.persons(first_name) values (${name}) returning id`;
  const [staff] = await database.client`
    insert into team.staff_members(business_id,person_id,employment_status,access_status)
    values (${businessId},${person!.id},'ACTIVE','ACTIVE') returning id`;
  const [account] = await database.client`
    insert into iam.user_accounts(person_id,verified_email,status)
    values (${person!.id},${`${randomUUID()}@h05.test`},'ACTIVE') returning id`;
  const [assignment] = await database.client`
    insert into iam.role_assignments(business_id,staff_member_id,role,effective_at,revoked_at,revision)
    values (${businessId},${staff!.id},${role},now(),null,1) returning id`;
  const [session] = await database.client`
    insert into iam.access_sessions(account_id,business_id,staff_member_id,active_role_assignment_id,auth_session_id,expires_at)
    values (${account!.id},${businessId},${staff!.id},${assignment!.id},${randomUUID()},now() + interval '2 hours')
    returning id, context_revision "contextRevision"`;

  const capabilities = new Set<Capability>([...roleCapabilities[role], ...(options.extraCapabilities ?? [])]);
  for (const capability of options.withoutCapabilities ?? []) capabilities.delete(capability);

  return {
    accountId: String(account!.id),
    personId: String(person!.id),
    staffMemberId: String(staff!.id),
    businessId,
    accessSessionId: String(session!.id),
    roleAssignmentId: String(assignment!.id),
    role,
    contextRevision: Number(session!.contextRevision ?? 1),
    capabilities,
    email: `${name}@h05.test`
  };
}

export function op(): string {
  return randomUUID();
}

export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) throw new Error(`Se esperaba '${code}' pero se obtuvo '${actual ?? String(error)}'.`);
    return;
  }
  throw new Error(`Se esperaba que la operación fallara con '${code}'.`);
}

/** Sesión de caja abierta (la caja ordinaria del negocio). */
export async function openCash(actor: Actor, cashboxName?: string): Promise<{ cashSessionId: string; cashboxId: string }> {
  const { openCashSession } = await import("../../apps/api/src/modules/cash/commands.js");
  const name = cashboxName ?? `Caja QA ${randomUUID().slice(0, 6)}`;
  const result = await openCashSession(actor, { cashboxName: name, openingAmountMinor: 10_000 }, op());
  return { cashSessionId: String(result.data.cashSessionId), cashboxId: String(result.data.cashboxId) };
}

/** Artículo de inventario listo para vender, con existencia física. */
export async function createSellableItem(actor: Actor, rawSku: string, priceMinor: number, quantity: number): Promise<{ sku: string; locationId: string }> {
  const sku = rawSku.toUpperCase();
  const inventoryCommands = await import("../../apps/api/src/modules/inventory/commands.js");
  const location = await inventoryCommands.saveLocation(actor, null, { name: `Ubicación ${sku}` }, op());
  const locationId = String(location.data.id);
  await inventoryCommands.createItem(actor, {
    sku, name: `Artículo ${sku}`, use: "SALE", priceMinor, costMinor: 0
  }, op());
  // OPENING requiere una posición sin historia; se registra una sola vez.
  await inventoryCommands.createMovement(actor, {
    kind: "OPENING",
    lines: [{ sku, locationId, purpose: "SALE", quantity }],
    reason: "Stock inicial de QA",
    effectiveAt: new Date().toISOString()
  }, op());
  return { sku, locationId };
}

/** Attendance terminal desde la que se puede originar una venta. */
export async function createTerminalAttendance(actor: Actor, status: "COMPLETED" | "PARTIAL" | "INTERRUPTED" = "COMPLETED", priceMinor = 12_000) {
  const { registerAttendance } = await import("../../apps/api/src/modules/attendance/commands.js");
  const result = await registerAttendance({
    actor,
    walkIn: true,
    contactSnapshot: { name: "Cliente QA", phone: `1155${randomUUID().replace(/-/g, "").slice(0, 6)}` },
    servicesPerformedSnapshot: [{ name: "Corte QA", durationMinutes: 30, priceMinor, currency: "ARS" }],
    status,
    operationId: op()
  });
  return result.attendanceId;
}

/** Venta DRAFT lista para confirmar en checkout. */
export async function createProductSale(actor: Actor, sku: string, locationId: string, quantity = 1, priceMinor = 8_000) {
  const { createSale } = await import("../../apps/api/src/modules/sales/commands.js");
  const result = await createSale(actor, {
    lines: [{ kind: "PRODUCT", sku, locationId, name: `Venta ${sku}`, quantity, unitPriceMinor: priceMinor, discountMinor: 0 }]
  }, op());
  return String(result.data.saleId);
}

export async function sqlCount(query: string, params: readonly unknown[] = []): Promise<number> {
  const rows = await database.client.unsafe(query, params as never[]);
  return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
}
