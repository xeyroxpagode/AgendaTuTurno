import { z } from "zod";

/** H07 · CAP-07-01..05. DISCOVERY_ONLY: sin alumnos, cupos ni pagos. */

export const courseStatuses = ["DRAFT", "PUBLISHED", "UNPUBLISHED", "CANCELLED"] as const;
export const courseStatusSchema = z.enum(courseStatuses);

export const sessionStatuses = ["SCHEDULED", "CONFIRMED", "RESCHEDULED", "CANCELLED", "COMPLETED"] as const;
export const sessionStatusSchema = z.enum(sessionStatuses);

export const createCourseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(500).optional(),
  description: z.string().trim().max(5000).optional(),
  contactChannel: z.enum(["PHONE", "EMAIL", "WHATSAPP", "NONE"]).default("NONE"),
  contactValue: z.string().trim().max(200).optional()
}).strict();

export const updateCourseSchema = createCourseSchema.partial().extend({
  summary: createCourseSchema.shape.summary.nullable(),
  description: createCourseSchema.shape.description.nullable(),
  contactChannel: createCourseSchema.shape.contactChannel.removeDefault().optional(),
  contactValue: createCourseSchema.shape.contactValue.nullable(),
  revision: z.number().int().positive()
}).strict();

export const scheduleCourseSessionSchema = z.object({
  courseId: z.string().uuid(),
  instructorStaffMemberId: z.string().uuid(),
  // Entrada LOCAL + zona horaria del negocio: con un timestamptz resuelto no
  // es posible detectar DST inexistente/ambiguo (C-H07-04 / NEW-04).
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().min(15).max(480)
}).strict();

export const rescheduleCourseSessionSchema = z.object({
  sessionId: z.string().uuid(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().min(15).max(480),
  revision: z.number().int().positive()
}).strict();

export const publicCourseListSchema = z.object({
  businessId: z.string().uuid()
}).strict();

export const courseSessionHistorySchema = z.object({
  courseId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional()
}).strict().refine((value) => Boolean(value.courseId || value.sessionId), {
  message: "courseId o sessionId es obligatorio"
});

export function parseClockToMinute(clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  return hour! * 60 + minute!;
}
