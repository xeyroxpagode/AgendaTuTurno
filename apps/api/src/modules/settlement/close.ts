import { DomainError, closeSettlementSchema, type Capability } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { authorizationService } from "../iam/authorization.js";
import { audit, executeOperation, revalidateAuthority } from "../system/operations.js";
import { calculateEstimate } from "./calculator.js";

export const CLOSE_CAPABILITY: Capability = "economy.settlement.close";

async function counterparty(tx: Parameters<typeof calculateEstimate>[0], businessId: string, staffMemberId: string): Promise<string> {
  const [row] = await tx`
    select p.first_name || coalesce(' ' || p.last_name, '') name
    from team.staff_members sm join iam.persons p on p.id=sm.person_id
    where sm.business_id=${businessId} and sm.id=${staffMemberId}` as unknown as { name: string }[];
  return row?.name ?? "Professional";
}

/** CAP-08-04 · Cierre con snapshot inmutable y doble protección anti-duplicado. */
export async function closeSettlement(actor: Actor, raw: unknown, operationId: string) {
  const input = closeSettlementSchema.parse(raw);
  authorizationService.require(actor, CLOSE_CAPABILITY, { staffMemberId: input.staffMemberId });
  return executeOperation({ operationId, command: "settlement.close", actor, payload: input }, async (tx) => {
    const estimate = await calculateEstimate(tx, actor, { staffMemberId: input.staffMemberId, from: new Date(input.from), to: new Date(input.to) });
    if (estimate.state === "NOT_CONFIGURED") throw new DomainError("NOT_CONFIGURED", "The agreement is incomplete; no settlement can be calculated", 409);

    const name = await counterparty(tx, actor.businessId, input.staffMemberId);
    const snapshot = JSON.stringify({
      period: { from: estimate.periodStart, to: estimate.periodEnd },
      terms: { agreementVersionId: estimate.agreementVersionId, termsHash: estimate.termsHash },
      sources: estimate.lines, sourceFingerprint: estimate.sourceFingerprint
    });

    let settlementId: string;
    try {
      const [row] = await tx`
        insert into econ.settlements(
          business_id, staff_member_id, period_start, period_end, status, currency,
          agreement_version_id, terms_hash, source_fingerprint, total_payable_minor,
          total_receivable_minor, snapshot, closed_by_account_id, operation_id)
        values (${actor.businessId}, ${input.staffMemberId}, ${input.from}, ${input.to}, 'CLOSED_SNAPSHOT', 'ARS',
          ${estimate.agreementVersionId}, ${estimate.termsHash}, ${estimate.sourceFingerprint},
          ${estimate.payableMinor}, ${estimate.receivableMinor}, ${snapshot}::jsonb, ${actor.accountId}, ${operationId})
        returning id`;
      settlementId = row!.id as string;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("SETTLEMENT_CONFLICT", "This period or source was already settled", 409);
      }
      throw error;
    }

    for (const line of estimate.lines) {
      if (line.sourceType === "PERIOD") continue;
      try {
        await tx`
          insert into econ.settlement_sources(business_id, settlement_id, source_type, source_id, component, amount_minor)
          values (${actor.businessId}, ${settlementId}, ${line.sourceType}, ${line.sourceId}, ${line.component}, ${line.amountMinor})`;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new DomainError("SOURCE_ALREADY_SETTLED", "A source cannot be settled twice", 409);
        throw error;
      }
    }

    // Integración H05: MISMA tabla de obligaciones; sin ledger paralelo.
    let payableObligationId: string | null = null;
    let receivableObligationId: string | null = null;
    const dueDate = new Date(input.to).toISOString().slice(0, 10);
    if (BigInt(estimate.payableMinor) > 0n) {
      const [row] = await tx`
        insert into obligations.expense_obligations(business_id, kind, title, counterparty_name, amount_minor, amount_state, currency, due_date, status, revision, note, actor_account_id, operation_id)
        values (${actor.businessId}, 'PAYABLE', ${`Liquidación ${input.from.slice(0, 10)}`}, ${name}, ${estimate.payableMinor}, 'KNOWN', 'ARS', ${dueDate}, 'OPEN', 1, ${`Settlement ${settlementId}`}, ${actor.accountId}, ${operationId})
        returning id`;
      payableObligationId = row!.id as string;
    }
    if (BigInt(estimate.receivableMinor) > 0n) {
      const [row] = await tx`
        insert into obligations.expense_obligations(business_id, kind, title, counterparty_name, amount_minor, amount_state, currency, due_date, status, revision, note, actor_account_id, operation_id)
        values (${actor.businessId}, 'RECEIVABLE', ${`Alquiler de silla ${input.from.slice(0, 10)}`}, ${name}, ${estimate.receivableMinor}, 'KNOWN', 'ARS', ${dueDate}, 'OPEN', 1, ${`Settlement ${settlementId}`}, ${actor.accountId}, ${operationId})
        returning id`;
      receivableObligationId = row!.id as string;
    }
    await tx`update econ.settlements set payable_obligation_id=${payableObligationId}, receivable_obligation_id=${receivableObligationId} where business_id=${actor.businessId} and id=${settlementId}`;

    await revalidateAuthority(tx, actor, CLOSE_CAPABILITY, { staffMemberId: input.staffMemberId });
    await audit(tx, { actor, operationId, action: "settlement.closed", capability: CLOSE_CAPABILITY, resourceType: "SETTLEMENT", resourceId: settlementId, changes: { period: input, payableMinor: estimate.payableMinor, receivableMinor: estimate.receivableMinor, payableObligationId, receivableObligationId } });
    return { settlementId, status: "CLOSED_SNAPSHOT", ...estimate, payableObligationId, receivableObligationId };
  });
}
