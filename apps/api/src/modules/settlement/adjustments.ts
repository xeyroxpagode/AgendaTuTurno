import { DomainError, settlementAdjustmentSchema, type Capability } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { authorizationService } from "../iam/authorization.js";
import { audit, executeOperation, revalidateAuthority } from "../system/operations.js";
import { rows, sql } from "../../lib/sql.js";
import { lockBusiness } from "../h05/domain.js";
import { settledMinor } from "../obligations/domain.js";

const CAPABILITY: Capability = "economy.settlement.close";

/** CAP-08-06 · Ajuste = HECHO NUEVO. El snapshot original permanece intacto. */
export async function adjustSettlement(actor: Actor, raw: unknown, operationId: string) {
  const input = settlementAdjustmentSchema.parse(raw);
  return executeOperation({ operationId, command: "settlement.adjust", actor, payload: input }, async (tx) => {
    const [settlement] = await tx`
      select id, staff_member_id "staffMemberId", status, payable_obligation_id "payableObligationId",
             receivable_obligation_id "receivableObligationId", snapshot
      from econ.settlements where business_id=${actor.businessId} and id=${input.settlementId}` as unknown as Array<{ id: string; staffMemberId: string; status: string; payableObligationId: string | null; receivableObligationId: string | null; snapshot: unknown }>;
    if (!settlement) throw new DomainError("NOT_FOUND", "Settlement not found", 404);
    authorizationService.require(actor, CAPABILITY, { staffMemberId: settlement.staffMemberId });

    // Mismo lock y mismas guardas que H05 updateObligation: el ajuste no puede
    // entrelazarse con un pago ni dejar el importe por debajo de lo pagado.
    await lockBusiness(tx, actor.businessId);
    if (input.sourceType === "REFUND") {
      const [cause] = await tx`
        select r.id from money.money_operations r
        join money.money_operations p on p.business_id=r.business_id and p.id=r.refund_of_id
        join econ.settlement_sources s on s.business_id=r.business_id and s.settlement_id=${input.settlementId}
          and s.source_type='SALE' and s.source_id=p.sale_id
        where r.business_id=${actor.businessId} and r.id=${input.sourceId ?? null}
          and r.kind='REFUND' and r.status='SUCCEEDED'`;
      if (!cause || input.amountMinor > 0 || input.kind !== "PAYABLE") {
        throw new DomainError("ADJUSTMENT_INVALID", "El reintegro debe estar confirmado y vinculado a una venta de esta liquidación.", 409);
      }
    }
    const obligationId = input.kind === "RECEIVABLE" ? settlement.receivableObligationId : settlement.payableObligationId;
    if (!obligationId) throw new DomainError("OBLIGATION_NOT_FOUND", "The settlement has no obligation of that kind", 404);
    const [obligation] = await tx`
      select id, amount_minor "amountMinor", revision, status::text status
      from obligations.expense_obligations
      where business_id=${actor.businessId} and id=${obligationId} for update` as unknown as Array<{ id: string; amountMinor: string | null; revision: number; status: string }>;
    if (!obligation) throw new DomainError("OBLIGATION_NOT_FOUND", "Obligation not found", 404);
    if (obligation.status === "CANCELLED") throw new DomainError("ADJUSTMENT_INVALID", "Cannot adjust a cancelled obligation", 409);
    const nextAmount = BigInt(obligation.amountMinor ?? "0") + BigInt(input.amountMinor);
    if (nextAmount < 0n) throw new DomainError("OBLIGATION_PAYMENT_EXCEEDS", "Adjustment cannot make the amount negative", 409);
    if (nextAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DomainError("ADJUSTMENT_INVALID", "El total excede el rango admitido por Obligaciones.", 409);
    }
    const settled = await settledMinor(tx, actor.businessId, obligationId);
    if (settled > nextAmount) throw new DomainError("OBLIGATION_PAYMENT_EXCEEDS", "Adjustment cannot leave the amount below what was already paid", 409);

    const [row] = await tx`
      insert into econ.settlement_adjustments(business_id, settlement_id, amount_minor, obligation_kind, reason, source_type, source_id, created_by_account_id, operation_id)
      values (${actor.businessId}, ${input.settlementId}, ${input.amountMinor}, ${input.kind}, ${input.reason},
              ${input.sourceType ?? null}, ${input.sourceId ?? null}, ${actor.accountId}, ${operationId})
      on conflict (business_id, settlement_id, source_type, source_id)
        where source_type in ('REFUND','CORRECTION') and source_id is not null do nothing
      returning id`;
    if (!row) throw new DomainError("ADJUSTMENT_INVALID", "Esta causa ya tiene un ajuste para la misma liquidación.", 409);
    // A change in the amount can reopen a previously settled obligation.
    const status = nextAmount === BigInt(settled) ? "SETTLED" : settled > 0 ? "PARTIAL" : "OPEN";
    await tx`
      update obligations.expense_obligations
      set amount_minor=${nextAmount.toString()}, revision=revision+1, updated_at=now(),
          status=${status}
      where business_id=${actor.businessId} and id=${obligationId}`;
    await tx`update econ.settlements set status='ADJUSTED' where business_id=${actor.businessId} and id=${input.settlementId}`;
    await revalidateAuthority(tx, actor, CAPABILITY, { staffMemberId: settlement.staffMemberId });
    await audit(tx, { actor, operationId, action: "settlement.adjusted", capability: CAPABILITY, resourceType: "SETTLEMENT", resourceId: input.settlementId, changes: { amountMinor: input.amountMinor, kind: input.kind, reason: input.reason, sourceType: input.sourceType ?? null, hasSourceId: Boolean(input.sourceId) } });
    return { adjustmentId: row!.id as string, settlementId: input.settlementId, snapshotUnchanged: true };
  });
}

export async function settlementHistory(actor: Actor, staffMemberId: string) {
  const settlements = await rows(sql`
    select id, period_start "periodStart", period_end "periodEnd", status, total_payable_minor "payableMinor",
           total_receivable_minor "receivableMinor", terms_hash "termsHash", source_fingerprint "sourceFingerprint",
           payable_obligation_id "payableObligationId", receivable_obligation_id "receivableObligationId", closed_at "closedAt", snapshot
    from econ.settlements where business_id=${actor.businessId} and staff_member_id=${staffMemberId}
    order by period_start desc`);
  const adjustments = await rows(sql`
    select a.id, a.settlement_id "settlementId", a.amount_minor "amountMinor", a.reason,
           a.obligation_kind "kind", a.source_type "sourceType", a.source_id "sourceId", a.created_at "createdAt"
    from econ.settlement_adjustments a where a.business_id=${actor.businessId}
      and exists (select 1 from econ.settlements s where s.business_id=a.business_id and s.id=a.settlement_id and s.staff_member_id=${staffMemberId})
    order by a.created_at desc`);
  return { settlements, adjustments };
}
