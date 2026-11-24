import { api } from "@/lib/api/client";

export type AgendaItem = {
  id: string;
  status: string;
  revision: number;
  staffMemberId: string;
  startsAt: string;
  endsAt: string;
  localDate: string;
  commercialTotalMinor: number;
  currency: string;
  ownerType: string;
  customerName: string | null;
  serviceNames: string[];
  arrivedAt: string | null;
  noShowAt: string | null;
};
export type AgendaCourse = { id: string; staffMemberId: string; startsAt: string; endsAt: string; localDate: string; title: string };
export type AgendaDetail = {
  reservation: {
    id: string; status: string; revision: number; staffMemberId: string;
    startsAt: string; endsAt: string; localDate: string; businessTimezone: string;
    commercialTotalMinor: number; currency: string; ownerType: string;
    customerName: string | null; noShowAt: string | null; cancelledAt: string | null;
    contact: { name: string | null; phone: string | null; email: string | null };
    serviceNames: string[]; arrivedAt: string | null;
  };
  items: Array<{ position: number; serviceId: string; serviceName: string; durationMinutes: number; priceMinor: number; currency: string }>;
  events: Array<{ sequence: number; eventType: string; principalType: string; actorAccountId: string | null; occurredAt: string; beforeRevision: number | null; afterRevision: number | null; changes: Record<string, unknown>; reasonCode: string | null }>;
};

export type AgendaQuery = {
  fromDate?: string;
  toDate?: string;
  status?: "ALL" | "CONFIRMED" | "CANCELLED" | "NO_SHOW";
  staffMemberId?: string;
  cursor?: string;
  limit?: number;
};

export type AgendaContext = { businessId: string; role: string; capabilities: string[] };

export const getAgendaContext = () => api<AgendaContext>("/v1/iam/context");

export async function listAgenda(query: AgendaQuery = {}) {
  const params = new URLSearchParams();
  if (query.fromDate) params.set("fromDate", query.fromDate);
  if (query.toDate) params.set("toDate", query.toDate);
  if (query.status && query.status !== "ALL") params.set("status", query.status);
  if (query.staffMemberId) params.set("staffMemberId", query.staffMemberId);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  const suffix = params.toString();
  return api<{ items: AgendaItem[]; courseOccupancy?: AgendaCourse[]; nextCursor: string | null }>(`/v1/staff/bookings${suffix ? `?${suffix}` : ""}`);
}

export const getAgendaReservation = (id: string) => api<AgendaDetail>(`/v1/staff/bookings/${id}`);

export const createAgendaReservation = (body: {
  serviceIds: string[];
  localDate: string;
  visibleStart: string;
  professionalPreference: { type: "ANY" } | { type: "SPECIFIC"; staffMemberId: string };
  contact: { name: string; phone: string; email?: string };
  reason?: string;
}) => api<{ reservationId: string; status: string; startsAt: string; endsAt: string; staffMemberId: string; commercialTotalMinor: number }>("/v1/staff/bookings", {
  method: "POST",
  operationId: crypto.randomUUID(),
  body: JSON.stringify(body),
});

export const registerArrival = (id: string, expectedRevision: number, arrivalMethod?: "PRESENCIAL" | "TELEFONICO") =>
  api<{ reservationId: string; status: string; arrivedAt: string; revision: number }>(`/v1/staff/bookings/${id}/arrival`, {
    method: "POST",
    operationId: crypto.randomUUID(),
    body: JSON.stringify({ expectedRevision, arrivalMethod }),
  });

export const confirmNoShow = (id: string, expectedRevision: number, reason?: string) =>
  api<{ reservationId: string; status: string; noShowAt: string; released: boolean; revision: number }>(`/v1/staff/bookings/${id}/no-show`, {
    method: "POST",
    operationId: crypto.randomUUID(),
    body: JSON.stringify({ expectedRevision, reason }),
  });

export const reassignReservation = (id: string, expectedRevision: number, staffMemberId: string, reason: string) =>
  api<{ reservationId: string; status: string; staffMemberId: string; startsAt: string; endsAt: string; revision: number }>(`/v1/staff/bookings/${id}/reassign`, {
    method: "POST",
    operationId: crypto.randomUUID(),
    body: JSON.stringify({ expectedRevision, staffMemberId, reason }),
  });

export const overrideCancelReservation = (id: string, expectedRevision: number, reason: string) =>
  api<{ reservationId: string; status: string; cancelledAt: string; released: boolean }>(`/v1/staff/bookings/${id}/override-cancel`, {
    method: "POST",
    operationId: crypto.randomUUID(),
    body: JSON.stringify({ expectedRevision, reason }),
  });

export const overrideRescheduleReservation = (id: string, body: {
  expectedRevision: number;
  localDate: string;
  visibleStart: string;
  professionalPreference?: { type: "ANY" } | { type: "SPECIFIC"; staffMemberId: string };
  reason: string;
}) => api<{ reservationId: string; status: string; startsAt: string; endsAt: string }>(`/v1/staff/bookings/${id}/override-reschedule`, {
  method: "POST",
  operationId: crypto.randomUUID(),
  body: JSON.stringify(body),
});

export type ProfessionalOption = { staffMemberId: string; displayName: string };

export async function listAgendaProfessionals(): Promise<ProfessionalOption[]> {
  const result = await api<{ items: ProfessionalOption[] }>("/v1/schedules/team");
  return result.items;
}

export type ServiceOption = { id: string; name: string; lifecycle: string; publication: string };

export async function listAgendaServices(): Promise<ServiceOption[]> {
  const result = await api<{ items: ServiceOption[] }>("/v1/catalog/services?limit=100");
  return result.items;
}
