/**
 * H09 · Composición de bloques. Los estados y la completitud se derivan de
 * fuentes reales; nunca se Inventa un cero para ocultar una fuente caída ni se
 * mezclan criticidades/estados de dominio con `ReadState`.
 */
import {
  DomainError, indicatorDefinitions, indicatorIdSchema,
  reportingCommercialQuerySchema, reportingHistoryQuerySchema, reportingInterventionsQuerySchema,
  reportingOperationalQuerySchema, reportingOwnerSummaryQuerySchema,
  type Capability, type Intervention, type InterventionSeverity
} from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import {
  countState, deniedBlock, makeBlock, reportingRead, requireRole,
  resolveInterval, resolveStaffScope, type CapabilityRequirement
} from "./dto.js";
import {
  readAttendance, readCash, readConflicts, readCourseOccupancy, readCourseSessions,
  readHistory, readMoney, readObligations, readOrders, readSales, readSettlements, readShifts,
  readStock, readUncertain, type IndicatorQuery
} from "./queries.js";

const OWNER_REQUIREMENTS: CapabilityRequirement[] = [
  { capability: "money.create" }, { capability: "sales.create" }, { capability: "cash.open" },
  { capability: "obligations.manage" }, { capability: "economy.settlement.read" },
  { capability: "operations.resolve" }
];
const OPERATIONAL_SHARED: CapabilityRequirement[] = [
  { capability: "bookings.read" }, { capability: "attendance.read.all" },
  { capability: "inventory.read" }, { capability: "orders.read" },
  { capability: "availability.impacts.read" }, { capability: "courses.read" },
  { capability: "economy.settlement.read" }
];
const BARBER_SHARED: CapabilityRequirement[] = [
  { capability: "bookings.self.read" }, { capability: "attendance.read" },
  { capability: "inventory.read" }, { capability: "availability.self.read" },
  { capability: "economy.self.read" }
];
const INTERVENTIONS_SHARED: CapabilityRequirement[] = [
  { capability: "inventory.read" }, { capability: "orders.read" },
  { capability: "availability.impacts.read" }, { capability: "bookings.read" }
];

function destinationFor(type: Intervention["type"], actor: Actor): { destination: string | null; capabilityRequired: string | null } {
  const can = (capability: Capability) => actor.capabilities.has(capability);
  switch (type) {
    case "STOCK_CRITICALITY": return { destination: can("inventory.read") ? "/insumos" : null, capabilityRequired: "inventory.read" };
    case "ORDER_PENDING": return { destination: can("orders.read") ? "/inventario" : null, capabilityRequired: "orders.read" };
    case "OBLIGATION_OVERDUE":
    case "OBLIGATION_UNKNOWN": return { destination: can("obligations.manage") ? "/finanzas" : null, capabilityRequired: "obligations.manage" };
    case "SETTLEMENT_DUE": return actor.role === "BARBER"
      ? { destination: can("economy.self.read") ? "/account/economia" : null, capabilityRequired: "economy.self.read" }
      : { destination: can("economy.settlement.read") ? "/team/economia" : null, capabilityRequired: "economy.settlement.read" };
    case "CASH_DIFFERENCE": return { destination: can("cash.open") ? "/caja" : null, capabilityRequired: "cash.open" };
    case "UNCERTAIN_OPERATION": return { destination: can("operations.resolve") ? "/cobro-incierto" : null, capabilityRequired: "operations.resolve" };
    case "AVAILABILITY_CONFLICT": return { destination: can("bookings.read") || can("bookings.self.read") ? "/agenda" : null, capabilityRequired: "bookings.read" };
    default: return { destination: null, capabilityRequired: null };
  }
}

function intervention(
  actor: Actor, type: Intervention["type"], severity: InterventionSeverity,
  domain: string, objectId: string, detail: string | null, detectedAt: string | null
): Intervention {
  return {
    id: `${actor.businessId}:${type}:${domain}:${objectId}`,
    type, severity, domain, objectId, causeType: type, detail,
    ...destinationFor(type, actor), detectedAt
  };
}

