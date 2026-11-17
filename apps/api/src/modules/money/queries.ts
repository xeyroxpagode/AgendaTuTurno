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
    select id, operation_id "operationId", kind::text kind, status::text status,
           sale_id "saleId", obligation_id "obligationId", refund_of_id "refundOfId",
           amount_minor::int "amountMinor", confirmed_minor::int "confirmedMinor",
           change_minor::int "changeMinor", currency, payer_name "payerName",
           economic_holder_name "economicHolderName", created_at "createdAt", updated_at "updatedAt"
      from money.money_operations
     where business_id = ${actor.businessId}
       ${query.status !== "ALL" ? sql`and status = ${query.status}` : sql``}
       ${query.saleId ? sql`and sale_id = ${query.saleId}` : sql``}
       ${query.obligationId ? sql`and obligation_id = ${query.obligationId}` : sql``}
     order by created_at desc, id desc
     limit ${query.limit}`);
}

export async function getMoneyOperation(actor: Actor, id: string) {
  requireCapability(actor, "money.create");
  return database.client.begin(async (tx) => moneySnapshot(tx, actor.businessId, id));
}
