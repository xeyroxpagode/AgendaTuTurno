import { z } from "zod";
import { scheduleIntervalSchema, weeklyScheduleWeekSchema, type ScheduleInterval, type WeeklyScheduleWeek } from "@youngkingz/contracts/schedules";

export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}, "Date must be a real YYYY-MM-DD calendar date");

export const replaceBusinessHoursSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  week: weeklyScheduleWeekSchema
}).strict();

export const bookingPolicyValuesSchema = z.object({
  publicBookingEnabled: z.boolean(),
  horizonCalendarDates: z.number().int().min(1).max(366),
  minLeadMinutes: z.number().int().min(0).max(525600),
  startStepMinutes: z.number().int().min(1).max(1440),
  cancelCutoffMinutes: z.number().int().min(0).max(525600),
  rescheduleCutoffMinutes: z.number().int().min(0).max(525600)
}).strict();

export const replaceBookingPolicySchema = bookingPolicyValuesSchema.extend({
  expectedRevision: z.number().int().nonnegative()
}).strict();

export const replaceDateExceptionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500).nullable().optional(),
  intervals: z.array(scheduleIntervalSchema).max(24)
}).strict();

export const professionalPreferenceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ANY") }).strict(),
  z.object({ type: z.literal("SPECIFIC"), staffMemberId: z.string().uuid() }).strict()
]);

export const availabilitySearchSchema = z.object({
  serviceIds: z.array(z.string().uuid()).min(1).max(10).refine(ids => new Set(ids).size === ids.length, "Service IDs must be distinct"),
  fromDate: localDateSchema,
  throughDate: localDateSchema,
  professionalPreference: professionalPreferenceSchema
}).strict();

export const impactKindSchema = z.enum([
  "BUSINESS_HOURS", "BUSINESS_DATE_EXCEPTION", "STAFF_SCHEDULE", "STAFF_DATE_EXCEPTION",
  "STAFF_SERVICES", "STAFF_LIFECYCLE", "EFFECTIVE_UNAVAILABILITY", "OPERATIONAL_BLOCK"
]);

export const impactEvaluationSchema = z.object({
  kind: impactKindSchema,
  staffMemberId: z.string().uuid().optional(),
  localDate: localDateSchema.optional(),
  removedServiceIds: z.array(z.string().uuid()).max(200).default([]),
  proposedIntervals: z.array(scheduleIntervalSchema).max(24).optional()
}).strict();

export type BookingPolicyValues = z.infer<typeof bookingPolicyValuesSchema>;
export type AvailabilitySearchInput = z.infer<typeof availabilitySearchSchema>;
export type ProfessionalPreference = z.infer<typeof professionalPreferenceSchema>;
export type ImpactEvaluationInput = z.infer<typeof impactEvaluationSchema>;

export type BusinessHours = { revision: number; hasConfiguration: boolean; timezone: string; week: WeeklyScheduleWeek };
export type DateException = { id: string; localDate: string; revision: number; reason: string | null; intervals: ScheduleInterval[] };
export type BookingPolicy = BookingPolicyValues & { id: string; revision: number; versionNumber: number; effectiveFrom: string };
export type AvailabilitySlot = { start: string; end: string; occupiedMinutes: number; visibleMinutes: number; staffMemberId?: string };
export type AvailabilityDay = { date: string; slots: AvailabilitySlot[] };

export type ServiceRequirement = {
  id: string; durationMinutes: number; preBufferMinutes: number; postBufferMinutes: number;
};

export type AllocationClaimInput = {
  businessId: string;
  // H07: COURSE_SESSION usa `claimCourseSession` (propio), nunca `claimAllocation`.
  sourceType: "RESERVATION" | "OPERATIONAL_BLOCK" | "COURSE_SESSION";
  sourceId: string;
  serviceIds: string[];
  localDate: string;
  visibleStart: string;
  professionalPreference: ProfessionalPreference;
  historicalTerms?: ServiceRequirement[];
  /**
   * Conserva un turno ya existente (reasignación de profesional): omite el
   * horizonte de alta y la anticipación mínima, que rigen nueva reserva.
   */
  allowPastSlot?: boolean;
};
