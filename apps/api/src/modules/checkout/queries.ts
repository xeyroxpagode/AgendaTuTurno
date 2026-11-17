import { z } from "zod";
import type { Actor } from "../iam/authorization.js";
import { rows, sql } from "../../lib/sql.js";
import { database } from "../../lib/runtime.js";
import { checkoutSnapshot } from "./domain.js";
import { requireCapability } from "../h05/domain.js";

export const checkoutQuerySchema = z.object({
  status: z.enum(["PENDING", "MONEY_CONFIRMED", "DELIVERED", "DELIVERY_PENDING", "RESOLVED", "FAILED", "UNKNOWN", "ALL"]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

export async function listCheckouts(actor: Actor, query: z.infer<typeof checkoutQuerySchema>) {
  requireCapability(actor, "checkout.create");
  return rows(sql`
    select c.id, c.sale_id "saleId", c.money_operation_id "moneyOperationId", c.status::text status,
           c.total_minor::int "totalMinor", c.confirmed_minor::int "confirmedMinor",
           c.source_reference "sourceReference", c.incident_reason "incidentReason",
           c.operation_id "operationId", c.revision::int revision, c.created_at "createdAt", c.updated_at "updatedAt"
      from checkout.checkouts c
     where c.business_id = ${actor.businessId}
       ${query.status !== "ALL" ? sql`and c.status = ${query.status}` : sql``}
     order by c.created_at desc, c.id desc
     limit ${query.limit}`);
}

export async function getCheckout(actor: Actor, id: string) {
  requireCapability(actor, "checkout.create");
  return database.client.begin(async (tx) => checkoutSnapshot(tx, actor.businessId, id));
}
