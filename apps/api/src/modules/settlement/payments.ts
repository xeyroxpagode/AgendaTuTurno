import { DomainError, settlementPaymentSchema, type Capability } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { authorizationService } from "../iam/authorization.js";
import { rows, sql } from "../../lib/sql.js";
import { payObligation } from "../obligations/commands.js";
const CAPABILITY: Capability = "economy.payment.manage";

/**
 * CAP-08-05 · Registro de pago/cobranza sobre la obligación H05 existente.
 * El dinero ya fue confirmado por H05 Money; aquí NO se crea MoneyOperation.
 */
export async function registerSettlementPayment(actor: Actor, raw: unknown, operationId: string) {
  const input = settlementPaymentSchema.parse(raw);
  const [settlement] = await rows<{ id: string; staffMemberId: string; payableObligationId: string | null; receivableObligationId: string | null }>(sql`
    select id, staff_member_id "staffMemberId", payable_obligation_id "payableObligationId",
           receivable_obligation_id "receivableObligationId"
    from econ.settlements where business_id=${actor.businessId} and id=${input.settlementId}`);
  if (!settlement) throw new DomainError("NOT_FOUND", "Settlement not found", 404);
  authorizationService.require(actor, CAPABILITY, { staffMemberId: String(settlement.staffMemberId) });
  // H05 `obligations.pay` es sensible y requiere grant explícito para RECEPTIONIST.
  // H08 no lo suplanta: se reporta la falta con un código accionable.
  if (!actor.capabilities.has("obligations.pay")) {
    throw new DomainError("ECONOMY_FORBIDDEN", "Registrar pagos requiere la capability H05 obligations.pay (grant explícito)", 403);
  }
  const obligationId = input.kind === "RECEIVABLE" ? settlement.receivableObligationId : settlement.payableObligationId;
  if (!obligationId) throw new DomainError("OBLIGATION_NOT_FOUND", "The settlement has no obligation of that kind", 404);
  return payObligation(actor, String(obligationId), { moneyOperationId: input.moneyOperationId, amountMinor: input.amountMinor }, operationId);
}
