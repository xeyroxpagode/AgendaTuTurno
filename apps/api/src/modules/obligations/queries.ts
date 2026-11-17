import { z } from "zod";
import type { Actor } from "../iam/authorization.js";
import { rows, sql } from "../../lib/sql.js";
import { database } from "../../lib/runtime.js";
import { obligationSnapshot } from "./domain.js";
import { requireCapability } from "../h05/domain.js";

export const obligationQuerySchema = z.object({
  status: z.enum(["OPEN", "PARTIAL", "SETTLED", "CANCELLED", "ALL"]).default("ALL"),
  kind: z.enum(["PAYABLE", "RECEIVABLE", "ALL"]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

export async function listObligations(actor: Actor, query: z.infer<typeof obligationQuerySchema>) {
  requireCapability(actor, "obligations.manage");
  return rows(sql`
    select o.id, o.kind::text kind, o.title, o.counterparty_name "counterpartyName",
           o.amount_minor::int "amountMinor", o.amount_state::text "amountState",
           o.currency, o.due_date "dueDate", o.status::text status, o.revision::int revision,
           coalesce((select sum(p.amount_minor)::int from obligations.obligation_payments p
                      where p.business_id = o.business_id and p.obligation_id = o.id),0)::int "settledMinor",
           o.created_at "createdAt"
      from obligations.expense_obligations o
     where o.business_id = ${actor.businessId}
       ${query.status !== "ALL" ? sql`and o.status = ${query.status}` : sql``}
       ${query.kind !== "ALL" ? sql`and o.kind = ${query.kind}` : sql``}
     order by o.created_at desc, o.id desc
     limit ${query.limit}`);
}

export async function getObligation(actor: Actor, id: string) {
  requireCapability(actor, "obligations.manage");
  return database.client.begin(async (tx) => obligationSnapshot(tx, actor.businessId, id));
}
