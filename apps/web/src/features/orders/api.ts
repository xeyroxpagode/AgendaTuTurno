/**
 * H06 · Cliente HTTP de Orders.
 *
 * CORR-04: este wrapper NO expone `reuseCommitments` ni `sourceReference`.
 * El frontend envía sólo `operationId` v4 y los datos permitidos por el
 * contrato Zod. Reutiliza `formatARS` y `stableOperationId` de H05 sin
 * reescribir el motor financiero.
 */
import { api, ApiError } from "@/lib/api/client";
import { formatARS, stableOperationId, releaseOperationId } from "@/features/finance/api";

export { formatARS };

export type OrderStatus =
  | "REQUESTED" | "CONFIRMED" | "PREPARING" | "READY"
  | "DELIVERED" | "REJECTED" | "CANCELLED";

export type OrderView = {
  id: string;
  businessId: string;
  status: OrderStatus;
  customerKind: "CLIENT" | "GUEST";
  revision: number;
  currency: "ARS";
  totalRequestedMinor: number;
  totalConfirmedMinor: number | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  saleId: string | null;
  checkoutId: string | null;
  lines: Array<{
    id: string; position: number; sku: string; locationId: string | null;
    name: string; quantity: number; unitPriceMinor: number;
    confirmedPriceMinor: number | null; confirmedQuantity: number | null;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type PublicProduct = {
  sku: string; name: string; description: string; category: string;
  imageUrl: string | null; priceMinor: number; currency: "ARS";
  availability: "AVAILABLE";
  variants: Array<{ sku: string; name: string; priceMinor: number }>;
};

type Envelope<T> = { data: T; replayed?: boolean };

const publicBase = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";

async function publicFetch<T>(path: string, init: RequestInit & { credential?: string; operationId?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (init.credential) headers.set("x-order-credential", init.credential);
  if (init.operationId) headers.set("x-operation-id", init.operationId);
  const response = await fetch(`${publicBase}${path}`, { ...init, headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload.error?.code ?? "REQUEST_FAILED", payload.error?.message ?? "No se pudo completar la operación", response.status, payload.error?.details);
  }
  return payload as T;
}

async function withOperation<T>(key: string, call: (operationId: string) => Promise<Envelope<T>>): Promise<Envelope<T>> {
  const operationId = stableOperationId(key);
  try {
    const result = await call(operationId);
    releaseOperationId(key);
    return result;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) releaseOperationId(key);
    throw error;
  }
}

export const ordersApi = {
  /** Catálogo público: sin stock, ubicación ni costos. */
  publicCatalog: (businessId: string) =>
    publicFetch<Envelope<{ items: PublicProduct[]; nextCursor: string | null }>>(
      `/v1/public/businesses/${businessId}/products`
    ),
  publicProduct: (businessId: string, sku: string) =>
    publicFetch<Envelope<PublicProduct>>(`/v1/public/businesses/${businessId}/products/${encodeURIComponent(sku)}`),

  /** Solicitud invitada. La credencial se devuelve UNA sola vez. */
  requestGuest: (input: { businessId: string; lines: Array<{ sku: string; quantity: number }>; contact?: { name: string } }) =>
    withOperation(`order.guest:${input.businessId}:${input.lines.map((l) => l.sku).join(",")}`, (operationId) =>
      publicFetch<Envelope<OrderView & { credential?: { token: string } }>>("/v1/public/orders", {
        method: "POST", operationId, body: JSON.stringify(input)
      })
    ),
  requestStaff: (input: { businessId: string; lines: Array<{ sku: string; quantity: number }> }) =>
    withOperation(`order.staff:${input.businessId}:${input.lines.map((l) => l.sku).join(",")}`, (operationId) =>
      api<Envelope<OrderView>>("/v1/orders", { method: "POST", operationId, body: JSON.stringify(input) })
    ),

  trackGuest: (businessId: string, orderId: string, credential: string) =>
    publicFetch<Envelope<{ id: string; status: OrderStatus; revision: number; lines: unknown[] }>>(
      `/v1/public/orders/${orderId}?businessId=${businessId}`, { credential }
    ),

  list: (query: { status?: string; limit?: number } = {}) =>
    api<Envelope<{ items: OrderView[]; nextCursor: string | null }>>(
      `/v1/orders?status=${query.status ?? "ALL"}&limit=${query.limit ?? 30}`
    ),
  detail: (id: string) => api<Envelope<OrderView>>(`/v1/orders/${id}`),

  confirm: (id: string, expectedRevision: number) =>
    withOperation(`order.confirm:${id}`, (operationId) =>
      api<Envelope<OrderView>>(`/v1/orders/${id}/confirm`, { method: "POST", operationId, body: JSON.stringify({ expectedRevision }) })
    ),
  prepare: (id: string, expectedRevision: number) =>
    withOperation(`order.prepare:${id}`, (operationId) =>
      api<Envelope<OrderView>>(`/v1/orders/${id}/prepare`, { method: "POST", operationId, body: JSON.stringify({ expectedRevision }) })
    ),
  ready: (id: string, expectedRevision: number, verifiedLines: Array<{ sku: string; quantity: number }>) =>
    withOperation(`order.ready:${id}`, (operationId) =>
      api<Envelope<OrderView>>(`/v1/orders/${id}/ready`, { method: "POST", operationId, body: JSON.stringify({ expectedRevision, verifiedLines }) })
    ),
  deliver: (id: string, input: {
    expectedRevision: number;
    receiver: { kind: "CUSTOMER" | "THIRD_PARTY"; name: string; verificationMethod: "CREDENTIAL" | "DOCUMENT" | "STAFF_VERIFIED" };
    components: Array<{ method: "CASH"; amountMinor: number; outcome: "CONFIRMED" }>;
    cashSessionId: string;
  }) => withOperation(`order.deliver:${id}`, (operationId) =>
    api<Envelope<Record<string, unknown>>>(`/v1/orders/${id}/deliver`, { method: "POST", operationId, body: JSON.stringify(input) })
  ),
  cancel: (id: string, expectedRevision: number, reason: string) =>
    withOperation(`order.cancel:${id}`, (operationId) =>
      api<Envelope<OrderView>>(`/v1/orders/${id}/cancel`, { method: "POST", operationId, body: JSON.stringify({ expectedRevision, reason }) })
    ),
  reject: (id: string, expectedRevision: number, reason: string) =>
    withOperation(`order.reject:${id}`, (operationId) =>
      api<Envelope<OrderView>>(`/v1/orders/${id}/reject`, { method: "POST", operationId, body: JSON.stringify({ expectedRevision, reason }) })
    ),
  reissue: (id: string, reason: string) =>
    withOperation(`order.reissue:${id}`, (operationId) =>
      api<Envelope<{ credentialId: string; credential?: { token: string } }>>(`/v1/orders/${id}/credential/reissue`, {
        method: "POST", operationId, body: JSON.stringify({ reason })
      })
    )
};
