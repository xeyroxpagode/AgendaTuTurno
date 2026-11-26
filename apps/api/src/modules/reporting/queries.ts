/**
 * H09 · Proyecciones de lectura. Sin esquema propio, sin tablas agregadas,
 * sin cachés y sin `calculateEstimate` durante la lectura.
 *
 * Todas las funciones reciben la transacción de sólo lectura ya abierta por
 * `reportingRead()`, que revalidó autoridad dentro de la misma Tx. Todo filtro
 * incluye `business_id = actor.businessId`; el scope de profesional se aplica
 * en la propia query, nunca se delega a `require()`.
 */
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";
import type {
  CashBlockData, ConflictsBlockData, CourseOccupancyItem, HistoryEntry,
  MoneyBlockData, ObligationsBlockData, OrdersBlockData, SalesBlockData,
  SettlementsBlockData, ShiftsBlockData, StockBlockData, UncertainBlockData
} from "@youngkingz/contracts";
import type { TimeInterval } from "./dto.js";
import { decodeHistoryCursor, decodeOccupancyCursor, encodeHistoryCursor, encodeOccupancyCursor, type HistoryCursor } from "./dto.js";

export interface IndicatorQuery {
  interval: TimeInterval;
  limit: number;
}

function numeric(value: unknown): number { return Number(value ?? 0); }
function text(value: unknown): string { return String(value ?? ""); }
function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") { try { return JSON.parse(value) as T[]; } catch { return []; } }
  return [];
}

/**
 * Criticidad canónica M09. Orden NEGATIVE → NO_POSITION → ZERO →
 * UNCONFIGURED → LOW/OK: un mínimo NULL nunca se interpreta como cero y una
 * posición ausente nunca se presenta como existencia demostrada de cero.
 */
export function reportingCriticality(
  physical: number, minimum: number | null, hasPosition: boolean
): StockBlockData["items"][number]["criticality"] {
  if (physical < 0) return "NEGATIVE";
  if (!hasPosition) return "NO_POSITION";
  if (physical === 0) return "ZERO";
  if (minimum === null) return "UNCONFIGURED";
  if (physical < minimum) return "LOW";
  return "OK";
}

/* ── M01 / M02 / M04 · una sola lectura ─────────────────────────────────── */

export async function readMoney(
  tx: Tx, actor: Actor, query: IndicatorQuery, paymentMethod?: string
): Promise<MoneyBlockData> {
  const ownOnly = actor.role === "RECEPTIONIST";
  const scope = ownOnly ? tx`and m.actor_account_id=${actor.accountId}` : tx``;
  const methodFilter = paymentMethod ? tx`and c.method=${paymentMethod}` : tx``;
  const rows = await tx<{
    totalMinor: string | number; count: number | string; currency: string | null;
    byMethod: unknown; refundsMinor: string | number | null;
  }[]>`
    with scoped as (
      select m.id, m.operation_id, m.confirmed_minor, m.currency
      from money.money_operations m
      where m.business_id=${actor.businessId} and m.kind='PAYMENT' and m.status='SUCCEEDED'
        and coalesce(m.resolved_at, m.created_at) >= ${query.interval.from}::timestamptz
        and coalesce(m.resolved_at, m.created_at) < ${query.interval.to}::timestamptz
        ${scope}
    ), components as (
      select s.operation_id, c.method, c.amount_minor
      from money.money_components c join scoped s on s.id=c.money_operation_id
      where c.business_id=${actor.businessId} and c.outcome='CONFIRMED' ${methodFilter}
    ), by_method as (
      select method, coalesce(sum(amount_minor),0) minor, count(*)::int component_count
      from components group by method
    ), totals as (
      select
        (case when ${paymentMethod ?? null}::text is null
          then (select coalesce(sum(confirmed_minor),0) from scoped)
          else (select coalesce(sum(amount_minor),0) from components) end)::text "totalMinor",
        (case when ${paymentMethod ?? null}::text is null
          then (select count(distinct operation_id)::int from scoped)
          else (select count(distinct operation_id)::int from components) end)::int "count",
        (select case when count(distinct currency)=1 then min(currency) else null end from scoped) currency
    ), refunds as (
      select coalesce(sum(m.confirmed_minor),0)::text "refundsMinor"
      from money.money_operations m
      where m.business_id=${actor.businessId} and m.kind='REFUND' and m.status='SUCCEEDED'
        and coalesce(m.resolved_at, m.created_at) >= ${query.interval.from}::timestamptz
        and coalesce(m.resolved_at, m.created_at) < ${query.interval.to}::timestamptz
        ${scope}
    )
    select totals."totalMinor", totals."count", totals.currency, refunds."refundsMinor",
           (select coalesce(jsonb_agg(jsonb_build_object('method',method,'minor',minor,'count',component_count) order by method),'[]'::jsonb) from by_method) "byMethod"
    from totals cross join refunds`;
  const row = rows[0];
  return {
    totalMinor: text(row?.totalMinor),
    count: numeric(row?.count),
    byMethod: jsonArray<{ method: string; minor: string | number; count: number }>(row?.byMethod)
      .map((item) => ({ method: text(item.method), amountMinor: text(item.minor), count: numeric(item.count) })),
    refundsMinor: row?.refundsMinor === null || row?.refundsMinor === undefined ? null : text(row.refundsMinor),
    currency: row?.currency ?? null
  };
}