interface InterventionSources {
  stock?: Awaited<ReturnType<typeof readStock>>;
  orders?: Awaited<ReturnType<typeof readOrders>>;
  obligations?: Awaited<ReturnType<typeof readObligations>>;
  settlements?: Awaited<ReturnType<typeof readSettlements>>;
  cash?: Awaited<ReturnType<typeof readCash>>;
  uncertain?: Awaited<ReturnType<typeof readUncertain>>;
  conflicts?: Awaited<ReturnType<typeof readConflicts>>;
}

function deriveInterventions(actor: Actor, sources: InterventionSources): Intervention[] {
  const result: Intervention[] = [];
  for (const item of sources.stock?.items ?? []) {
    if (item.criticality === "OK") continue;
    const severity: InterventionSeverity = item.criticality === "NEGATIVE" || item.criticality === "NO_POSITION"
      ? "HIGH" : item.criticality === "UNCONFIGURED" ? "MEDIUM" : "LOW";
    result.push(intervention(actor, "STOCK_CRITICALITY", severity, "H04 Inventory",
      `${item.sku}:${item.locationId}`, `criticality=${item.criticality} physical=${item.physical}`, null));
  }
  for (const row of sources.orders?.byStatus ?? []) {
    if (!["REQUESTED", "CONFIRMED", "PREPARING", "READY"].includes(row.status) || row.count === 0) continue;
    result.push(intervention(actor, "ORDER_PENDING", row.status === "REQUESTED" ? "HIGH" : "MEDIUM",
      "H06 Orders", row.status, `count=${row.count}`, null));
  }
  for (const row of sources.obligations?.byKind ?? []) {
    if (row.overdueCount > 0) result.push(intervention(actor, "OBLIGATION_OVERDUE", "HIGH",
      "H05 Obligations", row.kind, `overdue=${row.overdueCount} balanceMinor=${row.balanceMinor ?? "null"}`, null));
    if (row.unknownCount > 0) result.push(intervention(actor, "OBLIGATION_UNKNOWN", "MEDIUM",
      "H05 Obligations", row.kind, `unknown=${row.unknownCount}`, null));
  }
  for (const row of sources.settlements?.realDebt ?? []) {
    result.push(intervention(actor, "SETTLEMENT_DUE", "MEDIUM", "H08 Economy",
      `${row.settlementId}:${row.kind}`, `balanceMinor=${row.balanceMinor ?? "null"}`, null));
  }
  for (const row of sources.cash?.currentDifferences ?? []) {
    result.push(intervention(actor, "CASH_DIFFERENCE", "HIGH", "H05 Cash",
      row.cashSessionId, `differenceMinor=${row.amountMinor}`, null));
  }
  for (const item of sources.uncertain?.items ?? []) {
    result.push(intervention(actor, "UNCERTAIN_OPERATION", "HIGH", "H01 System",
      item.operationId, `status=${item.status}`, item.createdAt));
  }
  for (const item of sources.conflicts?.items ?? []) {
    result.push(intervention(actor, "AVAILABILITY_CONFLICT", "HIGH", "H03 Availability",
      item.objectId, `reasonCode=${item.reasonCode}`, item.detectedAt));
  }
  // Identidad causal: una única causa por (dominio, objeto).
  return [...new Map(result.map((item) => [item.id, item])).values()];
}

function sessionCount(data: Awaited<ReturnType<typeof readCourseSessions>>): number {
  return data.byStatus.reduce((sum, row) => sum + row.count, 0);
}

/* ── CAP-09-01 · Resumen del dueño ─────────────────────────────────────── */

