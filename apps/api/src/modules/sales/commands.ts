import {
  cancelSaleSchema, confirmSaleSchema, correctSaleSchema, createSaleSchema, DomainError,
  saleTotal, type SaleLineInput
} from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { audit, executeOperation, type Tx } from "../system/operations.js";
import { assertDiscountAuthority, assertProductLines, loadSale, currentLines, resolveSaleLines, saleSnapshot, settledMinor } from "./domain.js";
import { checkRevision, conflict, lockBusiness, requireCapability } from "../h05/domain.js";

/**
 * H05 · CAP-05-01 Sales · comandos.
 *
 * · crear    → DRAFT (o CONFIRMED si la venta trae líneas ya resueltas).
 * · confirmar → snapshot de precios vigente revalidado; DRAFT→CONFIRMED.
 * · anular   → CANCELLED con motivo obligatorio; conserva la venta.
 * · corregir → hecho posterior con before/after; la venta original se
 *              conserva y sus líneas anteriores quedan superseded (nunca se
 *              reescriben).
 */

/** Parámetro INTERNO server-to-server (G01/D16). Nunca se lee del body HTTP. */
export type SaleInternal = { confirmedOrderId?: string };

export async function createSale(actor: Actor, body: unknown, operationId: string, internal?: SaleInternal) {
  requireCapability(actor, "sales.create");
  const input = createSaleSchema.parse(body);
  assertDiscountAuthority(actor, input.lines);

  return executeOperation({
    actor,
    operationId,
    command: "sale.create",
    payload: { ...input, internal: internal ?? null }
  }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const resolved = await resolveSaleLines(tx, actor, input,
      internal?.confirmedOrderId ? { confirmedOrderId: internal.confirmedOrderId } : undefined);
    assertDiscountAuthority(actor, resolved.lines);
    const total = saleTotal(resolved.lines);

    const [sale] = await tx`
      insert into sales.sales(business_id,operation_id,status,source,attendance_id,contact_snapshot,currency,total_minor,note,actor_account_id)
      values (${actor.businessId},${operationId},'DRAFT',${resolved.source},${resolved.attendanceId},
              ${resolved.contactSnapshot === null ? null : JSON.stringify(resolved.contactSnapshot)}::jsonb,
              'ARS',${total},${input.note ?? null},${actor.accountId})
      returning id`;
    if (!sale) throw conflict("No pudimos registrar la venta");
    await insertLines(tx, actor, String(sale.id), 1, resolved.lines);

    await audit(tx, { actor, operationId, action: "sale.create", capability: "sales.create", resourceType: "SALE", resourceId: String(sale.id), changes: { source: resolved.source, totalMinor: total, lines: resolved.lines.length } });
    return { saleId: String(sale.id), ...(await saleSnapshot(tx, actor.businessId, String(sale.id))) };
  });
}

/** Inserta las líneas con su snapshot histórico. El precio ya viene resuelto. */
async function insertLines(tx: Tx, actor: Actor, saleId: string, revision: number, lines: readonly SaleLineInput[]): Promise<void> {
  let position = 1;
  for (const line of lines) {
    const lineTotal = line.unitPriceMinor * line.quantity - (line.discountMinor ?? 0);
    await tx`
      insert into sales.sale_lines(business_id,sale_id,revision,position,kind,service_id,sku,location_id,name,quantity,unit_price_minor,discount_minor,line_total_minor,currency,duration_minutes)
      values (${actor.businessId},${saleId},${revision},${position},${line.kind},${line.serviceId ?? null},${line.sku ?? null},${line.locationId ?? null},
              ${line.name},${line.quantity},${line.unitPriceMinor},${line.discountMinor ?? 0},${lineTotal},'ARS',${line.durationMinutes ?? null})`;
    position += 1;
  }
}

export async function confirmSale(actor: Actor, saleId: string, body: unknown, operationId: string) {
  requireCapability(actor, "sales.confirm");
  const input = confirmSaleSchema.parse(body);

  return executeOperation({
    actor,
    operationId,
    command: "sale.confirm",
    payload: { saleId, ...input }
  }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const sale = await loadSale(tx, actor.businessId, saleId, true);
    if (sale.status === "CONFIRMED") {
      throw new DomainError("SALE_ALREADY_CONFIRMED", "La venta ya está confirmada", 409);
    }
    if (sale.status === "CANCELLED") {
      throw new DomainError("SALE_ALREADY_CANCELLED", "La venta está anulada", 409);
    }
    checkRevision(sale.revision, input.expectedRevision);

    const lines = await currentLines(tx, actor.businessId, saleId);
    if (!lines.length) throw new DomainError("SALE_LINE_INVALID", "La venta no tiene líneas", 409);

    // Revalidación de precio vigente (B01.3.12): si el catálogo cambió, se
    // INFORMA; nunca se confirma en silencio con un precio distinto.
    const productLines = lines
      .filter((line) => line.kind === "PRODUCT")
      .map((line) => ({
        kind: "PRODUCT" as const,
        sku: line.sku ?? undefined,
        locationId: line.locationId ?? undefined,
        name: line.name,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        discountMinor: line.discountMinor,
        discountReason: line.discountMinor > 0 ? "Snapshot confirmado" : undefined
      }));
    try {
      await assertProductLines(tx, actor, productLines);
    } catch (error) {
      if (error instanceof DomainError && error.code === "PRICE_CHANGED" && !input.acceptPriceChanges) {
        throw new DomainError("PRICE_CHANGED", "El precio de catálogo cambió desde que cargaste la venta. Revisá y confirmá el precio actual.", 409, error.details);
      }
      throw error;
    }

    const total = saleTotal(lines);
    const [updated] = await tx`
      update sales.sales
         set status='CONFIRMED', confirmed_at=now(), total_minor=${total}, revision=revision+1, updated_at=now()
       where business_id=${actor.businessId} and id=${saleId} and status='DRAFT'
      returning revision::int revision`;
    if (!updated) throw conflict("La venta cambió concurrentemente");

    await audit(tx, { actor, operationId, action: "sale.confirm", capability: "sales.confirm", resourceType: "SALE", resourceId: saleId, changes: { totalMinor: total, lines: lines.length } });
    return { saleId, ...(await saleSnapshot(tx, actor.businessId, saleId)) };
  });
}