/* ── M03 · Ventas ───────────────────────────────────────────────────────── */

export async function readSales(tx: Tx, actor: Actor, query: IndicatorQuery): Promise<SalesBlockData> {
  const rows = await tx<{ salesMinor: string | number; count: number | string; currency: string | null }[]>`
    select coalesce(sum(s.total_minor),0)::text "salesMinor", count(*)::int "count",
           (case when count(distinct s.currency)=1 then min(s.currency) else null end) currency
    from sales.sales s
    where s.business_id=${actor.businessId} and s.status='CONFIRMED'
      and s.confirmed_at >= ${query.interval.from}::timestamptz and s.confirmed_at < ${query.interval.to}::timestamptz`;
  const row = rows[0];
  return { salesMinor: text(row?.salesMinor), count: numeric(row?.count), currency: row?.currency ?? null };
}

/* ── M05 / M06 · Caja y diferencias ─────────────────────────────────────── */

export async function readCash(tx: Tx, actor: Actor, query: IndicatorQuery): Promise<CashBlockData> {
  const rows = await tx<{ expected: unknown; current: unknown; history: unknown; ambiguous: number | string }[]>`
    with sessions as (
      select s.id, s.opening_amount_minor, s.status, s.counted_amount_minor, s.expected_amount_minor
      from cash.cash_sessions s
      where s.business_id=${actor.businessId}
        and s.opened_at >= ${query.interval.from}::timestamptz and s.opened_at < ${query.interval.to}::timestamptz
    ), expected as (
      select s.id, (s.opening_amount_minor + coalesce(sum(case when mv.type in ('INCOME','SALE_CASH')
        then mv.amount_minor else -mv.amount_minor end),0))::text minor
      from sessions s
      left join cash.cash_movements mv on mv.business_id=${actor.businessId} and mv.cash_session_id=s.id
      group by s.id, s.opening_amount_minor
    ), reconciliations as (
      select r.cash_session_id, r.difference_minor,
             row_number() over (partition by r.cash_session_id order by r.created_at, r.id) rn,
             count(*) over (partition by r.cash_session_id)::int total
      from money.money_reconciliations r join sessions s on s.id=r.cash_session_id
      where r.business_id=${actor.businessId} and s.status='OPEN'
    ), current_differences as (
      select cash_session_id, difference_minor::text minor from reconciliations where rn=1 and total=1
    ), history as (
      select id, (counted_amount_minor - expected_amount_minor)::text minor
      from sessions where status='CLOSED' and counted_amount_minor is not null
    )
    select
      (select coalesce(jsonb_agg(jsonb_build_object('cashSessionId',id,'amountMinor',minor) order by id),'[]'::jsonb) from expected) "expected",
      (select coalesce(jsonb_agg(jsonb_build_object('cashSessionId',cash_session_id,'amountMinor',minor) order by cash_session_id),'[]'::jsonb) from current_differences) "current",
      (select coalesce(jsonb_agg(jsonb_build_object('cashSessionId',id,'amountMinor',minor) order by id),'[]'::jsonb) from history) "history",
      (select count(*)::int from (select cash_session_id from reconciliations where total>1 group by cash_session_id) ambiguous) "ambiguous"`;
  const row = rows[0];
  const parse = (value: unknown) => jsonArray<{ cashSessionId: string; amountMinor: string | number }>(value)
    .map((item) => ({ cashSessionId: text(item.cashSessionId), amountMinor: text(item.amountMinor) }));
  return {
    expected: parse(row?.expected),
    currentDifferences: parse(row?.current),
    historicalDifferences: parse(row?.history),
    ambiguous: numeric(row?.ambiguous) > 0
  };
}