export async function ownerSummary(actor: Actor, raw: unknown) {
  requireRole(actor, ["OWNER"]);
  const query = reportingOwnerSummaryQuerySchema.parse(raw);
  return reportingRead(actor, [...OWNER_REQUIREMENTS, { capability: "bookings.read" }, { capability: "inventory.read" },
    { capability: "orders.read" }, { capability: "availability.impacts.read" }], async (tx, context) => {
    const interval = resolveInterval(context, undefined, undefined, query.date);
    const indicator: IndicatorQuery = { interval, limit: 50 };
    const money = await readMoney(tx, actor, indicator);
    const shifts = await readShifts(tx, actor, interval);
    shifts.courseSessions = sessionCount(await readCourseSessions(tx, actor, interval));
    const sources: InterventionSources = {
      stock: await readStock(tx, actor),
      orders: await readOrders(tx, actor, interval),
      obligations: await readObligations(tx, actor, context.today),
      settlements: await readSettlements(tx, actor, indicator),
      cash: await readCash(tx, actor, indicator),
      uncertain: await readUncertain(tx, actor, indicator),
      conflicts: await readConflicts(tx, actor)
    };
    const interventions = deriveInterventions(actor, sources).slice(0, 50);
    return {
      businessTimezone: context.timezone,
      localDate: query.date ?? context.today,
      collectedToday: makeBlock(countState(money.count), money, "COMPLETE", context.asOf, interval.interval),
      shiftsToday: makeBlock("SUCCESS", shifts, "COMPLETE", context.asOf, interval.interval),
      requiresAttention: makeBlock(countState(interventions.length), interventions, "COMPLETE", context.asOf, interval.interval),
      generatedAt: context.asOf
    };
  });
}

/* ── CAP-09-02 · Comercial ─────────────────────────────────────────────── */

export async function commercial(actor: Actor, raw: unknown) {
  requireRole(actor, ["OWNER", "RECEPTIONIST"]);
  const query = reportingCommercialQuerySchema.parse(raw);
  const requirements: CapabilityRequirement[] = actor.role === "OWNER"
    ? OWNER_REQUIREMENTS : [{ capability: "iam.self.read" }];
  return reportingRead(actor, requirements, async (tx, context) => {
    const interval = resolveInterval(context, query.from, query.to);
    // RECEPTIONIST puede ver el detalle de operaciones que gestiona en los
    // endpoints dueños; NO agregados globales. Negativa declarada, no oculta.
    if (actor.role !== "OWNER") {
      return {
        money: deniedBlock(context.asOf, interval.interval),
        sales: deniedBlock(context.asOf, interval.interval),
        cash: deniedBlock(context.asOf, interval.interval),
        obligations: deniedBlock(context.asOf, interval.interval),
        settlements: deniedBlock(context.asOf, interval.interval),
        uncertain: deniedBlock(context.asOf, interval.interval),
        generatedAt: context.asOf
      };
    }
    const indicator: IndicatorQuery = { interval, limit: query.limit };
    const money = await readMoney(tx, actor, indicator, query.paymentMethod);
    const sales = await readSales(tx, actor, indicator);
    const cash = await readCash(tx, actor, indicator);
    const obligations = await readObligations(tx, actor, context.today);
    const settlements = await readSettlements(tx, actor, indicator);
    const uncertain = await readUncertain(tx, actor, indicator);
    const cashAmbiguous = cash.ambiguous;
    return {
      money: makeBlock(countState(money.count), money, "COMPLETE", context.asOf, interval.interval),
      sales: makeBlock(countState(sales.count), sales, "COMPLETE", context.asOf, interval.interval),
      cash: cashAmbiguous
        ? makeBlock("UNKNOWN", cash, "UNKNOWN", context.asOf, interval.interval)
        : makeBlock(cash.expected.length ? "SUCCESS" : "NOT_CONFIGURED", cash,
          cash.expected.length ? "COMPLETE" : "NOT_CONFIGURED", context.asOf, interval.interval),
      obligations: makeBlock(obligations.byKind.length ? "SUCCESS" : "EMPTY", obligations, "COMPLETE", context.asOf, interval.interval),
      settlements: makeBlock(countState(settlements.realDebt.length), settlements, "COMPLETE", context.asOf, interval.interval),
      uncertain: makeBlock("UNKNOWN", uncertain, uncertain.items.length ? "PARTIAL" : "INCOMPLETE", context.asOf, interval.interval),
      generatedAt: context.asOf
    };
  });
}

/* ── CAP-09-03 · Operativo ─────────────────────────────────────────────── */

