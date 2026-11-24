import { DomainError, selfEconomyQuerySchema } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { authorizationService } from "../iam/authorization.js";
import { rows, sql } from "../../lib/sql.js";

/**
 * CL-13 · Economía propia del Barber.
 *
 * El `staffMemberId` NO se recibe del cliente: se fuerza al del Actor. Toda
 * consulta lleva `business_id` Y el staff propio. No se expone PII de clientes
 * ni importes de otros profesionales ni economía global del negocio.
 */
export async function selfEconomy(actor: Actor, raw: unknown) {
  authorizationService.require(actor, "economy.self.read");
  const input = selfEconomyQuerySchema.parse(raw);
  const staffId = actor.staffMemberId;
  if (!staffId) throw new DomainError("FORBIDDEN", "No StaffMember is linked to this actor", 403);

  const agreements = await rows(sql`
    select v.id, v.modality, v.commission_base "commissionBase", v.bps,
           v.fixed_amount_minor "fixedAmountMinor", v.rent_amount_minor "rentAmountMinor",
           v.valid_from "validFrom", v.valid_to "validTo", v.terms_hash "termsHash"
    from econ.agreement_versions v join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
    where v.business_id=${actor.businessId} and a.staff_member_id=${staffId}
      and v.status='ACTIVE' and v.valid_from <= now() and v.valid_to > now()
    order by v.version desc limit 1`);

  const estimates = await rows(sql`
    select id, period_start "periodStart", period_end "periodEnd", state,
           total_payable_minor "payableMinor", total_receivable_minor "receivableMinor", lines
    from econ.estimates
    where business_id=${actor.businessId} and staff_member_id=${staffId}
      and period_start >= ${input.from} and period_end <= ${input.to}
    order by period_start desc`);

  const settlements = await rows(sql`
    select id, period_start "periodStart", period_end "periodEnd", status,
           total_payable_minor "payableMinor", total_receivable_minor "receivableMinor", closed_at "closedAt"
    from econ.settlements
    where business_id=${actor.businessId} and staff_member_id=${staffId}
      and period_start >= ${input.from} and period_end <= ${input.to}
    order by period_start desc`);

  const obligations = await rows(sql`
    select o.id, o.kind, o.amount_minor "amountMinor", o.status,
           coalesce((select sum(p.amount_minor) from obligations.obligation_payments p
             where p.business_id=o.business_id and p.obligation_id=o.id),0)::text "paidMinor"
    from obligations.expense_obligations o
    join econ.settlements s on s.business_id=o.business_id
      and (s.payable_obligation_id=o.id or s.receivable_obligation_id=o.id)
    where o.business_id=${actor.businessId} and s.staff_member_id=${staffId}
      and s.period_start >= ${input.from} and s.period_end <= ${input.to}`);

  const adjustments = await rows(sql`
    select a.id, a.amount_minor "amountMinor", a.reason, a.created_at "createdAt"
    from econ.settlement_adjustments a
    join econ.settlements s on s.business_id=a.business_id and s.id=a.settlement_id
    where a.business_id=${actor.businessId} and s.staff_member_id=${staffId}
      and s.period_start >= ${input.from} and s.period_end <= ${input.to}
    order by a.created_at desc`);

  return { staffMemberId: staffId, agreements, estimates, settlements, obligations, adjustments };
}