/* ── M11 · Obligaciones ─────────────────────────────────────────────────── */

export async function readObligations(tx: Tx, actor: Actor, today: string): Promise<ObligationsBlockData> {
  const rows = await tx<{
    kind: string; pendingCount: number | string; overdueCount: number | string;
    unknownCount: number | string; balanceMinor: string | number | null;
  }[]>`
    select o.kind::text kind,
           count(*)::int "pendingCount",
           count(*) filter (where o.due_date < ${today}::date)::int "overdueCount",
           count(*) filter (where o.amount_state='UNKNOWN_AMOUNT')::int "unknownCount",
           (coalesce(sum(o.amount_minor - coalesce(paid.total,0)) filter (where o.amount_state='KNOWN'),0))::text "balanceMinor"
    from obligations.expense_obligations o
    left join lateral (select coalesce(sum(p.amount_minor),0) total
      from obligations.obligation_payments p
      where p.business_id=o.business_id and p.obligation_id=o.id) paid on true
    where o.business_id=${actor.businessId} and o.status in ('OPEN','PARTIAL')
    group by o.kind order by o.kind`;
  return { byKind: rows.map((row) => ({
    kind: text(row.kind),
    pendingCount: numeric(row.pendingCount),
    overdueCount: numeric(row.overdueCount),
    unknownCount: numeric(row.unknownCount),
    balanceMinor: numeric(row.unknownCount) > 0 && row.balanceMinor === null ? null : text(row.balanceMinor)
  })) };
}

/* ── M12 / M16 · Liquidaciones reales y estados de dominio ─────────────── */

export async function readSettlements(
  tx: Tx, actor: Actor, query: IndicatorQuery, staffMemberId?: string
): Promise<SettlementsBlockData> {
  const staffFilter = staffMemberId ? tx`and s.staff_member_id=${staffMemberId}` : tx``;
  const debt = await tx<{ settlementId: string; kind: string; balanceMinor: string | number | null }[]>`
    select distinct s.id "settlementId", o.kind::text kind,
           (o.amount_minor - coalesce(paid.total,0))::text "balanceMinor"
    from econ.settlements s
    join obligations.expense_obligations o on o.business_id=s.business_id and o.settlement_id=s.id
    left join lateral (select coalesce(sum(p.amount_minor),0) total
      from obligations.obligation_payments p
      where p.business_id=o.business_id and p.obligation_id=o.id) paid on true
    where s.business_id=${actor.businessId}
      and s.status in ('CLOSED_SNAPSHOT','ADJUSTED')
      and s.period_start >= ${query.interval.from}::timestamptz
      and s.period_end <= ${query.interval.to}::timestamptz
      and o.status in ('OPEN','PARTIAL') ${staffFilter}
    order by s.id, o.kind`;
  const estimates = await tx<{ state: string }[]>`
    select distinct e.state::text state
    from econ.estimates e
    where e.business_id=${actor.businessId}
      and e.period_start >= ${query.interval.from}::timestamptz
      and e.period_end <= ${query.interval.to}::timestamptz
      ${staffMemberId ? tx`and e.staff_member_id=${staffMemberId}` : tx``}
    order by state`;
  return {
    realDebt: debt.map((row) => ({
      settlementId: text(row.settlementId),
      kind: row.kind === "PAYABLE" || row.kind === "RECEIVABLE" ? row.kind : text(row.kind),
      balanceMinor: row.balanceMinor === null ? null : text(row.balanceMinor)
    })),
    estimateStates: estimates.map((row) => text(row.state) as "NOT_CONFIGURED" | "OPEN_ESTIMATE")
  };
}

/* ── M13 · Operaciones inciertas (sin responseBody) ─────────────────────── */

export async function readUncertain(tx: Tx, actor: Actor, query: IndicatorQuery): Promise<UncertainBlockData> {
  const ownOnly = actor.role === "RECEPTIONIST";
  const rows = await tx<{ operationId: string; status: string; command: string; createdAt: string | Date }[]>`
    select a.operation_id "operationId", a.status::text status, a.command_name command,
           a.created_at "createdAt"
    from system.operation_attempts a
    where a.business_id=${actor.businessId} and a.status in ('UNKNOWN','STARTED')
      and a.created_at >= ${query.interval.from}::timestamptz and a.created_at < ${query.interval.to}::timestamptz
      ${ownOnly ? tx`and a.actor_account_id=${actor.accountId}` : tx``}
    order by a.created_at desc, a.operation_id desc
    limit ${query.limit}`;
  return { items: rows.map((row) => ({
    operationId: text(row.operationId),
    status: row.status === "STARTED" ? "PREPARED" as const : "UNKNOWN" as const,
    command: text(row.command),
    createdAt: new Date(row.createdAt).toISOString()
  })) };
}

