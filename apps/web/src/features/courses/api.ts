import { api } from "@/lib/api/client";

export type Course = {
  id: string; title: string; summary: string | null; status: string; revision: number; publishedAt: string | null; createdAt: string;
};
export type CourseSession = {
  id: string; courseId: string; instructorStaffMemberId: string; localDate: string;
  localStartMinute: number | null; durationMinutes: number | null; timezone: string;
  occupiedStartAt: string; occupiedEndAt: string; status: string; revision: number;
};
export type CourseEvent = { id: string; eventType: string; changes: unknown; createdAt: string; sessionId: string | null; courseId: string | null };

const operationId = () => crypto.randomUUID();

export const coursesApi = {
  list: async () => (await api<{ data: Course[] }>("/v1/courses")).data,
  sessions: async (courseId: string) => (await api<{ data: CourseSession[] }>(`/v1/courses/${courseId}/sessions`)).data,
  history: async (params: { courseId?: string; sessionId?: string }) =>
    (await api<{ data: CourseEvent[] }>(`/v1/courses/history?${new URLSearchParams({ ...(params.courseId ? { courseId: params.courseId } : {}), ...(params.sessionId ? { sessionId: params.sessionId } : {}) })}`)).data,
  create: async (input: { title: string; summary?: string; description?: string; contactChannel?: string; contactValue?: string }) =>
    (await api<{ data: Course }>("/v1/courses", { method: "POST", body: JSON.stringify(input), operationId: operationId() })).data,
  update: async (id: string, input: Record<string, unknown>) =>
    (await api<{ data: Course }>(`/v1/courses/${id}`, { method: "PATCH", body: JSON.stringify(input), operationId: operationId() })).data,
  publish: async (id: string) => (await api<{ data: Course }>(`/v1/courses/${id}/publish`, { method: "POST", operationId: operationId() })).data,
  unpublish: async (id: string) => (await api<{ data: Course }>(`/v1/courses/${id}/unpublish`, { method: "POST", operationId: operationId() })).data,
  cancel: async (id: string) => (await api<{ data: Course }>(`/v1/courses/${id}/cancel`, { method: "POST", operationId: operationId() })).data,
  schedule: async (courseId: string, input: { instructorStaffMemberId: string; localDate: string; localStart: string; durationMinutes: number }) =>
    (await api<{ data: CourseSession }>(`/v1/courses/${courseId}/sessions`, { method: "POST", body: JSON.stringify({ courseId, ...input }), operationId: operationId() })).data,
  confirm: async (sessionId: string) => (await api<{ data: CourseSession }>(`/v1/course-sessions/${sessionId}/confirm`, { method: "POST", operationId: operationId() })).data,
  reschedule: async (sessionId: string, input: { localDate: string; localStart: string; durationMinutes: number; revision: number }) =>
    (await api<{ data: CourseSession }>(`/v1/course-sessions/${sessionId}/reschedule`, { method: "POST", body: JSON.stringify({ sessionId, ...input }), operationId: operationId() })).data,
  cancelSession: async (sessionId: string) => (await api<{ data: CourseSession }>(`/v1/course-sessions/${sessionId}/cancel`, { method: "POST", operationId: operationId() })).data,
  complete: async (sessionId: string) => (await api<{ data: CourseSession }>(`/v1/course-sessions/${sessionId}/complete`, { method: "POST", operationId: operationId() })).data,
  instructors: async () => {
    const result = await api<{ data: { items: Array<{ staffMemberId: string; effectiveDisplayName: string; status: string; professionallyEnabled: boolean }> } }>("/v1/professionals?limit=100");
    return result.data.items.filter((item) => item.status === "ACTIVE" && item.professionallyEnabled);
  },
  publicList: async (businessId: string) => {
    const base = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";
    const response = await fetch(`${base}/v1/public/businesses/${businessId}/courses`, { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudieron cargar los cursos públicos");
    return (await response.json() as { data: { courses: Array<Record<string, unknown>>; sessions: Array<Record<string, unknown>> } }).data;
  }
};
