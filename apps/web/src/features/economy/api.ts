import { api } from "@/lib/api/client";

const operationId = () => crypto.randomUUID();

export type AgreementVersion = {
  id: string; modality: string; commissionBase: string | null; bps: number | null;
  fixedAmountMinor: number | null; rentAmountMinor: number | null;
  validFrom: string; validTo: string; termsHash: string; status: string;
};
export type Estimate = {
  state: string; payableMinor: string; receivableMinor: string; sourceFingerprint: string;
  agreementVersionId: string | null; termsHash: string | null;
  lines: Array<{ sourceType: string; sourceId: string; component: string; amountMinor: string; versionNote: string }>;
};
export type Settlement = {
  id: string; periodStart: string; periodEnd: string; status: string;
  payableMinor: string; receivableMinor: string; closedAt: string;
};

export const economyApi = {
  agreements: async (staffMemberId: string) => (await api<{ data: AgreementVersion[] }>(`/v1/economy/agreements/${staffMemberId}`)).data,
  createVersion: async (input: Record<string, unknown>) =>
    (await api<{ data: { id: string; version: number } }>("/v1/economy/agreements/versions", { method: "POST", body: JSON.stringify(input), operationId: operationId() })).data,
  estimate: async (staffMemberId: string, from: string, to: string) =>
    (await api<{ data: Estimate }>(`/v1/economy/estimate?${new URLSearchParams({ staffMemberId, from, to })}`)).data,
  close: async (input: Record<string, unknown>) =>
    (await api<{ data: Settlement }>("/v1/economy/settlements/close", { method: "POST", body: JSON.stringify(input), operationId: operationId() })).data,
  history: async (staffMemberId: string) =>
    (await api<{ data: { settlements: Settlement[]; adjustments: Array<{ id: string; amountMinor: string; reason: string; createdAt: string }> } }>(`/v1/economy/settlements/${staffMemberId}/history`)).data,
  adjust: async (input: Record<string, unknown>) =>
    (await api<{ data: { adjustmentId: string } }>("/v1/economy/settlements/adjust", { method: "POST", body: JSON.stringify(input), operationId: operationId() })).data,
  staff: async () => {
    const items = await api<Array<{ id: string; firstName: string; lastName: string; roles: string[] }>>("/v1/staff?status=CURRENT");
    return items.filter((item) => item.roles.includes("BARBER") || item.roles.includes("OWNER"));
  },
  self: async (from: string, to: string) =>
    (await api<{ data: Record<string, unknown> }>(`/v1/economy/me?${new URLSearchParams({ from, to })}`)).data
};

export function formatARS(minor: string | number): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(Number(minor) / 100);
}
