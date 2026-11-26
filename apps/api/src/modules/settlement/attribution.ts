import { commissionMinor, DomainError, parseMinor } from "@youngkingz/contracts";
import type { Tx } from "../system/operations.js";

export type EconomicSource = {
  sourceType: "SALE";
  sourceId: string;
  saleId: string;
  attendanceId: string;
  occurredAt: Date;
  lineTotalMinor: bigint;
  baseMinor: bigint;
  commissionMinor: bigint;
  versionId: string | null;
  versionNote: string;
  collectedOperations?: string[];
  refundOperations?: string[];
};

type SaleRow = {
  sale_id: string; attendance_id: string; occurred_at: Date;
  line_total_minor: string; modality: string | null; commission_base: string | null;
  bps: number | null; version_id: string | null; terms_hash: string | null;
};

/**
 * NEW-ATTRIBUTION · El profesional es `attendances.attended_by_staff_member_id`
 * (prestador real verificado), NUNCA `staff_member_id` (quien registró).
 *
 * CORRECCIÓN P0 (EGM): la comisión se calcula POR VENTA, no por línea, porque
 * H05 realiza cobros a nivel de Sale. Repartir el cobro entre líneas sería un
 * prorrateo NO autorizado (CL-09). Una sola fuente por Sale evita además la
 * duplicación de comisión. Se excluyen líneas `superseded_at` y ventas no
 * confirmadas, y se resuelve UNA versión vigente por LATERAL (sin join que
 * multiplique filas si existen varios acuerdos).
 */
