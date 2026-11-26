/**
 * H09 · Contrato de Reporting Global (read-only).
 *
 * Los DTO reproducen EXACTAMENTE los estados de lectura y la forma de `Block`
 * de R2_API_CONTRACT. Ningún importe se expresa como número: `amountMinor`
 * es siempre `string` (bigint minor de H05/H08). Los estados de dominio
 * (`UNCONFIGURED`, `OPEN_ESTIMATE`, criticidades) viajan dentro de `data`,
 * nunca como variantes nuevas de `ReadState`/`completeness`.
 */
import { z } from "zod";

export const readStates = [
  "LOADING", "SUCCESS", "ZERO", "EMPTY", "NOT_APPLICABLE",
  "NOT_CONFIGURED", "UNKNOWN", "ERROR_RECOVERABLE", "DENIED"
] as const;
export type ReadState = (typeof readStates)[number];

export const blockCompletions = ["COMPLETE", "PARTIAL", "INCOMPLETE", "UNKNOWN", "NOT_CONFIGURED"] as const;
export type BlockCompleteness = (typeof blockCompletions)[number];

export interface ReportingInterval {
  /** Instante UTC ISO, límite inferior incluido. */
  from: string;
  /** Instante UTC ISO, límite superior EXCLUSIVO. */
  to: string;
  /** Zona IANA del Business, resuelta en servidor. */
  timezone: string;
}

export interface BlockError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface Block<T> {
  state: ReadState;
  data: T | null;
  completeness: BlockCompleteness;
  asOf: string | null;
  interval?: ReportingInterval;
  error?: BlockError;
}

export interface MoneyByMethod {
  method: string;
  amountMinor: string;
  count: number;
}

export interface MoneyBlockData {
  totalMinor: string;
  count: number;
  byMethod: MoneyByMethod[];
  refundsMinor: string | null;
  currency: string | null;
}

export interface ShiftsByProfessional {
  staffMemberId: string;
  confirmed: number;
  attended: number;
  cancelled: number;
  noShow: number;
}

export interface ShiftsBlockData {
  confirmed: number;
  attended: number;
  cancelled: number;
  noShow: number;
  /** Sesiones de curso: bloque separado, NUNCA dentro de `confirmed`. */
  courseSessions: number;
  byProfessional?: ShiftsByProfessional[];
}

export interface SalesBlockData {
  salesMinor: string;
  count: number;
  currency: string | null;
}

export interface CashSessionValue {
  cashSessionId: string;
  amountMinor: string;
}

export interface CashBlockData {
  expected: CashSessionValue[];
  currentDifferences: CashSessionValue[];
  historicalDifferences: CashSessionValue[];
  /** Múltiples observaciones sin regla de supersesión: UNKNOWN, nunca LIMIT 1 ni suma. */
  ambiguous: boolean;
}

export interface ObligationBucket {
  kind: "PAYABLE" | "RECEIVABLE" | string;
  pendingCount: number;
  overdueCount: number;
  unknownCount: number;
  /** `null` cuando no hay importe conocido; nunca `"0"`. */
  balanceMinor: string | null;
}

export interface ObligationsBlockData {
  byKind: ObligationBucket[];
}

export interface SettlementDebt {
  settlementId: string;
  kind: "PAYABLE" | "RECEIVABLE" | string;
  balanceMinor: string | null;
}

export interface SettlementsBlockData {
  /** Deuda REAL: settlements CLOSED_SNAPSHOT/ADJUSTED + obligaciones abiertas. */
  realDebt: SettlementDebt[];
  /** Estados de dominio; OPEN_ESTIMATE NUNCA se suma como deuda. */
  estimateStates: Array<"NOT_CONFIGURED" | "OPEN_ESTIMATE">;
}

export interface UncertainOperation {
  operationId: string;
  /** STARTED se presenta como PREPARED; nunca SUCCEEDED/FAILED. */
  status: "PREPARED" | "UNKNOWN";
  command: string;
  createdAt: string;
}

export interface UncertainBlockData {
  items: UncertainOperation[];
}

export type InterventionSeverity = "HIGH" | "MEDIUM" | "LOW";
export type InterventionType =
  | "STOCK_CRITICALITY" | "ORDER_PENDING" | "OBLIGATION_OVERDUE"
  | "OBLIGATION_UNKNOWN" | "SETTLEMENT_DUE" | "CASH_DIFFERENCE"
  | "UNCERTAIN_OPERATION" | "AVAILABILITY_CONFLICT";

