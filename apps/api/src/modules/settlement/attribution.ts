import { commissionMinor, parseMinor } from "@youngkingz/contracts";
import type { Tx } from "../system/operations.js";

export type EconomicSource = {
  sourceType: "SALE_LINE";
  sourceId: string;
  saleId: string;
  attendanceId: string;
  occurredAt: Date;
  lineTotalMinor: bigint;
  baseMinor: bigint;
  commissionMinor: bigint;
  versionId: string | null;
  versionNote: string;
};

type LineRow = {
  source_id: string; sale_id: string; attendance_id: string; occurred_at: Date;
  line_total_minor: string; modality: string | null; commission_base: string | null;
  bps: number | null; version_id: string | null; terms_hash: string | null;
};

/**
 * NEW-ATTRIBUTION · El profesional es `attendances.attended_by_staff_member_id`
 * (prestador real verificado), NUNCA `staff_member_id` (quien registró).
 * Si no puede determinarse, la fila NO se atribuye: no se inventa destinatario.
 * Se excluyen líneas reemplazadas (`superseded_at`) y ventas no confirmadas.
 */
export async function eligibleSources(
  tx: Tx, businessId: string, staffMemberId: string, periodStart: Date, periodEnd: Date
): Promise<EconomicSource[]> {
  const lines = await tx`
    select sl.id source_id, s.id sale_id, a.id attendance_id, a.started_at occurred_at,
           sl.line_total_minor,
           v.modality, v.commission_base, v.bps, v.id version_id, v.terms_hash
    from attendance.attendances a
    join sales.sales s on s.business_id=a.business_id and s.attendance_id=a.id and s.status='CONFIRMED'
    join sales.sale_lines sl on sl.business_id=s.business_id and sl.sale_id=s.id
      and sl.superseded_at is null and sl.kind='SERVICE'
    left join econ.agreements ag on ag.business_id=a.business_id and ag.staff_member_id=a.attended_by_staff_member_id and ag.status='ACTIVE'
    left join econ.agreement_versions v on v.business_id=ag.business_id and v.agreement_id=ag.id
      and v.status='ACTIVE' and v.valid_from <= a.started_at and v.valid_to > a.started_at
    where a.business_id=${businessId} and a.attended_by_staff_member_id=${staffMemberId}
      and a.status='COMPLETED' and a.attended_by_staff_member_id is not null
      and a.started_at >= ${periodStart.toISOString()} and a.started_at < ${periodEnd.toISOString()}
    order by a.started_at, sl.id` as unknown as LineRow[];

  const result: EconomicSource[] = [];
  for (const line of lines) {
    const lineTotal = parseMinor(line.line_total_minor);
    if (!line.version_id || line.commission_base === null || line.bps === null) {
      // Un acuerdo incompleto NO se convierte en importe cero.
      result.push({
        sourceType: "SALE_LINE", sourceId: String(line.source_id), saleId: String(line.sale_id),
        attendanceId: String(line.attendance_id), occurredAt: new Date(line.occurred_at),
        lineTotalMinor: lineTotal, baseMinor: 0n, commissionMinor: 0n, versionId: null,
        versionNote: "NOT_CONFIGURED"
      });
      continue;
    }
    let base = lineTotal;
    if (line.commission_base === "COLLECTED") {
      const [collected] = await tx`
        select coalesce(sum(ma.amount_minor),0)::text amount
        from money.money_allocations ma join money.money_operations mo
          on mo.business_id=ma.business_id and mo.id=ma.money_operation_id and mo.status='SUCCEEDED'
        where ma.business_id=${businessId} and ma.target_type='SALE' and ma.target_id=${line.sale_id}` as unknown as { amount: string }[];
      const [refunded] = await tx`
        select coalesce(sum(amount_minor),0)::text amount from money.money_operations
        where business_id=${businessId} and sale_id=${line.sale_id} and kind='REFUND' and status='SUCCEEDED'` as unknown as { amount: string }[];
      const net = parseMinor(collected!.amount) - parseMinor(refunded!.amount);
      base = net > 0n && net < lineTotal ? net : (net > lineTotal ? lineTotal : (net > 0n ? net : 0n));
    }
    result.push({
      sourceType: "SALE_LINE", sourceId: String(line.source_id), saleId: String(line.sale_id),
      attendanceId: String(line.attendance_id), occurredAt: new Date(line.occurred_at),
      lineTotalMinor: lineTotal, baseMinor: base, commissionMinor: commissionMinor(base, line.bps),
      versionId: String(line.version_id), versionNote: line.terms_hash ?? "NO_TERMS_HASH"
    });
  }
  return result;
}
