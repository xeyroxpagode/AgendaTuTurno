import { z } from "zod";
import type { Actor } from "../iam/authorization.js";
import { rows, sql } from "../../lib/sql.js";
import { saleSnapshot } from "./domain.js";
import { database } from "../../lib/runtime.js";
import { deriveSaleBalance, requireCapability } from "../h05/domain.js";

/**
 * H05 · CAP-05-01 Sales · consultas.
 * Todo se filtra por el `business_id` del Actor: no hay forma de leer datos
 * de otro negocio (F38).
 */

export const saleQuerySchema = z.object({
  status: z.enum(["DRAFT", "CONFIRMED", "CANCELLED", "ALL"]).default("ALL"),
  balance: z.enum(["PENDING", "PARTIAL", "SETTLED", "ALL"]).default("ALL"),
  attendanceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional()
}).strict();

export async function listSales(actor: Actor, query: z.infer<typeof saleQuerySchema>) {
  requireCapability(actor, "sales.create");
  const items = await rows<{ totalMinor: number; settledMinor: number }>(sql`
    select s.id, s.status::text status, s.source::text source, s.attendance_id "attendanceId",
           s.currency, s.total_minor::int "totalMinor", s.revision::int revision,
           s.confirmed_at "confirmedAt", s.cancelled_at "cancelledAt", s.created_at "createdAt",
           coalesce((
             select sum(a.amount_minor)::int from money.money_allocations a
               join money.money_operations m on m.business_id=a.business_id and m.id=a.money_operation_id
              where a.business_id=s.business_id and a.target_type='SALE' and a.target_id=s.id and m.status='SUCCEEDED'
           ),0)::int "settledMinor",
           (select count(*)::int from sales.sale_lines l where l.business_id=s.business_id and l.sale_id=s.id and l.superseded_at is null)::int "lineCount",
           coalesce((select jsonb_agg(jsonb_build_object('name',l.name,'kind',l.kind,'quantity',l.quantity,
                     'unitPriceMinor',l.unit_price_minor,'lineTotalMinor',l.line_total_minor) order by l.revision,l.position)
              from sales.sale_lines l where l.business_id=s.business_id and l.sale_id=s.id and l.superseded_at is null), '[]'::jsonb) lines
      from sales.sales s
     where s.business_id=${actor.businessId}
       ${query.status !== "ALL" ? sql`and s.status=${query.status}` : sql``}
       ${query.attendanceId ? sql`and s.attendance_id=${query.attendanceId}` : sql``}
       ${query.before ? sql`and s.created_at < ${query.before}` : sql``}
     order by s.created_at desc, s.id desc
     limit ${query.limit}`);
  return items.map((item) => ({ ...item, balance: deriveSaleBalance(item.totalMinor, item.settledMinor) }))
    .filter((item) => query.balance === "ALL" || item.balance === query.balance);
}

export async function getSale(actor: Actor, saleId: string) {
  requireCapability(actor, "sales.create");
  const result = await database.client.begin(async (tx) => saleSnapshot(tx, actor.businessId, saleId));
  return result;
}