/* ── M07 / M08 · Turnos y prestaciones ──────────────────────────────────── */

export async function readShifts(
  tx: Tx, actor: Actor, interval: TimeInterval, staffMemberId?: string
): Promise<ShiftsBlockData> {
  const staffFilter = staffMemberId ? tx`and r.staff_member_id=${staffMemberId}` : tx``;
  const rows = await tx<{
    confirmed: number | string; attended: number | string; cancelled: number | string;
    noShow: number | string; byProfessional: unknown;
  }[]>`
    with classified as (
      select r.id, r.staff_member_id, r.status,
        exists(select 1 from attendance.attendances a
          where a.business_id=r.business_id and a.reservation_id=r.id
            and a.status in ('COMPLETED','PARTIAL','INTERRUPTED')) terminal
      from booking.reservations r
      where r.business_id=${actor.businessId}
        and r.business_local_date >= ${interval.fromLocalDate}
        and r.business_local_date < ${interval.toLocalDate}
        ${staffFilter}
    )
    select
      count(*) filter (where status='CONFIRMED' and not terminal)::int confirmed,
      count(*) filter (where status='CONFIRMED' and terminal)::int attended,
      count(*) filter (where status='CANCELLED')::int cancelled,
      count(*) filter (where status='NO_SHOW')::int "noShow",
      (select coalesce(jsonb_agg(jsonb_build_object('staffMemberId',staff_member_id,'confirmed',confirmed,'attended',attended,'cancelled',cancelled,'noShow',no_show) order by staff_member_id),'[]'::jsonb)
        from (select staff_member_id,
                count(*) filter (where status='CONFIRMED' and not terminal)::int confirmed,
                count(*) filter (where status='CONFIRMED' and terminal)::int attended,
                count(*) filter (where status='CANCELLED')::int cancelled,
                count(*) filter (where status='NO_SHOW')::int no_show
              from classified where staff_member_id is not null group by staff_member_id) grouped) "byProfessional"
    from classified`;
  const row = rows[0];
  const byProfessional = jsonArray<{ staffMemberId: string; confirmed: number; attended: number; cancelled: number; noShow: number }>(row?.byProfessional);
  return {
    confirmed: numeric(row?.confirmed), attended: numeric(row?.attended),
    cancelled: numeric(row?.cancelled), noShow: numeric(row?.noShow),
    courseSessions: 0,
    byProfessional: byProfessional.map((item) => ({
      staffMemberId: text(item.staffMemberId), confirmed: numeric(item.confirmed), attended: numeric(item.attended),
      cancelled: numeric(item.cancelled), noShow: numeric(item.noShow)
    }))
  };
}

export async function readAttendance(
  tx: Tx, actor: Actor, interval: TimeInterval, staffMemberId?: string
): Promise<{ count: number }> {
  const rows = await tx<{ count: number | string }[]>`
    select count(*)::int count
    from attendance.attendances a
    where a.business_id=${actor.businessId}
      and a.status in ('COMPLETED','PARTIAL','INTERRUPTED')
      and a.started_at >= ${interval.from}::timestamptz and a.started_at < ${interval.to}::timestamptz
      ${staffMemberId ? tx`and a.attended_by_staff_member_id=${staffMemberId}` : tx``}`;
  return { count: numeric(rows[0]?.count) };
}

/* ── M09 · Stock crítico ────────────────────────────────────────────────── */

