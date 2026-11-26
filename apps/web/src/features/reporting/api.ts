import { api } from "@/lib/api/client";

/**
 * H09 · Cliente de Reporting (R4, T-09).
 *
 * Contrato: `R2_API_CONTRACT.md` + addendum V1.1. Los DTO de este archivo
 * reproducen la forma real de `packages/contracts/src/reporting.ts` (módulo
 * que implementa otro agente). Se redeclaran localmente para que el frontend
 * no dependa del `exports` del paquete mientras se integra; la fuente de
 * verdad es ese archivo y cualquier divergencia se corrige en R5.
 *
 * NO hay mocks ni fallbacks productivos. Los seis endpoints son GET con
 * `cache:no-store`, bearer y `x-operation-id`. `from`/`to` son fechas locales;
 * el servidor las convierte en instante con `business.timezone` y `to` es
 * siempre EXCLUSIVO. El cliente no suma importes ni calcula la fecha local.
 */

export type ReadState =
  | "LOADING" | "SUCCESS" | "ZERO" | "EMPTY" | "NOT_APPLICABLE"
  | "NOT_CONFIGURED" | "UNKNOWN" | "ERROR_RECOVERABLE" | "DENIED";

export type Completeness =
  | "COMPLETE" | "PARTIAL" | "INCOMPLETE" | "UNKNOWN" | "NOT_CONFIGURED";

export type Interval = { from: string; to: string; timezone: string };
export type BlockError = { code: string; message: string; recoverable: boolean };

export type Block<T> = {
  state: ReadState;
  data: T | null;
  completeness: Completeness;
  asOf: string | null;
  interval?: Interval;
  error?: BlockError;
};

export type IndicatorId =
  | "M01" | "M02" | "M03" | "M04" | "M05" | "M06" | "M07" | "M08" | "M09"
  | "M10" | "M11" | "M12" | "M13" | "M14" | "M15" | "M16" | "M17";

/* ── DTOs alineados con `packages/contracts/src/reporting.ts` ────────────── */

export type MoneyByMethod = { method: string; amountMinor: string; count: number };

export type MoneyBlockData = {
  totalMinor: string;
  count: number;
  byMethod: MoneyByMethod[];
  refundsMinor: string | null;
  currency: string | null;
};

export type ShiftsBlockData = {
  confirmed: number;
  attended: number;
  cancelled: number;
  noShow: number;
  /** Sesiones de curso: bloque separado, NUNCA dentro de `confirmed`. */
  courseSessions: number;
  byProfessional?: Array<{
    staffMemberId: string;
    confirmed: number;
    attended: number;
    cancelled: number;
    noShow: number;
  }>;
};

export type SalesBlockData = {
  salesMinor: string;
  count: number;
  currency: string | null;
};

export type CashSessionValue = { cashSessionId: string; amountMinor: string };

export type CashBlockData = {
  expected: CashSessionValue[];
  currentDifferences: CashSessionValue[];
  historicalDifferences: CashSessionValue[];
  /** Múltiples observaciones sin regla de supersesión: UNKNOWN, nunca LIMIT 1. */
  ambiguous: boolean;
};

export type ObligationBucket = {
  kind: string;
  pendingCount: number;
  overdueCount: number;
  unknownCount: number;
  balanceMinor: string | null;
};

export type ObligationsBlockData = { byKind: ObligationBucket[] };

export type SettlementDebt = {
  settlementId: string;
  kind: string;
  balanceMinor: string | null;
};

export type SettlementsBlockData = {
  realDebt: SettlementDebt[];
  estimateStates: Array<"NOT_CONFIGURED" | "OPEN_ESTIMATE">;
};

export type UncertainOperation = {
  operationId: string;
  /** STARTED se presenta como PREPARED. */
  status: "PREPARED" | "UNKNOWN";
  command: string;
  createdAt: string;
};

export type UncertainBlockData = { items: UncertainOperation[] };

export type Intervention = {
  id: string;
  type: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  domain: string;
  objectId: string;
  causeType: string;
  detail: string | null;
  /** null cuando el actor no tiene capability de destino. */
  destination: string | null;
  capabilityRequired: string | null;
  detectedAt: string | null;
};

export type StockItem = {
  sku: string;
  locationId: string;
  physical: number;
  minimum: number | null;
  hasPosition: boolean;
  sellable: number;
  criticality: "NEGATIVE" | "NO_POSITION" | "ZERO" | "UNCONFIGURED" | "LOW" | "OK";
};

export type StockBlockData = { items: StockItem[] };

export type OrdersBlockData = { byStatus: Array<{ status: string; count: number }> };

export type ConflictItem = {
  sourceType: string;
  sourceId: string;
  /** Clave causal estable; NO allocation.id. */
  objectId: string;
  reasonCode: string;
  detectedAt: string | null;
};

export type ConflictsBlockData = { count: number; items: ConflictItem[] };

export type CourseSessionsBlockData = { byStatus: Array<{ status: string; count: number }> };

