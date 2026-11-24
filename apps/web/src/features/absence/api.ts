import { api } from "@/lib/api/client";

/**
 * H03.U06 · CAP-03-07 · Ausencias — cliente de API.
 *
 * Cada operación es real contra la API: no hay datos simulados ni atajos.
 */

export type AbsenceStatus = "PENDING" | "APPROVED" | "APPLIED" | "REJECTED" | "WITHDRAWN";

export type AbsenceSummary = {
  id: string;
  businessId: string;
  staffMemberId: string;
  staffMemberName: string | null;
  requestedByAccountId: string;
  localDate: string;
  startMinute: number;
  endMinute: number;
  reason: string | null;
  status: AbsenceStatus;
  revision: number;
  approvedByAccountId: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AbsenceEvent = {
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

export type AbsenceDetail = { absence: AbsenceSummary; events: AbsenceEvent[] };

export type AbsenceConflict = {
  reservationId: string | null;
  courseId: string | null;
  courseTitle: string | null;
  allocationId: string;
  staffMemberId: string;
  localDate: string;
  visibleStartAt: string;
  visibleEndAt: string;
  startsAt: string | null;
  endsAt: string | null;
  customerName: string | null;
  status: string | null;
  revision: number | null;
  serviceNames: string[];
  conflictId: string | null;
  conflictStatus: "OPEN" | "RESOLVED" | null;
  resolutionReference: string | null;
};

export type AbsenceQuery = {
  staffMemberId?: string;
  localDate?: string;
  fromDate?: string;
  toDate?: string;
  status?: "ALL" | AbsenceStatus;
  limit?: number;
};

export type StaffOption = { staffMemberId: string; displayName: string };

export const listAbsences = (query: AbsenceQuery = {}) => {
  const params = new URLSearchParams();
  if (query.staffMemberId) params.set("staffMemberId", query.staffMemberId);
  if (query.localDate) params.set("localDate", query.localDate);
  if (query.fromDate) params.set("fromDate", query.fromDate);
  if (query.toDate) params.set("toDate", query.toDate);
  if (query.status && query.status !== "ALL") params.set("status", query.status);
  params.set("limit", String(query.limit ?? 50));
  return api<{ items: AbsenceSummary[] }>(`/v1/absences?${params.toString()}`);
};

export const getAbsence = (id: string) => api<AbsenceDetail>(`/v1/absences/${id}`);

export const listAbsenceConflicts = (id: string) => api<{ items: AbsenceConflict[] }>(`/v1/absences/${id}/conflicts`);

export const requestAbsence = (body: { staffMemberId: string; localDate: string; startMinute: number; endMinute: number; reason?: string }) =>
  api<{ absenceId: string; status: AbsenceStatus; revision: number }>("/v1/absences", {
    method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify(body)
  });

export const approveAbsence = (id: string, expectedRevision: number) =>
  api<{ absenceId: string; status: AbsenceStatus; revision: number }>(`/v1/absences/${id}/approve`, {
    method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({ expectedRevision })
  });

export const rejectAbsence = (id: string, expectedRevision: number, reason: string) =>
  api<{ absenceId: string; status: AbsenceStatus; revision: number }>(`/v1/absences/${id}/reject`, {
    method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({ expectedRevision, reason })
  });

export const withdrawAbsence = (id: string, expectedRevision: number, reason?: string) =>
  api<{ absenceId: string; status: AbsenceStatus; revision: number }>(`/v1/absences/${id}/withdraw`, {
    method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({ expectedRevision, ...(reason ? { reason } : {}) })
  });

export const applyAbsence = (id: string, expectedRevision: number, resolutionReferences: string[] = []) =>
  api<{ absenceId: string; status: AbsenceStatus; revision: number }>(`/v1/absences/${id}/apply`, {
    method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({ expectedRevision, resolutionReferences })
  });

export const syncAbsenceConflicts = (id: string) =>
  api<{ absenceId: string; conflicts: Array<{ allocationId: string; reservationId: string | null; status: string; resolutionReference: string | null }> }>(`/v1/absences/${id}/conflicts/sync`, {
    method: "POST", operationId: crypto.randomUUID(), body: JSON.stringify({})
  });

/** Profesionales del Business para elegir a quién se solicita la ausencia. */
export async function listAbsenceProfessionals(): Promise<StaffOption[]> {
  const result = await api<{ items: StaffOption[] }>("/v1/schedules/team");
  return result.items;
}
