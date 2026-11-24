import { deriveObligationBalance } from "@youngkingz/contracts";
import { z } from "zod";
import type { Actor } from "../iam/authorization.js";
import { rows, sql } from "../../lib/sql.js";
import { database } from "../../lib/runtime.js";
import { exactMinor, obligationSnapshot } from "./domain.js";
import { requireCapability } from "../h05/domain.js";

export const obligationQuerySchema = z.object({
  status: z.enum(["OPEN", "PARTIAL", "SETTLED", "CANCELLED", "ALL"]).default("ALL"),
  kind: z.enum(["PAYABLE", "RECEIVABLE", "ALL"]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

export async function listObligations(actor: Actor, query: z.infer<typeof obligationQuerySchema>) {
  const canManage = actor.capabilities.has("obligations.manage");
  if (!canManage) requireCapability(actor, "obligations.pay");
  const staffScope = actor.grantScopes?.get("obligations.pay")?.staffMemberId;
  const items = await rows<{ amountMinor: string | null; settledMinor: string }>(sql`
    select o.id, o.kind::text kind, o.title, o.counterparty_name "counterpartyName",
           o.amount_minor::text "amountMinor", o.amount_state::text "amountState",
           o.currency, o.due_date "dueDate", o.status::text status, o.revision::int revision,
           coalesce((select sum(p.amount_minor) from obligations.obligation_payments p
                      where p.business_id = o.business_id and p.obligation_id = o.id),0)::text "settledMinor",
           o.created_at "createdAt"
      from obligations.expense_obligations o
     where o.business_id = ${actor.businessId}
       ${canManage ? sql`` : sql`and (to_jsonb(o)->>'settlement_id') is not null`}
       ${!canManage && staffScope ? sql`and exists (
         select 1 from econ.settlements s where s.business_id=o.business_id
           and s.id=o.settlement_id and s.staff_member_id::text=${staffScope}
       )` : sql``}
       ${query.status !== "ALL" ? sql`and o.status = ${query.status}` : sql``}
       ${query.kind !== "ALL" ? sql`and o.kind = ${query.kind}` : sql``}
     order by o.created_at desc, o.id desc
     limit ${query.limit}`);
  return items.map((item) => {
    const amountMinor = item.amountMinor === null ? null : exactMinor(item.amountMinor);
    const settledMinor = exactMinor(item.settledMinor);
    return { ...item, amountMinor, settledMinor, ...deriveObligationBalance(amountMinor, settledMinor) };
  });
}

export async function getObligation(actor: Actor, id: string) {
  requireCapability(actor, "obligations.manage");
  return database.client.begin(async (tx) => obligationSnapshot(tx, actor.businessId, id));
}
