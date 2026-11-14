import { api } from "@/lib/api/client";

/**
 * H03.U06 · CAP-03-08 · Prestación real — cliente de API.
 *
 * La atención es lo que OCURRIÓ: puede venir de una reserva legítima o ser un
 * walk-in sin reserva. Nunca se simula una reserva para un walk-in.
 */

export type AttendanceStatus = "IN_PROGRESS" | "COMPLETED" | "PARTIAL" | "INTERRUPTED";

export type PerformedService = { name: string; durationMinutes: number; priceMinor?: number; currency?: "ARS" };

export type AttendanceSummary = {
  id: string;
  businessId: string;
  reservationId: string | null;
  staffMemberId: string;
  attendedByStaffMemberId: string;
  attendedByStaffMemberName: string | null;
  clientProfileId: string | null;
  walkIn: boolean;
  status: AttendanceStatus;
  startedAt: string;
  finishedAt: string | null;
  contact: { name: string | null; phone: string | null; email: string | null };
  servicesPerformed: Array<{ name: string; durationMinutes: number; priceMinor: number | null }>;
  reservedServices: Array<{ name: string; durationMinutes: number; priceMinor: number }>;
  notes: string | null;
  revision: number;
  correctionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AttendanceCorrection = {
  id: string;
  changedByAccountId: string;
  changedByName: string | null;
  changedAt: string;
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
  reason: string;
};

export type AttendanceEvent = {
  sequence: number;
  eventType: string;
  principalType: string;
  actorAccountId: string | null;
  occurredAt: string;
  beforeRevision: number | null;
  afterRevision: number | null;
  changes: Record<string, unknown>;
  reasonCode: string | null;
};

export type AttendanceDetail = {
  attendance: AttendanceSummary;
  reservedServices: Array<{ name: string; durationMinutes: number; priceMinor: number }>;
  corrections: AttendanceCorrection[];
  events: AttendanceEvent[];
};

export type AttendanceQuery = {
  staffMemberId?: string;
  status?: "ALL" | AttendanceStatus;
  walkIn?: "ALL" | "ONLY" | "EXCLUDE";
  fromDate?: string;
  toDate?: string;
  limit?: number;
};

export const listAttendances = (query: AttendanceQuery = {}) => {
  const params = new URLSearchParams();
  if (query.staffMemberId) params.set("staffMemberId", query.staffMemberId);
  if (query.status && query.status !== "ALL") params.set("status", query.status);
  if (query.walkIn && query.walkIn !== "ALL") params.set("walkIn", query.walkIn);
  if (query.fromDate) params.set("fromDate", query.fromDate);
  if (query.toDate) params.set("toDate", query.toDate);
  params.set("limit", String(query.limit ?? 50));
  return api<{ items: AttendanceSummary[] }>(`/v1/attendance?${params.toString()}`);
};

export const getAttendance = (id: string) => api<AttendanceDetail>(`/v1/attendance/${id}`);

/** Registro desde una reserva legítima. */
export const registerAttendanceFromReservation = (body: {
  reservationId: string;
  attendedByStaffMemberId?: string;
  servicesPerformedSnapshot?: PerformedService[];
  status?: "COMPLETED" | "PARTIAL" | "INTERRUPTED";
  notes?: string;
}) => api<{ attendanceId: string; status: AttendanceStatus; revision: number }>("/v1/attendance", {
  method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({ ...body, walkIn: false })
});

/** Registro sin reserva (walk-in legítimo): sin Reservation y sin cuenta CLIENT. */
export const registerWalkIn = (body: {
  attendedByStaffMemberId: string;
  contactSnapshot: { name: string; phone: string; email?: string };
  servicesPerformedSnapshot?: PerformedService[];
  status?: "COMPLETED" | "PARTIAL" | "INTERRUPTED";
  notes?: string;
}) => api<{ attendanceId: string; status: AttendanceStatus; revision: number }>("/v1/attendance", {
  method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({ ...body, walkIn: true })
});

export const setAttendanceState = (id: string, body: {
  status: "COMPLETED" | "PARTIAL" | "INTERRUPTED";
  servicesPerformedSnapshot: PerformedService[];
  notes?: string;
  expectedRevision: number;
}) => api<{ attendanceId: string; status: AttendanceStatus; revision: number }>(`/v1/attendance/${id}/state`, {
  method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify(body)
});

export const correctAttendance = (id: string, body: {
  status?: AttendanceStatus;
  servicesPerformedSnapshot?: PerformedService[];
  notes?: string;
  reason: string;
  expectedRevision: number;
}) => api<{ attendanceId: string; status: AttendanceStatus; revision: number }>(`/v1/attendance/${id}/correct`, {
  method: "PATCH", operationId: crypto.randomUUID(), body: JSON.stringify(body)
});

export type StaffOption = { staffMemberId: string; displayName: string };

export async function listAttendanceProfessionals(): Promise<StaffOption[]> {
  const result = await api<{ items: StaffOption[] }>("/v1/schedules/team");
  return result.items;
}