export type CourseOccupancyItem = {
  allocationId: string;
  sessionId: string;
  staffMemberId: string | null;
  localDate: string;
  startsAt: string;
  endsAt: string;
  title: string | null;
};

export type CourseOccupancyBlockData = {
  items: CourseOccupancyItem[];
  nextCursor: string | null;
};

export type HistoryEntry = {
  type: string;
  objectId: string;
  sequence: number | null;
  eventId: string;
  occurredAt: string;
  action: string | null;
  state: string | null;
  destination: string | null;
};

/* ── Respuestas ──────────────────────────────────────────────────────────── */

export type OwnerSummaryResponse = {
  businessTimezone: string;
  localDate: string;
  collectedToday: Block<MoneyBlockData>;
  shiftsToday: Block<ShiftsBlockData>;
  requiresAttention: Block<Intervention[]>;
  generatedAt: string;
};

export type CommercialResponse = {
  money: Block<MoneyBlockData>;
  sales: Block<SalesBlockData>;
  cash: Block<CashBlockData>;
  obligations: Block<ObligationsBlockData>;
  settlements: Block<SettlementsBlockData>;
  uncertain: Block<UncertainBlockData>;
  generatedAt: string;
};

export type OperationalResponse = {
  shifts: Block<ShiftsBlockData>;
  attendance: Block<{ count: number }>;
  stock: Block<StockBlockData>;
  orders: Block<OrdersBlockData>;
  conflicts: Block<ConflictsBlockData>;
  courses: Block<CourseSessionsBlockData>;
  courseOccupancy: Block<CourseOccupancyBlockData>;
  economy: Block<SettlementsBlockData>;
  generatedAt: string;
};

/** El DTO real no incluye `nextCursor` en intervenciones. */
export type InterventionsResponse = {
  items: Intervention[];
  state: ReadState;
  completeness: Completeness;
  asOf: string | null;
  interval?: Interval;
  generatedAt: string;
};

export type HistoryResponse = {
  items: HistoryEntry[];
  nextCursor: string | null;
  state: ReadState;
  completeness: Completeness;
  asOf: string | null;
  interval?: Interval;
  generatedAt: string;
};

export type IndicatorDefinition = {
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
};

/* ── Parámetros de consulta ──────────────────────────────────────────────── */

export type ReportingQuery = {
  /** Fecha local opcional; el servidor resuelve la jornada en su timezone. */
  date?: string;
  from?: string;
  /** Siempre exclusivo. */
  to?: string;
  paymentMethod?: string;
  /** El filtro de URL `status` se traduce a `state` en `/history`. */
  status?: string;
  state?: string;
  cursor?: string;
  limit?: number;
  type?: string;
  objectId?: string;
  staffMemberId?: string;
  severity?: string;
};

/** `x-operation-id` estable: la misma lectura Produce siempre el mismo id. */
function readOperationId(kind: string, query: ReportingQuery): string {
  const parts = Object.keys(query)
    .filter((key) => {
      const value = query[key as keyof ReportingQuery];
      return value !== undefined && value !== "" && value !== null;
    })
    .sort()
    .map((key) => `${key}=${String(query[key as keyof ReportingQuery])}`);
  let hash = 2166136261;
  const source = `h09:${kind}:${parts.join("&")}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `h09-${kind}-${(hash >>> 0).toString(16)}`;
}

function withQuery(path: string, query: ReportingQuery): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key as keyof ReportingQuery];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/** Validación de forma; el servidor es la autoridad de los instantes. */
export function validatePeriod(from: string, to: string): string | null {
  if (!from || !to) return null;
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return "Las fechas deben tener formato YYYY-MM-DD.";
  }
  if (toDate <= fromDate) {
    return "La fecha 'Hasta (exclusivo)' debe ser posterior a 'Desde'.";
  }
  return null;
}

export const reportingApi = {
  ownerSummary: (query: ReportingQuery) =>
    api<OwnerSummaryResponse>(withQuery("/v1/reporting/owner-summary", query), {
      operationId: readOperationId("owner-summary", query),
    }),
  commercial: (query: ReportingQuery) =>
    api<CommercialResponse>(withQuery("/v1/reporting/commercial", query), {
      operationId: readOperationId("commercial", query),
    }),
  operational: (query: ReportingQuery) =>
    api<OperationalResponse>(withQuery("/v1/reporting/operational", query), {
      operationId: readOperationId("operational", query),
    }),
  interventions: (query: ReportingQuery) =>
    api<InterventionsResponse>(withQuery("/v1/reporting/interventions", query), {
      operationId: readOperationId("interventions", query),
    }),
  history: (query: ReportingQuery) =>
    api<HistoryResponse>(withQuery("/v1/reporting/history", query), {
      operationId: readOperationId("history", query),
    }),
  indicator: (id: IndicatorId) =>
    api<IndicatorDefinition>(`/v1/reporting/indicators/${encodeURIComponent(id)}`, {
      operationId: readOperationId(`indicator-${id}`, {}),
    }),
};