export interface Intervention {
  /** Identidad causal estable: (business_id, cause_type, domain, object_id). */
  id: string;
  type: InterventionType;
  severity: InterventionSeverity;
  domain: string;
  objectId: string;
  causeType: string;
  detail: string | null;
  /** Ruta CURRENT comprobada; `null` cuando el actor no tiene capability de destino. */
  destination: string | null;
  capabilityRequired: string | null;
  detectedAt: string | null;
}

export interface StockItem {
  sku: string;
  locationId: string;
  physical: number;
  minimum: number | null;
  hasPosition: boolean;
  sellable: number;
  criticality: "NEGATIVE" | "NO_POSITION" | "ZERO" | "UNCONFIGURED" | "LOW" | "OK";
}

export interface StockBlockData {
  items: StockItem[];
}

export interface OrdersBlockData {
  byStatus: Array<{ status: string; count: number }>;
}

export interface ConflictItem {
  sourceType: string;
  sourceId: string;
  /** Clave causal estable; NO allocation.id (cambia al reprogramar). */
  objectId: string;
  reasonCode: string;
  detectedAt: string | null;
}

export interface ConflictsBlockData {
  count: number;
  items: ConflictItem[];
}

export interface CourseSessionsBlockData {
  byStatus: Array<{ status: string; count: number }>;
}

export interface CourseOccupancyItem {
  allocationId: string;
  sessionId: string;
  staffMemberId: string | null;
  localDate: string;
  startsAt: string;
  endsAt: string;
  title: string | null;
}

export interface CourseOccupancyBlockData {
  items: CourseOccupancyItem[];
  nextCursor: string | null;
}

export interface HistoryEntry {
  type: string;
  objectId: string;
  sequence: number | null;
  eventId: string;
  occurredAt: string;
  action: string | null;
  state: string | null;
  destination: string | null;
}

export interface HistoryBlockData {
  items: HistoryEntry[];
  nextCursor: string | null;
}

export interface OwnerSummaryResponse {
  businessTimezone: string;
  localDate: string;
  collectedToday: Block<MoneyBlockData>;
  shiftsToday: Block<ShiftsBlockData>;
  requiresAttention: Block<Intervention[]>;
  generatedAt: string;
}

export interface CommercialResponse {
  money: Block<MoneyBlockData>;
  sales: Block<SalesBlockData>;
  cash: Block<CashBlockData>;
  obligations: Block<ObligationsBlockData>;
  settlements: Block<SettlementsBlockData>;
  uncertain: Block<UncertainBlockData>;
  generatedAt: string;
}

export interface OperationalResponse {
  shifts: Block<ShiftsBlockData>;
  attendance: Block<{ count: number }>;
  stock: Block<StockBlockData>;
  orders: Block<OrdersBlockData>;
  conflicts: Block<ConflictsBlockData>;
  courses: Block<CourseSessionsBlockData>;
  courseOccupancy: Block<CourseOccupancyBlockData>;
  economy: Block<SettlementsBlockData>;
  generatedAt: string;
}

export interface InterventionsResponse {
  items: Intervention[];
  state: ReadState;
  completeness: BlockCompleteness;
  asOf: string | null;
  interval?: ReportingInterval;
  generatedAt: string;
}

export interface HistoryResponse {
  items: HistoryEntry[];
  nextCursor: string | null;
  state: ReadState;
  completeness: BlockCompleteness;
  asOf: string | null;
  interval?: ReportingInterval;
  generatedAt: string;
}

export interface IndicatorDefinition {
  id: string;
  name: string;
  domain: string;
  source: string;
  grain: string;
  formula: string;
  timestampSemantic: string;
  interval: string;
  scopes: string;
  qualityStates: string;
}

export const indicatorIds = [
  "M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09",
  "M10", "M11", "M12", "M13", "M14", "M15", "M16", "M17"
] as const;
export const indicatorIdSchema = z.enum(indicatorIds);
export type IndicatorId = z.infer<typeof indicatorIdSchema>;