export async function operational(actor: Actor, raw: unknown) {
  requireRole(actor, ["OWNER", "RECEPTIONIST", "BARBER"]);
  const query = reportingOperationalQuerySchema.parse(raw);
  const staffScope = resolveStaffScope(actor, query.staffMemberId);
  const instructorScope = resolveStaffScope(actor, query.instructorStaffMemberId);
  const requirements = actor.role === "BARBER" ? BARBER_SHARED : OPERATIONAL_SHARED;
  return reportingRead(actor, requirements, async (tx, context) => {
    const interval = resolveInterval(context, query.from, query.to);
    const indicator: IndicatorQuery = { interval, limit: query.limit };
    const denied = () => deniedBlock<never>(context.asOf, interval.interval);
    if (actor.role === "BARBER") {
      const shifts = await readShifts(tx, actor, interval, staffScope.staffMemberId);
      shifts.courseSessions = 0;
      const attendance = await readAttendance(tx, actor, interval, staffScope.staffMemberId);
      const stock = await readStock(tx, actor);
      const conflicts = await readConflicts(tx, actor, staffScope.staffMemberId);
      const economy = await readSettlements(tx, actor, indicator, staffScope.staffMemberId);
      const economyState = economy.realDebt.length ? "SUCCESS" : "ZERO";
      return {
        shifts: makeBlock("SUCCESS", shifts, "PARTIAL", context.asOf, interval.interval),
        attendance: makeBlock(countState(attendance.count), attendance, "PARTIAL", context.asOf, interval.interval),
        stock: makeBlock(countState(stock.items.length), stock, "PARTIAL", context.asOf, interval.interval),
        orders: denied(),
        conflicts: makeBlock(countState(conflicts.count), conflicts, "PARTIAL", context.asOf, interval.interval),
        courses: denied(),
        courseOccupancy: denied(),
        economy: makeBlock(economyState, economy, "PARTIAL", context.asOf, interval.interval),
        generatedAt: context.asOf
      };
    }
    const shifts = await readShifts(tx, actor, interval, staffScope.staffMemberId);
    shifts.courseSessions = sessionCount(await readCourseSessions(tx, actor, interval, instructorScope.staffMemberId));
    const attendance = await readAttendance(tx, actor, interval, staffScope.staffMemberId);
    const stock = await readStock(tx, actor);
    const orders = await readOrders(tx, actor, interval);
    const conflicts = await readConflicts(tx, actor, staffScope.staffMemberId);
    const courses = await readCourseSessions(tx, actor, interval, instructorScope.staffMemberId);
    const occupancy = await readCourseOccupancy(tx, actor, interval, query.limit, query.cursor, instructorScope.staffMemberId);
    const economy = actor.role === "OWNER"
      ? await readSettlements(tx, actor, indicator, staffScope.staffMemberId)
      : { realDebt: [], estimateStates: [] as Array<"NOT_CONFIGURED" | "OPEN_ESTIMATE"> };
    return {
      shifts: makeBlock("SUCCESS", shifts, "COMPLETE", context.asOf, interval.interval),
      attendance: makeBlock(countState(attendance.count), attendance, "COMPLETE", context.asOf, interval.interval),
      stock: makeBlock(countState(stock.items.length), stock, "COMPLETE", context.asOf, interval.interval),
      orders: makeBlock(countState(orders.byStatus.length), orders, "COMPLETE", context.asOf, interval.interval),
      conflicts: makeBlock(countState(conflicts.count), conflicts, "COMPLETE", context.asOf, interval.interval),
      courses: makeBlock(countState(courses.byStatus.length), courses, "COMPLETE", context.asOf, interval.interval),
      courseOccupancy: makeBlock(countState(occupancy.items.length), occupancy, "COMPLETE", context.asOf, interval.interval),
      economy: actor.role === "OWNER"
        ? makeBlock(countState(economy.realDebt.length), economy, "COMPLETE", context.asOf, interval.interval)
        : denied(),
      generatedAt: context.asOf
    };
  });
}

/* ── CAP-09-04 · Intervenciones derivadas (sin persistencia) ───────────── */

