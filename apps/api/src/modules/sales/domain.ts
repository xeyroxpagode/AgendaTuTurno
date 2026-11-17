import { DomainError, type SaleLineInput, type SaleLineSnapshot, type SaleSnapshot } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";
import { conflict, deriveSaleBalance, missing } from "../h05/domain.js";

/**
 * H05 · CAP-05-01 Sales · dominio.
 *
 * Una `CommercialSale` es un ACTO COMERCIAL explícito. No es una proyección
 * de Attendance (D02) ni de una reserva.
 *
 * Origen causal (B01.2, reglas de unicidad causal):
 *  · ATTENDANCE — la venta referencia una atención REAL y terminal del mismo
 *    Business. Los servicios se toman del `services_performed_snapshot` de esa
 *    atención: son los servicios EFECTIVAMENTE realizados, con su precio
 *    histórico.
 *  · WALK_IN — sin atención: documenta el contacto en `contact_snapshot`. NO
 *    crea Reservation ni cuenta CLIENT.
 *  · DIRECT — venta directa de productos.
 */

export type SaleRow = {
  id: string;
  businessId: string;
  operationId: string;
  status: "DRAFT" | "CONFIRMED" | "CANCELLED";
  source: "ATTENDANCE" | "WALK_IN" | "DIRECT";
  attendanceId: string | null;
  contactSnapshot: unknown;
  currency: string;
  totalMinor: number;
  revision: number;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function loadSale(tx: Tx, businessId: string, saleId: string, forUpdate = false): Promise<SaleRow> {
  const rows = await tx`
    select id, business_id "businessId", operation_id "operationId", status::text status,
           source::text source, attendance_id "attendanceId", contact_snapshot "contactSnapshot",
           currency, total_minor::int "totalMinor", revision::int revision,
           confirmed_at "confirmedAt", cancelled_at "cancelledAt",
           cancellation_reason "cancellationReason", note, created_at "createdAt", updated_at "updatedAt"
      from sales.sales
     where business_id = ${businessId} and id = ${saleId}
     ${forUpdate ? tx`for update` : tx``}`;
  const row = rows[0];
  if (!row) throw missing("esa venta");
  return row as unknown as SaleRow;
}

/** Líneas vigentes (no superadas por una corrección posterior). */
export async function currentLines(tx: Tx, businessId: string, saleId: string): Promise<SaleLineSnapshot[]> {
  const rows = await tx`
    select id, kind::text kind, service_id "serviceId", sku, location_id "locationId", name,
           quantity, unit_price_minor::int "unitPriceMinor", discount_minor::int "discountMinor",
           line_total_minor::int "lineTotalMinor", currency, duration_minutes "durationMinutes",
           snapshot_at "snapshotAt"
      from sales.sale_lines
     where business_id = ${businessId} and sale_id = ${saleId} and superseded_at is null
     order by revision, position`;
  return rows as unknown as SaleLineSnapshot[];
}

/** Todas las líneas, incluidas las superadas: es la historia completa. */
export async function allLines(tx: Tx, businessId: string, saleId: string): Promise<(SaleLineSnapshot & { revision: number; supersededAt: string | null })[]> {
  const rows = await tx`
    select id, kind::text kind, service_id "serviceId", sku, location_id "locationId", name,
           quantity, unit_price_minor::int "unitPriceMinor", discount_minor::int "discountMinor",
           line_total_minor::int "lineTotalMinor", currency, duration_minutes "durationMinutes",
           snapshot_at "snapshotAt", revision::int revision, superseded_at "supersededAt"
      from sales.sale_lines
     where business_id = ${businessId} and sale_id = ${saleId}
     order by revision, position`;
  return rows as unknown as (SaleLineSnapshot & { revision: number; supersededAt: string | null })[];
}

/**
 * Dinero YA CONFIRMADO asignado a la venta. Es la única fuente del saldo:
 * el saldo de una venta es DERIVADO (B01.3.10, invariante 1: Sales no
 * duplica Money).
 */
export async function settledMinor(tx: Tx, businessId: string, saleId: string): Promise<number> {
  const [row] = await tx`
    select coalesce(sum(a.amount_minor),0)::int total
      from money.money_allocations a
      join money.money_operations m on m.business_id = a.business_id and m.id = a.money_operation_id
     where a.business_id = ${businessId}
       and a.target_type = 'SALE'
       and a.target_id = ${saleId}
       and m.status = 'SUCCEEDED'`;
  return Number(row?.total ?? 0);
}

/** Snapshot completo de la venta, con saldo DERIVADO. */
export async function saleSnapshot(tx: Tx, businessId: string, saleId: string): Promise<SaleSnapshot> {
  const sale = await loadSale(tx, businessId, saleId);
  const lines = await currentLines(tx, businessId, saleId);
  const settled = await settledMinor(tx, businessId, saleId);
  return {
    id: sale.id,
    businessId: sale.businessId,
    status: sale.status,
    source: sale.source,
    attendanceId: sale.attendanceId,
    contact: (sale.contactSnapshot ?? null) as SaleSnapshot["contact"],
    currency: "ARS",
    totalMinor: sale.totalMinor,
    settledMinor: settled,
    balance: deriveSaleBalance(sale.totalMinor, settled),
    lines,
    revision: sale.revision,
    createdAt: new Date(String(sale.createdAt)).toISOString(),
    confirmedAt: sale.confirmedAt ? new Date(String(sale.confirmedAt)).toISOString() : null,
    cancelledAt: sale.cancelledAt ? new Date(String(sale.cancelledAt)).toISOString() : null,
    cancellationReason: sale.cancellationReason
  };
}

/**
 * Resuelve el origen causal y devuelve las líneas con su SNAPSHOT de precio.
 *
 * · desde Attendance → los servicios salen del snapshot performed de la
 *   atención (precio histórico real). Si el snapshot no trae precio, se
 *   rechaza: no se inventa un precio.
 * · producto directo → el precio vigente sale de `inventory.items.price_minor`.
 */
export async function resolveSaleLines(tx: Tx, actor: Actor, input: {
  attendanceId?: string | undefined;
  contactSnapshot?: { name: string; phone: string; email?: string } | undefined;
  lines: SaleLineInput[];
}): Promise<{ source: "ATTENDANCE" | "WALK_IN" | "DIRECT"; lines: SaleLineInput[]; contactSnapshot: unknown; attendanceId: string | null }> {
  const businessId = actor.businessId;

  if (input.attendanceId) {
    const [attendance] = await tx`
      select id, status::text status, walk_in "walkIn", contact_snapshot "contactSnapshot",
             services_performed_snapshot "servicesPerformedSnapshot", attended_by_staff_member_id "attendedByStaffMemberId"
        from attendance.attendances
       where business_id = ${businessId} and id = ${input.attendanceId}`;
    if (!attendance) throw new DomainError("ATTENDANCE_BUSINESS_MISMATCH", "No encontramos esa atención en este negocio", 404);
    if (!["COMPLETED", "PARTIAL", "INTERRUPTED"].includes(String(attendance.status))) {
      throw new DomainError("ATTENDANCE_NOT_TERMINAL", "La atención todavía no está terminada", 409);
    }
    const performed = (attendance.servicesPerformedSnapshot ?? []) as Array<{ serviceId?: string; name: string; durationMinutes: number; priceMinor?: number; currency?: string }>;
    if (!performed.length) {
      throw new DomainError("SALE_SOURCE_INVALID", "La atención no registra servicios realizados", 409);
    }
    if (input.lines.some((line) => line.kind === "SERVICE")) {
      throw new DomainError("SALE_SOURCE_INVALID", "Los servicios de una venta desde atención se toman del snapshot performed", 400);
    }
    const serviceLines: SaleLineInput[] = performed.map((service) => {
      if (service.priceMinor === undefined || service.priceMinor === null) {
        throw new DomainError("SALE_SOURCE_INVALID", `El servicio performed "${service.name}" no tiene precio histórico`, 409);
      }
      return {
        kind: "SERVICE",
        serviceId: service.serviceId,
        name: service.name,
        quantity: 1,
        unitPriceMinor: service.priceMinor,
        discountMinor: 0,
        durationMinutes: service.durationMinutes
      } as SaleLineInput;
    });
    const productLines = input.lines.filter((line) => line.kind === "PRODUCT");
    const lines = [...serviceLines, ...productLines];
    await assertProductLines(tx, actor, productLines);
    return {
      source: "ATTENDANCE",
      lines,
      contactSnapshot: attendance.contactSnapshot ?? null,
      attendanceId: String(attendance.id)
    };
  }

  if (input.contactSnapshot) {
    const productLines = input.lines.filter((line) => line.kind === "PRODUCT");
    if (productLines.length !== input.lines.length) {
      throw new DomainError("SALE_SOURCE_INVALID", "Un walk-in documenta contacto; los servicios requieren una atención real", 400);
    }
    await assertProductLines(tx, actor, productLines);
    return {
      source: "WALK_IN",
      lines: input.lines,
      contactSnapshot: { name: input.contactSnapshot.name, phone: input.contactSnapshot.phone, email: input.contactSnapshot.email ?? null },
      attendanceId: null
    };
  }

  if (!input.lines.length || input.lines.some((line) => line.kind !== "PRODUCT")) {
    throw new DomainError("SALE_SOURCE_INVALID", "La venta necesita un origen causal: atención, walk-in o producto directo", 400);
  }
  await assertProductLines(tx, actor, input.lines);
  return { source: "DIRECT", lines: input.lines, contactSnapshot: null, attendanceId: null };
}

/**
 * Valida las líneas de producto contra el inventario del Business y captura
 * el PRECIO VIGENTE como snapshot (D03). Un producto sin precio published no
 * es vendible.
 */
export async function assertProductLines(tx: Tx, actor: Actor, lines: readonly SaleLineInput[]): Promise<void> {
  for (const line of lines) {
    if (line.kind !== "PRODUCT") continue;
    if (!line.sku) throw conflict("La línea de producto no indica el SKU");
    const [item] = await tx`
      select id, sku, name, use::text use, active, published, price_minor::int "priceMinor"
        from inventory.items
       where business_id = ${actor.businessId} and sku = ${line.sku}`;
    if (!item) throw missing(`el artículo ${line.sku}`);
    if (!item.active) throw conflict(`El artículo ${line.sku} está desactivado`);
    if (item.use === "INTERNAL") throw conflict(`El artículo ${line.sku} es de uso interno`);
    if (line.locationId) {
      const [location] = await tx`
        select id, active from inventory.locations
         where business_id = ${actor.businessId} and id = ${line.locationId}`;
      if (!location) throw missing("esa ubicación");
      if (!location.active) throw conflict("La ubicación está desactivada");
    }
    if (line.unitPriceMinor !== item.priceMinor) {
      throw new DomainError("PRICE_CHANGED", `El precio vigente de ${line.sku} cambió`, 409, {
        sku: line.sku,
        requested: line.unitPriceMinor,
        current: item.priceMinor
      });
    }
  }
}

/**
 * Authority de descuento (B-DEC-01). El descuento exige capability
 * efectiva: sin ella, el descuento se rechaza, no se aplica silenciosamente.
 */
export function assertDiscountAuthority(actor: Actor, lines: readonly SaleLineInput[]): void {
  const hasDiscount = lines.some((line) => (line.discountMinor ?? 0) > 0);
  if (!hasDiscount) return;
  if (!actor.capabilities.has("sales.discount")) {
    throw new DomainError("DISCOUNT_NOT_AUTHORIZED", "No tenés permiso para aplicar descuentos", 403);
  }
  for (const line of lines) {
    const discount = line.discountMinor ?? 0;
    if (discount <= 0) continue;
    if (!line.discountReason || line.discountReason.trim().length < 3) {
      throw new DomainError("VALIDATION_ERROR", "El descuento autorizado exige un motivo", 400);
    }
    const base = line.unitPriceMinor * line.quantity;
    if (discount > base) {
      throw new DomainError("DISCOUNT_EXCEEDS_BASE", "El descuento no puede superar la base comercial de la línea", 400);
    }
  }
}

/**
 * Una venta CONFIRMADA no puede anularse si tiene dinero confirmado: el
 * dinero se devuelve con un refund explícito (hecho monetario nuevo), nunca
 * se pierde en silencio (D25/B-DEC-02).
 */
export async function assertCancellable(tx: Tx, businessId: string, saleId: string): Promise<void> {
  const settled = await settledMinor(tx, businessId, saleId);
  if (settled > 0) {
    throw new DomainError("SALE_HAS_CONFIRMED_MONEY", "La venta tiene dinero confirmado: registrá un refund antes de anularla", 409, { settledMinor: settled });
  }
}