/** Definición reproducible: NO contiene datos de negocio ni filtros del actor. */
export const indicatorDefinitions: Readonly<Record<IndicatorId, IndicatorDefinition>> = {
  M01: { id: "M01", name: "Cobrado hoy", domain: "H05 Money", source: "money.money_operations; money.money_components para M04", grain: "una operación monetaria canónica", formula: "SUM(confirmed_minor) WHERE kind='PAYMENT' AND status='SUCCEEDED'; refunds separados", timestampSemantic: "coalesce(resolved_at, created_at)", interval: "[from,to) local, to exclusivo", scopes: "OWNER global; RECEPTIONIST detalle gestionado; BARBER denegado", qualityStates: "COMPLETE|PARTIAL|UNKNOWN|NOT_CONFIGURED" },
  M02: { id: "M02", name: "Cantidad de cobros", domain: "H05 Money", source: "money.money_operations", grain: "una operación", formula: "COUNT(DISTINCT operation_id) PAYMENT/SUCCEEDED", timestampSemantic: "coalesce(resolved_at, created_at)", interval: "[from,to) local, to exclusivo", scopes: "OWNER global; RECEPTIONIST detalle gestionado; BARBER denegado", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M03: { id: "M03", name: "Ventas del período", domain: "H05 Sales", source: "sales.sales", grain: "una venta confirmada", formula: "SUM(total_minor) WHERE status='CONFIRMED'", timestampSemantic: "confirmed_at", interval: "[from,to) local, to exclusivo", scopes: "OWNER; RECEPTIONIST según delegación; BARBER denegado", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M04: { id: "M04", name: "Cobros por medio", domain: "H05 Money", source: "money.money_components JOIN money.money_operations", grain: "componente CONFIRMED por posición", formula: "SUM(amount_minor) GROUP BY method con mismos filtros que M01", timestampSemantic: "coalesce(m.resolved_at, m.created_at)", interval: "[from,to) local, to exclusivo", scopes: "OWNER; RECEPTIONIST detalle gestionado; BARBER denegado", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M05: { id: "M05", name: "Efectivo esperado", domain: "H05 Cash", source: "cash.cash_sessions + cash.cash_movements", grain: "una sesión de caja", formula: "opening + INCOME/SALE_CASH - EXPENSE/CHANGE", timestampSemantic: "opened_at y created_at", interval: "jornada de sesión [from,to)", scopes: "OWNER; RECEPTIONIST opera caja sin agregado global; BARBER denegado", qualityStates: "NOT_CONFIGURED|COMPLETE|UNKNOWN" },
  M06: { id: "M06", name: "Diferencias de caja", domain: "H05 Cash / Money Reconciliation", source: "cash.cash_sessions + money.money_reconciliations", grain: "un conteo/cierre por sesión", formula: "CURRENT OPEN y HISTORY CLOSED separados, nunca sumados", timestampSemantic: "created_at / closed_at", interval: "[from,to) local, to exclusivo", scopes: "OWNER; RECEPTIONIST sin agregado global; BARBER denegado", qualityStates: "COMPLETE|UNKNOWN|NOT_CONFIGURED" },
  M07: { id: "M07", name: "Turnos de hoy", domain: "H03 Booking + Attendance", source: "booking.reservations + attendance.attendances", grain: "una reserva de identidad estable", formula: "buckets mutuamente excluyentes; cursos aparte", timestampSemantic: "business_local_date", interval: "[from,to) local, to exclusivo", scopes: "OWNER/RECEPTIONIST; BARBER self forzado", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M08: { id: "M08", name: "Atenciones realizadas", domain: "H03 Attendance", source: "attendance.attendances", grain: "una atención por attendance.id", formula: "COUNT en estados terminales, incluye walk-in", timestampSemantic: "started_at", interval: "[from,to) local, to exclusivo", scopes: "OWNER/RECEPTIONIST; BARBER propio", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M09: { id: "M09", name: "Stock crítico", domain: "H04 Inventory", source: "inventory.positions + minimums + commitments", grain: "(sku, location)", formula: "NEGATIVE→NO_POSITION→ZERO→UNCONFIGURED→LOW/OK", timestampSemantic: "lectura de positions/version", interval: "snapshot consistente", scopes: "OWNER/RECEPTIONIST con inventory.read; BARBER PARTIAL", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M10: { id: "M10", name: "Pedidos pendientes", domain: "H06 Orders", source: "orders.product_orders", grain: "un pedido por product_orders.id", formula: "COUNT(id) GROUP BY status; READY no es DELIVERED", timestampSemantic: "created_at", interval: "[from,to) local, to exclusivo", scopes: "OWNER/RECEPTIONIST con orders.read; BARBER denegado", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M11: { id: "M11", name: "Obligaciones pendientes y vencidas", domain: "H05 Obligations", source: "expense_obligations + obligation_payments", grain: "una obligación", formula: "saldo por dirección; vencida si due_date < hoy local", timestampSemantic: "due_date DATE", interval: "vigente a now local", scopes: "OWNER; RECEPTIONIST sin manage/pay; BARBER denegado", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M12: { id: "M12", name: "Liquidaciones pendientes", domain: "H08 + H05", source: "econ.settlements + obligations", grain: "settlement cerrado por dirección", formula: "DISTINCT settlement_id+kind; OPEN_ESTIMATE no es deuda", timestampSemantic: "closed_at; due_date DATE", interval: "períodos completos contenidos en [from,to)", scopes: "OWNER; BARBER propio; RECEPTIONIST denegado", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M13: { id: "M13", name: "Operaciones inciertas", domain: "H05 Recovery + H01", source: "system.operation_attempts", grain: "un intento por operation_id", formula: "UNKNOWN/STARTED→PREPARED, sin response_body", timestampSemantic: "created_at", interval: "[from,to) local, to exclusivo", scopes: "OWNER; RECEPTIONIST según permiso; BARBER denegado", qualityStates: "UNKNOWN|INCOMPLETE|PARTIAL" },
  M14: { id: "M14", name: "Conflictos de disponibilidad", domain: "H03 Availability/Absence", source: "availability.commitment_conflicts + resource_allocations", grain: "causa por source_type:source_id", formula: "OPEN + APPLIED_ABSENCE + ACTIVE; sin cancelación automática", timestampSemantic: "detected_at", interval: "vigente al asOf", scopes: "OWNER/RECEPTIONIST; BARBER propio PARTIAL", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M15: { id: "M15", name: "Sesiones de cursos", domain: "H07 Courses", source: "courses.course_sessions", grain: "una sesión por id", formula: "COUNT(id) GROUP BY status por local_date", timestampSemantic: "local_date", interval: "[from,to) local, to exclusivo", scopes: "OWNER/RECEPTIONIST con courses.read; BARBER instructor propio", qualityStates: "COMPLETE|PARTIAL|UNKNOWN" },
  M16: { id: "M16", name: "Economía propia o autorizada", domain: "H08 Staff Economy", source: "econ.agreements + estimates + settlements + obligations", grain: "profesional/período", formula: "deuda real cerrada; estimates como estado, nunca sumados", timestampSemantic: "closed_at / created_at", interval: "períodos completos contenidos en [from,to)", scopes: "BARBER economy.self.read propio; OWNER según scope", qualityStates: "NOT_CONFIGURED|OPEN_ESTIMATE|COMPLETE|UNKNOWN" },
  M17: { id: "M17", name: "Actividad transversal", domain: "Fuentes propietarias + H01 Audit", source: "fuentes de dominio enumeradas en R1_HISTORY", grain: "un hecho por fuente canónica", formula: "UNION autorizado; sin audit_events.changes", timestampSemantic: "timestamp semántico del dominio", interval: "[from,to) local, to exclusivo", scopes: "OWNER por capability; OTHER sólo con iam.audit.read", qualityStates: "COMPLETE|PARTIAL|INCOMPLETE|UNKNOWN" }
};

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Debe ser una fecha local YYYY-MM-DD");
const positiveLimit = z.coerce.number().int().min(1).max(100);

export const reportingIntervalQuerySchema = z.object({
  from: localDate.optional(),
  to: localDate.optional(),
  limit: positiveLimit.default(50),
  cursor: z.string().min(1).optional()
}).refine((value) => !value.from || !value.to || value.to > value.from, {
  message: "`to` debe ser posterior a `from` (intervalo semiabierto [from,to))",
  path: ["to"]
});

export const reportingOwnerSummaryQuerySchema = z.object({ date: localDate.optional() });
export const reportingCommercialQuerySchema = reportingIntervalQuerySchema.extend({
  paymentMethod: z.enum(["CASH", "TRANSFER", "CARD"]).optional(),
  status: z.enum(["ALL", "CONFIRMED", "OPEN"]).default("ALL")
});
export const reportingOperationalQuerySchema = reportingIntervalQuerySchema.extend({
  staffMemberId: z.string().uuid().optional(),
  instructorStaffMemberId: z.string().uuid().optional(),
  status: z.string().max(40).optional()
});
export const reportingInterventionsQuerySchema = z.object({
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  type: z.string().max(60).optional(),
  limit: positiveLimit.default(50),
  cursor: z.string().min(1).optional()
});
export const reportingHistoryQuerySchema = reportingIntervalQuerySchema.extend({
  type: z.string().max(60).optional(),
  objectId: z.string().uuid().optional(),
  state: z.string().max(60).optional()
});

export type ReportingIntervalQuery = z.infer<typeof reportingIntervalQuerySchema>;
export type ReportingCommercialQuery = z.infer<typeof reportingCommercialQuerySchema>;
export type ReportingOperationalQuery = z.infer<typeof reportingOperationalQuerySchema>;
export type ReportingInterventionsQuery = z.infer<typeof reportingInterventionsQuerySchema>;
export type ReportingHistoryQuery = z.infer<typeof reportingHistoryQuerySchema>;