export async function interventions(actor: Actor, raw: unknown) {
  requireRole(actor, ["OWNER", "RECEPTIONIST"]);
  const query = reportingInterventionsQuerySchema.parse(raw);
  const requirements: CapabilityRequirement[] = actor.role === "OWNER"
    ? [...INTERVENTIONS_SHARED, { capability: "obligations.manage" }, { capability: "cash.open" },
       { capability: "operations.resolve" }, { capability: "economy.settlement.read" }]
    : INTERVENTIONS_SHARED;
  return reportingRead(actor, requirements, async (tx, context) => {
    const interval = resolveInterval(context);
    const indicator: IndicatorQuery = { interval, limit: query.limit };
    const sources: InterventionSources = {
      stock: await readStock(tx, actor),
      orders: await readOrders(tx, actor, interval),
      conflicts: await readConflicts(tx, actor)
    };
    if (actor.role === "OWNER") {
      sources.obligations = await readObligations(tx, actor, context.today);
      sources.settlements = await readSettlements(tx, actor, indicator);
      sources.cash = await readCash(tx, actor, indicator);
      sources.uncertain = await readUncertain(tx, actor, indicator);
    }
    let items = deriveInterventions(actor, sources);
    if (query.type) items = items.filter((item) => item.type === query.type);
    if (query.severity) items = items.filter((item) => item.severity === query.severity);
    items.sort((a, b) => a.id.localeCompare(b.id));
    if (query.cursor) items = items.filter((item) => item.id > query.cursor!);
    const page = items.slice(0, query.limit);
    return {
      items: page,
      state: countState(page.length),
      completeness: actor.role === "OWNER" ? "COMPLETE" : "PARTIAL",
      asOf: context.asOf,
      interval: interval.interval,
      generatedAt: context.asOf
    };
  });
}

/* ── CAP-09-05 · Historial ─────────────────────────────────────────────── */

export async function history(actor: Actor, raw: unknown) {
  const query = reportingHistoryQuerySchema.parse(raw);
  if (query.type === "OTHER" && !actor.capabilities.has("iam.audit.read")) {
    throw new DomainError("FORBIDDEN", "Audit source requires iam.audit.read", 403);
  }
  const requirements: CapabilityRequirement[] = query.type === "OTHER"
    ? [{ capability: "iam.audit.read" }] : [{ capability: "iam.self.read" }];
  return reportingRead(actor, requirements, async (tx, context) => {
    const interval = resolveInterval(context, query.from, query.to);
    const result = await readHistory(tx, actor, {
      interval, limit: query.limit, cursor: query.cursor, type: query.type,
      objectId: query.objectId, state: query.state
    });
    const destinations: Record<string, string | null> = {
      SALE_CONFIRMED: actor.capabilities.has("sales.correct") ? "/ventas" : null,
      MONEY_CONFIRMED: actor.capabilities.has("money.allocate") ? "/cobro" : null,
      CASH_MOVEMENT: actor.capabilities.has("cash.open") ? "/caja" : null,
      ATTENDANCE: actor.capabilities.has("attendance.read") ? "/attendance" : null,
      RESERVATION_CHANGE: actor.capabilities.has("bookings.read") || actor.capabilities.has("bookings.self.read") ? "/agenda" : null,
      ORDER_TRANSITION: actor.capabilities.has("orders.read") ? "/inventario" : null,
      STOCK_MOVEMENT: actor.capabilities.has("inventory.read") ? "/insumos" : null,
      ECONOMY_EVENT: actor.role === "BARBER" ? "/account/economia" : actor.capabilities.has("economy.settlement.read") ? "/team/economia" : null,
      OTHER: null
    };
    const items = result.items.map((item) => ({ ...item, destination: destinations[item.type] ?? null }));
    return {
      items,
      nextCursor: result.nextCursor,
      state: countState(items.length),
      completeness: result.partial ? "PARTIAL" : "COMPLETE",
      asOf: context.asOf,
      interval: interval.interval,
      generatedAt: context.asOf
    };
  });
}

/* ── CAP-09-06 · Definiciones (sin datos de negocio) ────────────────────── */

export function indicator(id: string) {
  const parsed = indicatorIdSchema.parse(id);
  const definition = indicatorDefinitions[parsed];
  if (!definition) throw new DomainError("NOT_FOUND", "Indicator not found", 404);
  return definition;
}