export async function readStock(tx: Tx, actor: Actor): Promise<StockBlockData> {
  const barber = actor.role === "BARBER";
  const rows = await tx<{
    sku: string; locationId: string; physical: string | number; minimum: string | number | null;
    hasPosition: boolean; sellable: string | number;
  }[]>`
    with locations as (
      select l.id from inventory.locations l
      where l.business_id=${actor.businessId}
        and (${!barber} or l.staff_member_id is null or l.staff_member_id=${actor.staffMemberId}
          or exists(select 1 from inventory.location_access a
            where a.business_id=l.business_id and a.location_id=l.id and a.staff_member_id=${actor.staffMemberId}))
    ), pairs as (
      select i.sku, l.id "locationId"
      from inventory.items i cross join locations l
      where i.business_id=${actor.businessId} and (${!barber} or i.use<>'SALE')
    ), aggregated as (
      select p.sku, p.location_id "locationId", coalesce(sum(p.physical),0) physical,
             count(*) > 0 "hasPosition"
      from inventory.positions p
      join inventory.items i on i.business_id=p.business_id and i.sku=p.sku
      where p.business_id=${actor.businessId}
        and (${!barber} or (p.purpose='INTERNAL' and i.use<>'SALE'))
        and p.location_id in (select id from locations)
      group by p.sku, p.location_id
    ), sold as (
      select p.sku, p.location_id "locationId", coalesce(sum(p.physical),0) physical
      from inventory.positions p
      where p.business_id=${actor.businessId} and p.purpose='SALE'
      group by p.sku, p.location_id
    ), committed as (
      select c.sku, c.location_id "locationId", coalesce(sum(c.quantity),0) quantity
      from inventory.commitments c
      where c.business_id=${actor.businessId} and c.state='ACTIVE'
      group by c.sku, c.location_id
    )
    select pairs.sku, pairs."locationId",
           coalesce(aggregated.physical,0)::text physical,
           (select m.quantity::text from inventory.minimums m
             where m.business_id=${actor.businessId} and m.sku=pairs.sku
               and m.location_id=pairs."locationId") minimum,
           coalesce(aggregated."hasPosition",false) "hasPosition",
           greatest(0, coalesce(sold.physical,0) - coalesce(committed.quantity,0))::text sellable
    from pairs
    left join aggregated on aggregated.sku=pairs.sku and aggregated."locationId"=pairs."locationId"
    left join sold on sold.sku=pairs.sku and sold."locationId"=pairs."locationId"
    left join committed on committed.sku=pairs.sku and committed."locationId"=pairs."locationId"
    order by pairs.sku, pairs."locationId"`;
  return { items: rows.map((row) => {
    const physical = numeric(row.physical);
    const minimum = row.minimum === null || row.minimum === undefined ? null : numeric(row.minimum);
    const hasPosition = Boolean(row.hasPosition);
    const criticality = reportingCriticality(physical, minimum, hasPosition);
    return {
      sku: text(row.sku), locationId: text(row.locationId), physical,
      minimum, hasPosition, sellable: numeric(row.sellable), criticality
    };
  }) };
}

/* ── M10 · Pedidos ─────────────────────────────────────────────────────── */

export async function readOrders(tx: Tx, actor: Actor, interval: TimeInterval): Promise<OrdersBlockData> {
  const rows = await tx<{ status: string; count: number | string }[]>`
    select o.status::text status, count(*)::int count
    from orders.product_orders o
    where o.business_id=${actor.businessId}
      and o.created_at >= ${interval.from}::timestamptz and o.created_at < ${interval.to}::timestamptz
    group by o.status order by o.status`;
  return { byStatus: rows.map((row) => ({ status: text(row.status), count: numeric(row.count) })) };
}

/* ── M14 · Conflictos ──────────────────────────────────────────────────── */

export async function readConflicts(tx: Tx, actor: Actor, staffMemberId?: string): Promise<ConflictsBlockData> {
  const scope = staffMemberId ? tx`and a.staff_member_id=${staffMemberId}` : tx``;
  const rows = await tx<{
    objectId: string; sourceType: string; sourceId: string; reasonCode: string; detectedAt: string | Date | null;
  }[]>`
    select distinct on (a.source_type, a.source_id)
           a.source_type || ':' || a.source_id::text "objectId",
           a.source_type, a.source_id::text "sourceId", c.reason_code "reasonCode", c.detected_at "detectedAt"
    from availability.commitment_conflicts c
    join availability.resource_allocations a on a.business_id=c.business_id and a.id=c.allocation_id
    where c.business_id=${actor.businessId} and c.status='OPEN'
      and c.reason_code='APPLIED_ABSENCE' and a.status='ACTIVE' ${scope}
    order by a.source_type, a.source_id, c.detected_at desc`;
  return { count: rows.length, items: rows.map((row) => ({
    objectId: text(row.objectId), sourceType: text(row.sourceType), sourceId: text(row.sourceId),
    reasonCode: text(row.reasonCode),
    detectedAt: row.detectedAt === null ? null : new Date(row.detectedAt).toISOString()
  })) };
}

/* ── M15 · Sesiones de curso ───────────────────────────────────────────── */

