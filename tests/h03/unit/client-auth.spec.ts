import { describe, expect, it } from "vitest";
import {
  acknowledgeRecoveryCodesSchema,
  clientBootstrapSchema,
  clientIdentityStatuses,
  clientOperationalStatuses,
  completeClientRecoverySchema,
  confirmPhoneChangeSchema,
  issueRecoveryCodesSchema,
  revokeClientSessionsSchema,
  startPhoneChangeSchema
} from "@youngkingz/contracts";
import {
  clientAccessSessions,
  clientIdentityStates,
  clientOperations,
  clientPhoneChangeStates,
  clientRecoveryCodes,
  clientRecoveryOperations,
  clientSecurityEvents
} from "@youngkingz/database";

describe("H03.U02 contratos de identidad", () => {
  it("rechaza autoridad sensible enviada por el navegador", () => {
    const input = { firstName: "Ana", accountId: crypto.randomUUID(), authUserId: crypto.randomUUID(), phoneVerified: true, role: "OWNER" };
    expect(clientBootstrapSchema.safeParse(input).success).toBe(false);
  });

  it("bootstrap no requiere Business ni Staff", () => {
    expect(clientBootstrapSchema.parse({ firstName: "Ana" })).toEqual({ firstName: "Ana" });
  });

  it("acepta únicamente los cinco estados persistidos", () => {
    expect(clientIdentityStatuses).toEqual(["PENDING_MFA", "RECOVERY_SETUP_REQUIRED", "ACTIVE", "RECOVERY_REQUIRED", "RESTRICTED"]);
  });

  it("expone los siete estados operacionales seguros", () => {
    expect(clientOperationalStatuses).toHaveLength(7);
    expect(clientOperationalStatuses).toContain("PHONE_VERIFICATION_REQUIRED");
    expect(clientOperationalStatuses).toContain("ACTIVE");
  });

  it("recuperación recibe secreto sólo en el comando y operationId queda en header", () => {
    expect(completeClientRecoverySchema.safeParse({ recoveryCode: `YKZ-${"a".repeat(22)}`, newPassword: "Strong-Pass!26" }).success).toBe(true);
    expect(completeClientRecoverySchema.safeParse({ recoveryCode: `YKZ-${"a".repeat(22)}`, newPassword: "Strong-Pass!26", operationId: crypto.randomUUID() }).success).toBe(false);
  });

  it("cambio telefónico exige E.164 y revisión", () => {
    expect(startPhoneChangeSchema.safeParse({ newPhone: "+5491112345678", expectedRevision: 3 }).success).toBe(true);
    expect(startPhoneChangeSchema.safeParse({ newPhone: "1112345678", expectedRevision: 3 }).success).toBe(false);
    expect(confirmPhoneChangeSchema.safeParse({ expectedRevision: 3 }).success).toBe(true);
  });

  it("emisión y confirmación de códigos son revisionadas", () => {
    expect(issueRecoveryCodesSchema.safeParse({ expectedRevision: 1 }).success).toBe(true);
    expect(acknowledgeRecoveryCodesSchema.safeParse({ batchVersion: 2, expectedRevision: 3 }).success).toBe(true);
    expect(acknowledgeRecoveryCodesSchema.safeParse({ batchVersion: 0, expectedRevision: 3 }).success).toBe(false);
  });

  it("revocación no acepta accountId ni sessionId ajeno", () => {
    expect(revokeClientSessionsSchema.safeParse({ scope: "ALL", accountId: crypto.randomUUID() }).success).toBe(false);
    expect(revokeClientSessionsSchema.safeParse({ scope: "OTHERS", sessionId: crypto.randomUUID() }).success).toBe(false);
  });
});

describe("H03.U02 concordancia Drizzle", () => {
  it("declara exactamente las tablas backend-only de IAM", () => {
    expect(clientIdentityStates[Symbol.for("drizzle:Name")]).toBe("client_identity_states");
    expect(clientAccessSessions[Symbol.for("drizzle:Name")]).toBe("client_access_sessions");
    expect(clientRecoveryCodes[Symbol.for("drizzle:Name")]).toBe("client_recovery_codes");
    expect(clientRecoveryOperations[Symbol.for("drizzle:Name")]).toBe("client_recovery_operations");
    expect(clientSecurityEvents[Symbol.for("drizzle:Name")]).toBe("client_security_events");
    expect(clientOperations[Symbol.for("drizzle:Name")]).toBe("client_operations");
    expect(clientPhoneChangeStates[Symbol.for("drizzle:Name")]).toBe("client_phone_change_states");
  });

  it("sesión CLIENT no tiene columnas de Staff ni Business", () => {
    const columns = Object.keys(clientAccessSessions);
    expect(columns).toContain("accountId");
    expect(columns).toContain("providerSessionId");
    expect(columns).not.toContain("staffMemberId");
    expect(columns).not.toContain("businessId");
  });
});
