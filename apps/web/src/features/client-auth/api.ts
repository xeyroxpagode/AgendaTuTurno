import { api } from "@/lib/api/client";
import type { ClientMeResponse, ClientStatusResponse } from "@youngkingz/contracts";

export type ClientReservation = {
  id: string;
  businessId: string;
  status: "CONFIRMED" | "CANCELLED";
  revision: number;
  staffMemberId: string;
  startsAt: string;
  endsAt: string;
  total: number;
  currency: string;
  localDate: string;
  businessName?: string;
  /** Zona horaria congelada de la reserva (snapshot histórico del Business). */
  businessTimezone: string;
};

export type ClientReservationDetail = {
  reservation: ClientReservation;
  items: Array<{ position: number; serviceId: string; name: string; durationMinutes: number; priceMinor: number; currency: string }>;
  events: Array<{ sequence: number; eventType: string; principalType: string; occurredAt: string }>;
};

/** Resultado de confirmación CLIENT: misma forma que U04, sin credencial de invitado. */
export type ClientConfirmResult = {
  reservationId: string;
  status: "CONFIRMED";
  startsAt: string;
  endsAt: string;
  staffMemberId: string;
  commercialTotalMinor: number;
  currency: string;
  businessLocalDate: string;
  operationId: string;
  guestCredentialIssued: boolean;
  replayed: boolean;
};

/** Disponibilidad pública usada por el reprogramado del cliente. */
export type ClientAvailabilitySearch = {
  business: { id: string; timezone: string };
  days: Array<{ date: string; slots: Array<{ start: string; end: string; occupiedMinutes: number; visibleMinutes: number }> }>;
};

export const clientApi = {
  status: () => api<ClientStatusResponse>("/v1/client-auth/status"),
  bootstrap: (input: { firstName: string; lastName?: string }) => api<{ accountId: string; revision: number }>("/v1/client-auth/bootstrap", { method: "POST", body: JSON.stringify(input) }),
  issueCodes: (expectedRevision: number) => api<{ batchVersion: number; codes: string[]; revision: number }>("/v1/client-auth/recovery-codes/issue", { method: "POST", body: JSON.stringify({ expectedRevision }) }),
  acknowledgeCodes: (batchVersion: number, expectedRevision: number) => api("/v1/client-auth/recovery-codes/ack", { method: "POST", body: JSON.stringify({ batchVersion, expectedRevision }) }),
  recover: (recoveryCode: string, newPassword: string) => api("/v1/client-auth/recovery/complete", { method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({ recoveryCode, newPassword }) }),
  me: () => api<ClientMeResponse>("/v1/client/me"),
  security: () => api<{ revision: number; recoveryCodesVersion: number; mfaEnrolledAt: string }>("/v1/client/me/security"),
  sessions: () => api<{ items: Array<{ id: string; current: boolean; createdAt: string; lastSeenAt: string; expiresAt: string }> }>("/v1/client/me/sessions"),
  revokeSessions: (scope: "CURRENT" | "OTHERS" | "ALL") => api<{ revoked: number }>("/v1/client/me/sessions/revoke", { method: "POST", body: JSON.stringify({ scope }) }),
  links: () => api<Array<{ id: string; businessId: string; clientProfileId: string; businessName: string; linkedAt: string }>>("/v1/client/me/links"),
  startPhoneChange: (newPhone: string, expectedRevision: number) => api("/v1/client-auth/phone-change/start", { method: "POST", body: JSON.stringify({ newPhone, expectedRevision }) }),
  confirmPhoneChange: (expectedRevision: number) => api("/v1/client-auth/phone-change/confirm", { method: "POST", body: JSON.stringify({ expectedRevision }) }),
  changePassword: (currentPassword: string, newPassword: string, expectedRevision: number) => api("/v1/client-auth/password-change", { method: "POST", body: JSON.stringify({ currentPassword, newPassword, expectedRevision }) }),
  reservations: () => api<ClientReservation[]>("/v1/client/reservations"),
  reservation: (id: string) => api<ClientReservationDetail>(`/v1/client/reservations/${id}`),
  cancelReservation: (id: string, expectedRevision: number, reason?: string) => api<{ reservationId: string; status: "CANCELLED"; cancelledAt: string; released: boolean; replayed: boolean }>(`/v1/client/reservations/${id}/cancel`, { method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({ expectedRevision, ...(reason ? { reason } : {}) }) }),
  rescheduleReservation: (id: string, expectedRevision: number, localDate: string, visibleStart: string) => api<{ reservationId: string; status: "CONFIRMED"; startsAt: string; endsAt: string; replayed: boolean }>(`/v1/client/reservations/${id}/reschedule`, { method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({ expectedRevision, localDate, visibleStart }) }),
  confirmReservation: (quote: string) => api<ClientConfirmResult>("/v1/client/reservations", { method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({ quote, acceptTerms: true }) }),
  availabilitySearch: (businessId: string, input: { serviceIds: string[]; fromDate: string; throughDate: string; professionalPreference: { type: "ANY" } | { type: "SPECIFIC"; staffMemberId: string } }) => api<ClientAvailabilitySearch>(`/v1/public/businesses/${businessId}/availability/search`, { method: "POST", body: JSON.stringify(input) }),
  associateGuestReservation: (id: string, guestToken: string) => api<{ reservationId: string; ownerType: "CLIENT"; guestAccess: "REVOKED" }>(`/v1/client/reservations/${id}/associate`, { method: "POST", operationId: crypto.randomUUID(), headers: { "x-guest-token": guestToken }, body: JSON.stringify({}) })
};
