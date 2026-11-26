import { z } from "zod";
import type { Actor } from "../iam/authorization.js";
import { rows, sql } from "../../lib/sql.js";
import { database } from "../../lib/runtime.js";
import { moneySnapshot } from "./domain.js";
import { requireCapability } from "../h05/domain.js";

export const moneyOperationQuerySchema = z.object({
  status: z.enum(["PROCESSING", "SUCCEEDED", "PROVEN_FAILED", "UNKNOWN", "ALL"]).default("ALL"),
  saleId: z.string().uuid().optional(),
  obligationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

export async function listMoneyOperations(actor: Actor, query: z.infer<typeof moneyOperationQuerySchema>) {
  requireCapability(actor, "money.create");
  return rows(sql`
    select m.id, m.operation_id "operationId", m.kind::text kind, m.status::text status,
           m.sale_id "saleId", m.obligation_id "obligationId", m.refund_of_id "refundOfId",
           m.amount_minor::int "amountMinor", m.confirmed_minor::int "confirmedMinor",
           (m.confirmed_minor-allocated.total-unallocated_refunds.total)::int "availableMinor",
           allocated.total::int "allocatedMinor", refunded.total::int "refundedMinor",
           m.change_minor::int "changeMinor", m.currency, m.payer_name "payerName",
           m.economic_holder_name "economicHolderName", m.created_at "createdAt", m.updated_at "updatedAt"
      from money.money_operations m
      cross join lateral (select coalesce(sum(a.amount_minor),0) total from money.money_allocations a
        where a.business_id=m.business_id and a.money_operation_id=m.id) allocated
      cross join lateral (select coalesce(sum(r.confirmed_minor),0) total from money.money_operations r
        where r.business_id=m.business_id and r.refund_of_id=m.id and r.status='SUCCEEDED') refunded
      cross join lateral (select coalesce(sum(a.amount_minor),0) total from money.refund_attributions a
        join money.money_operations r on r.business_id=a.business_id and r.id=a.refund_id
        where r.business_id=m.business_id and r.refund_of_id=m.id and a.original_allocation_id is null) unallocated_refunds
     where m.business_id = ${actor.businessId}
       ${query.status !== "ALL" ? sql`and m.status = ${query.status}` : sql``}
       ${query.saleId ? sql`and m.sale_id = ${query.saleId}` : sql``}
       ${query.obligationId ? sql`and m.obligation_id = ${query.obligationId}` : sql``}
     order by m.created_at desc, m.id desc
     limit ${query.limit}`);
}

export async function getMoneyOperation(actor: Actor, id: string) {
  requireCapability(actor, "money.create");
  return database.client.begin(async (tx) => moneySnapshot(tx, actor.businessId, id));
}
