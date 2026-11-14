import { z } from "zod";

export const clientIdentityStatuses = ["PENDING_MFA", "RECOVERY_SETUP_REQUIRED", "ACTIVE", "RECOVERY_REQUIRED", "RESTRICTED"] as const;
export const clientIdentityStatusSchema = z.enum(clientIdentityStatuses);
export type ClientIdentityStatus = z.infer<typeof clientIdentityStatusSchema>;

export const clientOperationalStatuses = ["PHONE_VERIFICATION_REQUIRED", "BOOTSTRAP_REQUIRED", "MFA_SETUP_REQUIRED", "RECOVERY_CODES_REQUIRED", "ACTIVE", "RECOVERY_REQUIRED", "RESTRICTED"] as const;
export const clientOperationalStatusSchema = z.enum(clientOperationalStatuses);
export type ClientOperationalStatus = z.infer<typeof clientOperationalStatusSchema>;

export const clientBootstrapSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).optional()
}).strict();

export const issueRecoveryCodesSchema = z.object({
  expectedRevision: z.number().int().positive()
}).strict();

export const acknowledgeRecoveryCodesSchema = z.object({
  batchVersion: z.number().int().positive(),
  expectedRevision: z.number().int().positive()
}).strict();

export const completeClientRecoverySchema = z.object({
  recoveryCode: z.string().trim().min(20).max(200),
  newPassword: z.string().min(10).max(128)
}).strict();

export const startPhoneChangeSchema = z.object({
  newPhone: z.string().regex(/^\+[1-9]\d{7,14}$/),
  expectedRevision: z.number().int().positive()
}).strict();

export const confirmPhoneChangeSchema = z.object({
  expectedRevision: z.number().int().positive()
}).strict();

export const changeClientPasswordSchema = z.object({
  currentPassword: z.string().min(10).max(128),
  newPassword: z.string().min(10).max(128),
  expectedRevision: z.number().int().positive()
}).strict().refine((value) => value.currentPassword !== value.newPassword, {
  path: ["newPassword"], message: "New password must differ from the current password"
});

export const revokeClientSessionsSchema = z.object({
  scope: z.enum(["CURRENT", "OTHERS", "ALL"]),
  sessionId: z.string().uuid().optional()
}).strict().superRefine((value, context) => {
  if (value.sessionId && value.scope !== "CURRENT") context.addIssue({ code: "custom", path: ["sessionId"], message: "sessionId is only valid with CURRENT" });
});

export type ClientBootstrapInput = z.infer<typeof clientBootstrapSchema>;
export type IssueRecoveryCodesInput = z.infer<typeof issueRecoveryCodesSchema>;
export type AcknowledgeRecoveryCodesInput = z.infer<typeof acknowledgeRecoveryCodesSchema>;
export type CompleteClientRecoveryInput = z.infer<typeof completeClientRecoverySchema>;
export type StartPhoneChangeInput = z.infer<typeof startPhoneChangeSchema>;
export type ConfirmPhoneChangeInput = z.infer<typeof confirmPhoneChangeSchema>;
export type ChangeClientPasswordInput = z.infer<typeof changeClientPasswordSchema>;
export type RevokeClientSessionsInput = z.infer<typeof revokeClientSessionsSchema>;

export interface ClientStatusResponse {
  status: ClientOperationalStatus;
  accountId?: string;
  revision?: number;
  aal: "aal1" | "aal2";
  hasVerifiedTotp: boolean;
}

export interface ClientMeResponse {
  accountId: string;
  person: { firstName: string; lastName: string | null };
  verifiedPhone: string;
  status: "ACTIVE";
  securityRevision: number;
  session: { id: string; createdAt: string; lastSeenAt: string; expiresAt: string };
}
