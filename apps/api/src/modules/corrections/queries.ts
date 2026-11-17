import { z } from "zod";
import type { Actor } from "../iam/authorization.js";
import { rows, sql } from "../../lib/sql.js";
import { database } from "../../lib/runtime.js";
import { requireCapability } from "../h05/domain.js";

export const correctionQuerySchema = z.object({
  type: z.enum(["COMMERCIAL", "MONETARY", "CASH", "PHYSICAL", "ALL"]).default("ALL"),
  targetId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

export async function listCorrections(actor: Actor, query: z.infer<typeof correctionQuerySchema>) {
  requireCapability(actor, "corrections.create");
  return rows(sql`
    select id, operation_id "operationId", type::text type, target_type::text "targetType",
           target_id "targetId", status::text status, reason, evidence_reference "evidenceReference",
           before_snapshot "before", after_snapshot "after", actor_account_id "actorAccountId",
           created_at "createdAt"
      from corrections.corrections
     where business_id = ${actor.businessId}
       ${query.type !== "ALL" ? sql`and type = ${query.type}` : sql``}
       ${query.targetId ? sql`and target_id = ${query.targetId}` : sql``}
     order by created_at desc, id desc
     limit ${query.limit}`);
}

export async function getCorrection(actor: Actor, id: string) {
  requireCapability(actor, "corrections.create");
  const result = await database.client`
    select id, operation_id "operationId", type::text type, target_type::text "targetType",
           target_id "targetId", status::text status, reason, evidence_reference "evidenceReference",
           before_snapshot "before", after_snapshot "after", actor_account_id "actorAccountId",
           created_at "createdAt"
      from corrections.corrections
     where business_id = ${actor.businessId} and id = ${id}`;
  const row = result[0];
  if (!row) throw new (await import("@youngkingz/contracts")).DomainError("NOT_FOUND", "No encontramos esa corrección en este negocio", 404);
  return row;
}