export async function readCourseSessions(
  tx: Tx, actor: Actor, interval: TimeInterval, instructorStaffMemberId?: string
): Promise<{ byStatus: Array<{ status: string; count: number }> }> {
  const rows = await tx<{ status: string; count: number | string }[]>`
    select s.status::text status, count(*)::int count
    from courses.course_sessions s
    where s.business_id=${actor.businessId}
      and s.local_date >= ${interval.fromLocalDate} and s.local_date < ${interval.toLocalDate}
      ${instructorStaffMemberId ? tx`and s.instructor_staff_member_id=${instructorStaffMemberId}` : tx``}
    group by s.status order by s.status`;
  return { byStatus: rows.map((row) => ({ status: text(row.status), count: numeric(row.count) })) };
}

/* ── Q09-38b · courseOccupancy con cursor PROPIO ───────────────────────── */

export async function readCourseOccupancy(
  tx: Tx, actor: Actor, interval: TimeInterval, limit: number, cursor?: string, staffMemberId?: string
): Promise<{ items: CourseOccupancyItem[]; nextCursor: string | null }> {
  const decoded = cursor ? decodeOccupancyCursor(cursor) : null;
  const cursorFilter = decoded ? tx`
    and (a.visible_start_at, a.id) > (${decoded.startsAt}::timestamptz, ${decoded.allocationId}::uuid)` : tx``;
  type OccupancyRow = {
    allocationId: string; sessionId: string; staffMemberId: string | null;
    localDate: string; startsAt: string | Date; endsAt: string | Date; title: string | null;
  };
  const rows = await tx<OccupancyRow[]>`
    select a.id "allocationId", a.source_id "sessionId", a.staff_member_id "staffMemberId",
           a.local_date "localDate", a.visible_start_at "startsAt", a.visible_end_at "endsAt", c.title
    from availability.resource_allocations a
    join courses.course_sessions s on s.business_id=a.business_id and s.id=a.source_id
    join courses.courses c on c.business_id=s.business_id and c.id=s.course_id
    where a.business_id=${actor.businessId} and a.source_type='COURSE_SESSION' and a.status='ACTIVE'
      ${staffMemberId ? tx`and a.staff_member_id=${staffMemberId}` : tx``}
      and a.local_date >= ${interval.fromLocalDate} and a.local_date < ${interval.toLocalDate}
      ${cursorFilter}
    order by a.visible_start_at asc, a.id asc
    limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((item) => ({
      allocationId: text(item.allocationId), sessionId: text(item.sessionId),
      staffMemberId: item.staffMemberId === null ? null : text(item.staffMemberId),
      localDate: text(item.localDate),
      startsAt: new Date(item.startsAt).toISOString(),
      endsAt: new Date(item.endsAt).toISOString(),
      title: item.title === null ? null : text(item.title)
    })),
    nextCursor: rows.length > limit && last ? encodeOccupancyCursor(new Date(last.startsAt).toISOString(), text(last.allocationId)) : null
  };
}

/* ── M17 · Historial transversal (fuentes propietarias) ────────────────── */

export interface HistoryInput extends IndicatorQuery {
  cursor?: string;
  type?: string;
  objectId?: string;
  state?: string;
}

export async function readHistory(tx: Tx, actor: Actor, input: HistoryInput): Promise<{
  items: HistoryEntry[]; nextCursor: string | null; partial: boolean;
}> {
  const cursor: HistoryCursor | null = input.cursor ? decodeHistoryCursor(input.cursor) : null;
  const scopeStaff = actor.role === "BARBER" ? actor.staffMemberId : null;
  // BARBER también queda limitado a los hechos que él mismo registró: sin
  // esta restricción, ramas SALE/MONEY/CASH quedarían globales para el rol.
  const scopeAccount = actor.role === "BARBER" || actor.role === "RECEPTIONIST" ? actor.accountId : null;
  const allowOther = actor.role === "OWNER" && actor.capabilities.has("iam.audit.read");
  // M17 no es una vista global para todos los roles: cada fuente exige su
  // propia autoridad. `partial` es una etiqueta de completitud, NO un control.
  // OWNER ve todas; RECEPTIONIST ve operaciones que gestionó y dominios
  // operativos; BARBER sólo hechos propios (prestador/instructor/profesional).
  const allowObligations = actor.role === "OWNER";
  const allowOrders = actor.role !== "BARBER";
  const allowStock = actor.role !== "BARBER";

  const selected = await tx<{
    type: string; objectId: string; sequence: number | string | null; eventId: string;
    occurredAt: string | Date; action: string | null; state: string | null;
  }[]>`
    with events(business_id, type, object_id, sequence, event_id, occurred_at, action, event_state) as (
      select s.business_id, 'SALE_CONFIRMED'::text, s.id, null::bigint,
             'sales.sales:'||s.id::text, s.confirmed_at, 'CONFIRMED'::text, 'CONFIRMED'::text
      from sales.sales s
      where s.confirmed_at is not null
        and (${scopeAccount}::uuid is null or s.actor_account_id=${scopeAccount})

      union all
      select m.business_id, 'MONEY_CONFIRMED'::text, m.id, null::bigint,
             'money.money_operations:'||m.id::text, coalesce(m.resolved_at,m.created_at), m.kind, m.status
      from money.money_operations m
      where m.status='SUCCEEDED'
        and (${scopeAccount}::uuid is null or m.actor_account_id=${scopeAccount})

      union all
      select c.business_id, 'CASH_MOVEMENT'::text, c.id, null::bigint,
             'cash.cash_movements:'||c.id::text, c.created_at, c.type, null::text
      from cash.cash_movements c
      where (${scopeAccount}::uuid is null or c.actor_account_id=${scopeAccount})

      union all
      select o.business_id, 'OBLIGATION_CHANGE'::text, o.id, null::bigint,
             'obligations.expense_obligations:'||o.id::text||':created', o.created_at, 'CREATED'::text, null::text
      from obligations.expense_obligations o
      where ${allowObligations}

      union all
      select op.business_id, 'OBLIGATION_CHANGE'::text, op.obligation_id, null::bigint,
             'obligations.obligation_payments:'||op.id::text, op.created_at, op.kind, null::text
      from obligations.obligation_payments op
      where ${allowObligations}

      union all
      select a.business_id, 'ATTENDANCE'::text, a.id, null::bigint,
             'attendance.attendances:'||a.id::text||':started', a.started_at, 'STARTED'::text, null::text
      from attendance.attendances a
      where a.status in ('COMPLETED','PARTIAL','INTERRUPTED')
        and (${scopeStaff}::uuid is null or a.attended_by_staff_member_id=${scopeStaff})

      union all
      select ae.business_id, 'ATTENDANCE'::text, ae.attendance_id, ae.sequence,
             'attendance.attendance_events:'||ae.id::text, ae.occurred_at, ae.event_type, null::text
      from attendance.attendance_events ae
      join attendance.attendances a on a.business_id=ae.business_id and a.id=ae.attendance_id
      where (${scopeStaff}::uuid is null or a.attended_by_staff_member_id=${scopeStaff})

      union all
      select re.business_id, 'RESERVATION_CHANGE'::text, re.reservation_id, re.sequence,
             'booking.reservation_events:'||re.id::text, re.occurred_at, re.event_type, null::text
      from booking.reservation_events re
      join booking.reservations r on r.business_id=re.business_id and r.id=re.reservation_id
      where (${scopeStaff}::uuid is null or r.staff_member_id=${scopeStaff})

      union all
      select t.business_id, 'ORDER_TRANSITION'::text, t."orderId", null::bigint,
             'orders.order_transitions:'||t.id::text, t.occurred_at, t."toStatus", t."toStatus"
      from orders.order_transitions t
      where ${allowOrders}

      union all
      select i.business_id, 'ORDER_TRANSITION'::text, i."orderId", null::bigint,
             'orders.order_incidents:'||i.id::text, i."createdAt", i.kind, i.status
      from orders.order_incidents i
      where ${allowOrders}

      union all
      select r.business_id, 'ORDER_TRANSITION'::text, r."orderId", null::bigint,
             'orders.order_delivery_receipts:'||r.id::text, r."createdAt", 'DELIVERY_RECEIPT'::text, 'DELIVERED'::text
      from orders.order_delivery_receipts r
      where ${allowOrders}

      union all
      select im.business_id, 'STOCK_MOVEMENT'::text, im.id, null::bigint,
             'inventory.movements:'||im.id::text, im.effective_at, im.kind, null::text
      from inventory.movements im
      where ${allowStock}

      union all
      select ce.business_id, 'COURSE_SESSION_EVENT'::text, ce.session_id, null::bigint,
             'courses.course_session_events:'||ce.id::text, ce.created_at, ce.event_type, null::text
      from courses.course_session_events ce
      join courses.course_sessions s on s.business_id=ce.business_id and s.id=ce.session_id
      where (${scopeStaff}::uuid is null or s.instructor_staff_member_id=${scopeStaff})

      union all
      select es.business_id, 'ECONOMY_EVENT'::text, es.id, null::bigint,
             'econ.settlements:'||es.id::text||':closed', es.closed_at, 'CLOSED'::text, es.status
      from econ.settlements es
      where (${scopeStaff}::uuid is null or es.staff_member_id=${scopeStaff})
        and (${scopeAccount}::uuid is null or es.closed_by_account_id=${scopeAccount})

      union all
      select sa.business_id, 'ECONOMY_EVENT'::text, sa.settlement_id, null::bigint,
             'econ.settlement_adjustments:'||sa.id::text, sa.created_at, 'ADJUSTED'::text, 'ADJUSTED'::text
      from econ.settlement_adjustments sa
      join econ.settlements es on es.business_id=sa.business_id and es.id=sa.settlement_id
      where (${scopeStaff}::uuid is null or es.staff_member_id=${scopeStaff})
        and (${scopeAccount}::uuid is null or es.closed_by_account_id=${scopeAccount})

      union all
      select ae.business_id, 'OTHER'::text, ae.id, null::bigint,
             'system.audit_events:'||ae.id::text, ae.occurred_at, ae.action, ae.outcome
      from system.audit_events ae
      where ${allowOther}
        -- Dedupe T3: una fila de audit ya proyectada por las vistas Orders es
        -- ORDER_TRANSITION, no debe repetirse como OTHER (R1_HISTORY §4).
        and not exists (select 1 from orders.order_transitions ot
          where ot.business_id=ae.business_id and ot.id=ae.id)
        and not exists (select 1 from orders.order_incidents oi
          where oi.business_id=ae.business_id and oi.id=ae.id)
        and not exists (select 1 from orders.order_delivery_receipts od
          where od.business_id=ae.business_id and od.id=ae.id)
    ), scoped as (
      select e.* from events e
      where e.business_id=${actor.businessId}
        and e.occurred_at >= ${input.interval.from}::timestamptz
        and e.occurred_at < ${input.interval.to}::timestamptz
        and (${input.type ?? null}::text is null or e.type=${input.type ?? null})
        and (${input.objectId ?? null}::uuid is null or e.object_id=${input.objectId ?? null})
        and (${input.state ?? null}::text is null or e.event_state=${input.state ?? null})
    ), after_cursor as (
      select e.* from scoped e
      where ${cursor?.occurredAt ?? null}::timestamptz is null
        or e.occurred_at < ${cursor?.occurredAt ?? null}::timestamptz
        or (e.occurred_at = ${cursor?.occurredAt ?? null}::timestamptz and (
          e.object_id > ${cursor?.objectId ?? null}::uuid
          or (e.object_id = ${cursor?.objectId ?? null}::uuid and (
            (${cursor?.sequence ?? null}::bigint is not null and e.sequence > ${cursor?.sequence ?? null}::bigint)
            or (${cursor?.sequence ?? null}::bigint is not null and e.sequence is null)
            or (e.sequence is not distinct from ${cursor?.sequence ?? null}::bigint
                and e.event_id collate "C" > ${cursor?.eventId ?? null}::text collate "C")
          ))
        ))
    )
    select e.type, e.object_id::text "objectId", e.sequence::int "sequence", e.event_id "eventId",
           e.occurred_at "occurredAt", e.action, e.event_state "state"
    from after_cursor e
    order by e.occurred_at desc, e.object_id asc, e.sequence asc nulls last, e.event_id collate "C" asc
    limit ${input.limit + 1}`;
  const page = selected.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      type: text(row.type), objectId: text(row.objectId),
      sequence: row.sequence === null || row.sequence === undefined ? null : numeric(row.sequence),
      eventId: text(row.eventId),
      occurredAt: new Date(row.occurredAt).toISOString(),
      action: row.action === null ? null : text(row.action),
      state: row.state === null ? null : text(row.state),
      destination: null
    })),
    nextCursor: selected.length > input.limit && last
      ? encodeHistoryCursor({
        occurredAt: new Date(last.occurredAt).toISOString(),
        objectId: text(last.objectId),
        sequence: last.sequence === null || last.sequence === undefined ? null : numeric(last.sequence),
        eventId: text(last.eventId)
      })
      : null,
    partial: !allowOther || Boolean(scopeStaff) || Boolean(scopeAccount)
  };
}