export async function cancelSale(actor: Actor, saleId: string, body: unknown, operationId: string) {
  requireCapability(actor, "sales.cancel");
  const input = cancelSaleSchema.parse(body);

  return executeOperation({
    actor,
    operationId,
    command: "sale.cancel",
    payload: { saleId, ...input }
  }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const sale = await loadSale(tx, actor.businessId, saleId, true);
    if (sale.status === "CANCELLED") throw new DomainError("SALE_ALREADY_CANCELLED", "La venta ya está anulada", 409);
    checkRevision(sale.revision, input.expectedRevision);

    const settled = await settledMinor(tx, actor.businessId, saleId);
    if (settled > 0) {
      throw new DomainError("SALE_HAS_CONFIRMED_MONEY", "La venta tiene dinero confirmado: registrá un refund antes de anularla", 409, { settledMinor: settled });
    }

    const [updated] = await tx`
      update sales.sales
         set status='CANCELLED', cancelled_at=now(), cancellation_reason=${input.reason}, revision=revision+1, updated_at=now()
       where business_id=${actor.businessId} and id=${saleId} and status <> 'CANCELLED'
      returning revision::int revision`;
    if (!updated) throw conflict("La venta cambió concurrentemente");

    await audit(tx, { actor, operationId, action: "sale.cancel", capability: "sales.cancel", resourceType: "SALE", resourceId: saleId, changes: { reason: input.reason } });
    return { saleId, ...(await saleSnapshot(tx, actor.businessId, saleId)) };
  });
}

/**
 * Corrección comercial trazable (B01.9.1).
 *
 * El original NO se reescribe: sus líneas quedan marcadas como superadas
 * (su snapshot comercial es inmutable por trigger) y se insertan las líneas
 * de la nueva revisión. El before/after íntegro queda en
 * `corrections.corrections`.
 */
export async function correctSale(actor: Actor, saleId: string, body: unknown, operationId: string) {
  requireCapability(actor, "sales.correct");
  const input = correctSaleSchema.parse(body);

  return executeOperation({
    actor,
    operationId,
    command: "sale.correct",
    payload: { saleId, ...input }
  }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const sale = await loadSale(tx, actor.businessId, saleId, true);
    if (sale.status === "CANCELLED") throw new DomainError("SALE_ALREADY_CANCELLED", "La venta está anulada", 409);
    checkRevision(sale.revision, input.expectedRevision);
    if (!input.lines) throw new DomainError("SALE_LINE_INVALID", "La corrección requiere las líneas corregidas", 400);
    assertDiscountAuthority(actor, input.lines);

    const before = await saleSnapshot(tx, actor.businessId, saleId);
    await assertProductLines(tx, actor, input.lines.filter((line) => line.kind === "PRODUCT"));

    const nextRevision = sale.revision + 1;
    // La corrección se REGISTRA PRIMERO: es la prueba trazable que habilita
    // el cambio de total de una venta confirmada (trigger `guard_confirmed_sale`).
    const [correction] = await tx`
      insert into corrections.corrections(business_id,operation_id,type,target_type,target_id,status,reason,before_snapshot,after_snapshot,actor_account_id)
      values (${actor.businessId},${operationId},'COMMERCIAL','SALE',${saleId},'PENDING',${input.reason},
              ${JSON.stringify({ totalMinor: before.totalMinor, lines: before.lines })}::jsonb,
              ${JSON.stringify({ pending: true })}::jsonb,
              ${actor.accountId})
      returning id`;
    await tx`
      update sales.sale_lines set superseded_at=now()
       where business_id=${actor.businessId} and sale_id=${saleId} and superseded_at is null`;
    await insertLines(tx, actor, saleId, nextRevision, input.lines);
    const total = saleTotal(input.lines);
    await tx`
      update sales.sales set total_minor=${total}, revision=${nextRevision}, updated_at=now()
       where business_id=${actor.businessId} and id=${saleId}`;

    const after = await saleSnapshot(tx, actor.businessId, saleId);
    await tx`
      update corrections.corrections
         set status='APPLIED', after_snapshot=${JSON.stringify({ totalMinor: after.totalMinor, lines: after.lines })}::jsonb
       where business_id=${actor.businessId} and id=${correction!.id}`;

    await audit(tx, { actor, operationId, action: "sale.correct", capability: "sales.correct", resourceType: "SALE", resourceId: saleId, changes: { reason: input.reason, beforeMinor: before.totalMinor, afterMinor: after.totalMinor } });
    return { saleId, correctionId: String(correction!.id), ...after };
  });
}
