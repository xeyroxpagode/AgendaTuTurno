import { DomainError, settlementAdjustmentSchema, type Capability } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { authorizationService } from "../iam/authorization.js";
import { audit, executeOperation, revalidateAuthority } from "../system/operations.js";
import { rows, sql } from "../../lib/sql.js";

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

    const [row] = await tx`
      insert into econ.settlement_adjustments(business_id, settlement_id, amount_minor, reason, source_type, source_id, created_by_account_id, operation_id)
      values (${actor.businessId}, ${input.settlementId}, ${input.amountMinor}, ${input.reason},
              ${input.sourceType ?? null}, ${input.sourceId ?? null}, ${actor.accountId}, ${operationId})
      returning id`;
    // Un refund sin sale_id NO reatribuye: sólo ajusta causalmente el saldo.
    if (settlement.payableObligationId) {
      await tx`
        update obligations.expense_obligations
        set amount_minor = amount_minor + ${input.amountMinor}::bigint,
            revision = revision + 1, updated_at = now()
        where business_id=${actor.businessId} and id=${settlement.payableObligationId}`;
    }
    await tx`update econ.settlements set status='ADJUSTED' where business_id=${actor.businessId} and id=${input.settlementId}`;
    await revalidateAuthority(tx, actor, CAPABILITY, { staffMemberId: settlement.staffMemberId });
    await audit(tx, { actor, operationId, action: "settlement.adjusted", capability: CAPABILITY, resourceType: "SETTLEMENT", resourceId: input.settlementId, changes: { amountMinor: input.amountMinor, reason: input.reason, sourceType: input.sourceType ?? null, hasSourceId: Boolean(input.sourceId) } });
    return { adjustmentId: row!.id as string, settlementId: input.settlementId, snapshotUnchanged: true };
  });
}

export async function settlementHistory(actor: Actor, staffMemberId: string) {
  const settlements = await rows(sql`
    select id, period_start "periodStart", period_end "periodEnd", status, total_payable_minor "payableMinor",
           total_receivable_minor "receivableMinor", terms_hash "termsHash", source_fingerprint "sourceFingerprint",
           payable_obligation_id "payableObligationId", receivable_obligation_id "receivableObligationId", closed_at "closedAt"
    from econ.settlements where business_id=${actor.businessId} and staff_member_id=${staffMemberId}
    order by period_start desc`);
  const adjustments = await rows(sql`
    select a.id, a.settlement_id "settlementId", a.amount_minor "amountMinor", a.reason,
           a.source_type "sourceType", a.source_id "sourceId", a.created_at "createdAt"
    from econ.settlement_adjustments a where a.business_id=${actor.businessId}
      and exists (select 1 from econ.settlements s where s.business_id=a.business_id and s.id=a.settlement_id and s.staff_member_id=${staffMemberId})
    order by a.created_at desc`);
  return { settlements, adjustments };
}