export async function eligibleSources(
  tx: Tx, businessId: string, staffMemberId: string, periodStart: Date, periodEnd: Date
): Promise<EconomicSource[]> {
  const sales = await tx`
    select s.id sale_id, a.id attendance_id, a.started_at occurred_at,
           sum(sl.line_total_minor)::text line_total_minor,
           v.modality, v.commission_base, v.bps, v.id version_id, v.terms_hash
    from attendance.attendances a
    join sales.sales s on s.business_id=a.business_id and s.attendance_id=a.id and s.status='CONFIRMED'
    join sales.sale_lines sl on sl.business_id=s.business_id and sl.sale_id=s.id
      and sl.superseded_at is null and sl.kind='SERVICE'
    left join lateral (
      select v.id, v.modality, v.commission_base, v.bps, v.terms_hash
      from econ.agreements ag
      join econ.agreement_versions v on v.business_id=ag.business_id and v.agreement_id=ag.id
      where ag.business_id=a.business_id and ag.staff_member_id=a.attended_by_staff_member_id
        and ag.status='ACTIVE' and v.status='ACTIVE'
        and v.valid_from <= a.started_at and v.valid_to > a.started_at and v.created_at <= a.started_at
      order by v.valid_from desc, v.version desc limit 1
    ) v on true
    where a.business_id=${businessId} and a.attended_by_staff_member_id=${staffMemberId}
      and a.status='COMPLETED' and a.attended_by_staff_member_id is not null
      and a.started_at >= ${periodStart.toISOString()} and a.started_at < ${periodEnd.toISOString()}
    group by s.id, a.id, a.started_at, v.modality, v.commission_base, v.bps, v.id, v.terms_hash
    order by a.started_at, s.id` as unknown as SaleRow[];

  const result: EconomicSource[] = [];
  for (const sale of sales) {
    const lineTotal = parseMinor(sale.line_total_minor);
    if (sale.version_id && (sale.modality === "FIXED" || sale.modality === "CHAIR_RENT"
        || (sale.modality === "MIXED" && sale.commission_base === null && sale.bps === null))) continue;
    if (!sale.version_id || sale.commission_base === null || sale.bps === null) {
      // Un acuerdo incompleto NO se convierte en importe cero.
      result.push({
        sourceType: "SALE", sourceId: String(sale.sale_id), saleId: String(sale.sale_id),
        attendanceId: String(sale.attendance_id), occurredAt: new Date(sale.occurred_at),
        lineTotalMinor: lineTotal, baseMinor: 0n, commissionMinor: 0n, versionId: null,
        versionNote: "NOT_CONFIGURED"
      });
      continue;
    }
    let base = lineTotal;
    let collectedOperations: string[] | undefined;
    let refundOperations: string[] | undefined;
    if (sale.commission_base === "COLLECTED") {
      const [collected] = await tx`
        select coalesce(sum(ma.amount_minor),0)::text amount, coalesce(array_agg(distinct mo.id order by mo.id),array[]::uuid[]) operations
        from money.money_allocations ma join money.money_operations mo
          on mo.business_id=ma.business_id and mo.id=ma.money_operation_id and mo.status='SUCCEEDED' and mo.kind='PAYMENT'
        where ma.business_id=${businessId} and ma.target_type='SALE' and ma.target_id=${sale.sale_id}` as unknown as { amount: string; operations: string[] }[];
      // D-20: el origen identifica el pago, no la distribución económica de
      // un anticipo entre ventas y saldo sin asignar. Un histórico sin esa
      // evidencia no equivale a cero devuelto ni admite reparto por importe.
      const ambiguous = await tx`
        select r.id
        from money.money_operations r
        join money.money_operations origin
          on origin.business_id=r.business_id and origin.id=r.refund_of_id
        where r.business_id=${businessId} and r.kind='REFUND' and r.status='SUCCEEDED'
          and not exists (
            select 1 from money.refund_attributions ra
             where ra.business_id=r.business_id and ra.refund_id=r.id
          )
          and (
            (r.sale_id is null and (
              origin.sale_id is null
              or exists (
                select 1 from money.money_allocations other_a
                where other_a.business_id=origin.business_id and other_a.money_operation_id=origin.id
                  and (other_a.target_type<>'SALE' or other_a.target_id<>origin.sale_id or other_a.created_at>r.created_at)
              )
              or (select coalesce(sum(coverage.amount_minor),0) from money.money_allocations coverage
                   where coverage.business_id=origin.business_id and coverage.money_operation_id=origin.id) <> origin.confirmed_minor
            ))
            or (r.sale_id is not null and not exists (
              select 1 from money.money_allocations explicit_a
              where explicit_a.business_id=origin.business_id and explicit_a.money_operation_id=origin.id
                and explicit_a.target_type='SALE' and explicit_a.target_id=r.sale_id
            ))
          )
          and exists (
            select 1 from money.money_allocations a
             where a.business_id=origin.business_id and a.money_operation_id=origin.id
               and a.target_type='SALE' and a.target_id=${sale.sale_id}
          )
        order by r.id`;
      if (ambiguous.length) {
        throw new DomainError("SETTLEMENT_CONFLICT", "La atribución de una devolución histórica es desconocida; no se puede calcular una base definitiva", 409, {
          attributionState: "UNKNOWN", saleId: sale.sale_id,
          refundIds: ambiguous.map((row) => String(row.id))
        });
      }

      // Nuevos refunds: cantidades explícitas por allocation canónica.
      // Legacy: sólo referencias directas inequívocas. La suma anterior comprueba
      // cobertura completa/sin excedente; NO selecciona una venta por importe.
      const [refunded] = await tx`
        select coalesce(sum(case when exists (
          select 1 from money.refund_attributions all_ra
           where all_ra.business_id=r.business_id and all_ra.refund_id=r.id
        ) then (
          select coalesce(sum(ra.amount_minor),0)
          from money.refund_attributions ra
          join money.money_allocations a
            on a.business_id=ra.business_id and a.id=ra.original_allocation_id
          where ra.business_id=r.business_id and ra.refund_id=r.id
            and a.money_operation_id=origin.id and a.target_type='SALE' and a.target_id=${sale.sale_id}
        ) else r.amount_minor end),0)::text amount,
        coalesce(array_agg(r.id order by r.id),array[]::uuid[]) operations
        from money.money_operations r
        join money.money_operations origin
          on origin.business_id=r.business_id and origin.id=r.refund_of_id
        where r.business_id=${businessId} and r.kind='REFUND' and r.status='SUCCEEDED'
          and (
            exists (
              select 1 from money.refund_attributions ra
              join money.money_allocations a
                on a.business_id=ra.business_id and a.id=ra.original_allocation_id
              where ra.business_id=r.business_id and ra.refund_id=r.id
                and a.money_operation_id=origin.id and a.target_type='SALE' and a.target_id=${sale.sale_id}
            ) or (
              not exists (select 1 from money.refund_attributions ra where ra.business_id=r.business_id and ra.refund_id=r.id)
              and (r.sale_id=${sale.sale_id} or (r.sale_id is null and origin.sale_id=${sale.sale_id}))
            )
          )` as unknown as { amount: string; operations: string[] }[];
      collectedOperations = collected!.operations;
      refundOperations = refunded!.operations;
      const net = parseMinor(collected!.amount) - parseMinor(refunded!.amount);
      base = net <= 0n ? 0n : (net > lineTotal ? lineTotal : net);
    }
    result.push({
      sourceType: "SALE", sourceId: String(sale.sale_id), saleId: String(sale.sale_id),
      attendanceId: String(sale.attendance_id), occurredAt: new Date(sale.occurred_at),
      lineTotalMinor: lineTotal, baseMinor: base, commissionMinor: commissionMinor(base, sale.bps),
      versionId: String(sale.version_id), versionNote: sale.terms_hash ?? "NO_TERMS_HASH", collectedOperations, refundOperations
    });
  }
  return result;
}
