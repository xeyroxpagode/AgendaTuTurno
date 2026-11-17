import { z } from "zod";
import type { Actor } from "../iam/authorization.js";
import { rows, sql } from "../../lib/sql.js";
import { database } from "../../lib/runtime.js";
import { cashSnapshot } from "./domain.js";
import { requireCapability } from "../h05/domain.js";

export const cashSessionQuerySchema = z.object({
  status: z.enum(["OPEN", "CLOSED", "ALL"]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

export async function listCashSessions(actor: Actor, query: z.infer<typeof cashSessionQuerySchema>) {
  requireCapability(actor, "cash.open");
  return rows(sql`
    select s.id, s.cashbox_id "cashboxId", b.name "cashboxName", s.status::text status,
           s.opened_by_account_id "openedByAccountId", s.opened_at "openedAt",
           s.opening_amount_minor::int "openingAmountMinor", s.closed_at "closedAt",
           s.counted_amount_minor::int "countedAmountMinor", s.expected_amount_minor::int "expectedAmountMinor",
           s.difference_minor::int "differenceMinor", s.revision::int revision,
           (select coalesce(sum(case when m.type in ('INCOME','SALE_CASH') then m.amount_minor else -m.amount_minor end),0)::int
              from cash.cash_movements m
             where m.business_id = s.business_id and m.cash_session_id = s.id) + s.opening_amount_minor::int "currentExpectedMinor"
      from cash.cash_sessions s
      join cash.cashboxes b on b.business_id = s.business_id and b.id = s.cashbox_id
     where s.business_id = ${actor.businessId}
       ${query.status !== "ALL" ? sql`and s.status = ${query.status}` : sql``}
     order by s.opened_at desc, s.id desc
     limit ${query.limit}`);
}

export async function getCashSnapshot(actor: Actor, cashSessionId: string) {
  requireCapability(actor, "cash.open");
  return database.client.begin(async (tx) => cashSnapshot(tx, actor.businessId, cashSessionId));
}
