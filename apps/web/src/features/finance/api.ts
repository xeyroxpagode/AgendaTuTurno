import { api } from "@/lib/api/client";

/**
 * H05 · cliente API de las superficies Owner/Receptionist.
 *
 * TODA escritura envía `x-operation-id`. El identificador se genera en el
 * cliente y se conserva ante reintentos y recargas (S33): nunca se crea un
 * segundo cobro por refrescar la pantalla.
 */
export type H05Result<T> = { data: T; replayed: boolean };

export type CashSnapshot = {
  cashSessionId: string; cashboxId: string; status: "OPEN" | "CLOSED";
  openedAt: string; openingAmountMinor: number; expectedAmountMinor: number;
  countedAmountMinor: number | null; differenceMinor: number | null;
  closedAt: string | null; reason: string | null; revision: number;
  movements: Array<{ id: string; type: string; amountMinor: number; reason: string; createdAt: string }>;
};

export type SaleView = {
  id: string; status: string; source: string; totalMinor: number; settledMinor: number;
  balance: "PENDING" | "PARTIAL" | "SETTLED"; revision: number;
  createdAt: string; lines: Array<{ name: string; kind: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }>;
};

export type CheckoutView = {
  id: string; status: string; saleId: string; moneyOperationId: string | null;
  totalMinor: number; confirmedMinor: number; balance: string; operationId: string;
  sourceReference: string; revision: number; incidentReason: string | null;
};

export type MoneyView = {
  id: string; operationId: string; status: string; kind: string; amountMinor: number;
  confirmedMinor: number; availableMinor: number; refundedMinor: number;
  components: Array<{ id: string; method: string; outcome: string; amountMinor: number; changeMinor: number; refundOfComponentId?: string | null }>;
  allocations: Array<{ id: string; targetType: string; targetId: string; amountMinor: number }>;
  createdAt: string;
};

export type ObligationView = {
  id: string; kind: string; title: string; counterpartyName: string;
  amountMinor: number | null; amountState: string; balanceMinor: number | null;
  status: string; settledMinor: number; dueDate: string | null; revision: number;
};

export type CorrectionView = {
  id: string; type: string; targetType: string; targetId: string; status: string;
  reason: string; before: unknown; after: unknown; createdAt: string;
};

export type AttemptView = {
  operationId: string; status: string; responseStatus: number | null;
  responseBody: unknown; errorCode: string | null; completedAt: string | null;
};

export const financeApi = {
  cashSessions: () => api<Array<CashSnapshot & { cashboxName: string; currentExpectedMinor: number }>>("/v1/cash/sessions"),
  cashSnapshot: (id: string) => api<CashSnapshot>(`/v1/cash/sessions/${id}/snapshot`),
  openCash: (body: unknown, operationId: string) =>
    api<H05Result<CashSnapshot>>("/v1/cash/sessions", { method: "POST", body: JSON.stringify(body), operationId }),
  closeCash: (id: string, body: unknown, operationId: string) =>
    api<H05Result<CashSnapshot>>(`/v1/cash/sessions/${id}/close`, { method: "PATCH", body: JSON.stringify(body), operationId }),
  cashMovement: (body: unknown, operationId: string) =>
    api<H05Result<CashSnapshot>>("/v1/cash/movements", { method: "POST", body: JSON.stringify(body), operationId }),

  sales: () => api<Array<SaleView & { settledMinor: number }>>("/v1/sales?limit=100"),
  createSale: (body: unknown, operationId: string) =>
    api<H05Result<SaleView>>("/v1/sales", { method: "POST", body: JSON.stringify(body), operationId }),
  confirmSale: (id: string, body: unknown, operationId: string) =>
    api<H05Result<SaleView>>(`/v1/sales/${id}/confirm`, { method: "POST", body: JSON.stringify(body), operationId }),
  cancelSale: (id: string, body: unknown, operationId: string) =>
    api<H05Result<SaleView>>(`/v1/sales/${id}/cancel`, { method: "POST", body: JSON.stringify(body), operationId }),

  checkouts: () => api<CheckoutView[]>("/v1/checkout?limit=100"),
  checkout: (body: unknown, operationId: string) =>
    api<H05Result<CheckoutView>>("/v1/checkout", { method: "POST", body: JSON.stringify(body), operationId }),
  resumeCheckout: (id: string, body: unknown, operationId: string) =>
    api<H05Result<CheckoutView>>(`/v1/checkout/${id}/resume`, { method: "POST", body: JSON.stringify(body), operationId }),
  getCheckout: (id: string) => api<CheckoutView>(`/v1/checkout/${id}`),

  moneyOperations: () => api<Array<MoneyView>>("/v1/money/operations?limit=100"),
  moneyOperation: (id: string) => api<MoneyView>(`/v1/money/operations/${id}`),
  refund: (id: string, body: unknown, operationId: string) =>
    api<H05Result<MoneyView>>(`/v1/money/operations/${id}/refund`, { method: "POST", body: JSON.stringify(body), operationId }),
  resolve: (id: string, body: unknown, operationId: string) =>
    api<H05Result<MoneyView>>(`/v1/money/operations/${id}/resolve`, { method: "POST", body: JSON.stringify(body), operationId }),

  obligations: () => api<ObligationView[]>("/v1/obligations?limit=100"),
  createObligation: (body: unknown, operationId: string) =>
    api<H05Result<ObligationView>>("/v1/obligations", { method: "POST", body: JSON.stringify(body), operationId }),
  payObligation: (id: string, body: unknown, operationId: string) =>
    api<H05Result<ObligationView>>(`/v1/obligations/${id}/pay`, { method: "POST", body: JSON.stringify(body), operationId }),
  settleObligation: (id: string, body: unknown, operationId: string) =>
    api<H05Result<ObligationView>>(`/v1/obligations/${id}/settle`, { method: "POST", body: JSON.stringify(body), operationId }),

  corrections: () => api<CorrectionView[]>("/v1/corrections?limit=100"),
  createCorrection: (body: unknown, operationId: string) =>
    api<H05Result<{ correctionId: string }>>("/v1/corrections", { method: "POST", body: JSON.stringify(body), operationId }),

  operationStatus: (id: string) => api<AttemptView>(`/v1/operations/${id}`),
  inventory: () => api<{ items: Array<{ sku: string; name: string; priceMinor: number | null; sellable: number }>; locations: Array<{ id: string; name: string }> }>("/v1/inventory")
};

/** Genera un operation_id v4 estable y lo conserva en sessionStorage. */
export function stableOperationId(key: string): string {
  if (typeof window === "undefined") return crypto.randomUUID();
  const storageKey = `yk-h05-op:${key}`;
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, fresh);
  return fresh;
}

/** Descarta el operation_id tras un éxito verificado para no reutilizarlo. */
export function releaseOperationId(key: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(`yk-h05-op:${key}`);
}

export function formatARS(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "—";
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  return `${sign}$${Math.floor(absolute / 100).toLocaleString("es-AR")},${String(absolute % 100).padStart(2, "0")}`;
}
