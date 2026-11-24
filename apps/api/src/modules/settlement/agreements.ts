import { createHash } from "node:crypto";
import { DomainError, createAgreementVersionSchema, type Capability, type PeriodCadence } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { authorizationService } from "../iam/authorization.js";
import { audit, executeOperation, revalidateAuthority, type Tx } from "../system/operations.js";
import { rows, sql } from "../../lib/sql.js";

export const AGREEMENT_CAPABILITY: Capability = "economy.agreements.manage";

export function termsHash(input: object): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

// The key exists independently of any agreement rows, including the first version.
export async function lockAgreementTerms(tx: Tx, businessId: string, staffMemberId: string, write = false) {
  const key = `${businessId.toLowerCase()}:${staffMemberId.toLowerCase()}`;
  if (write) await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 108))`;
  else await tx`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 108))`;
}

export async function createAgreementVersion(actor: Actor, raw: unknown, operationId: string) {
  const input = createAgreementVersionSchema.parse(raw);
  authorizationService.require(actor, AGREEMENT_CAPABILITY, { staffMemberId: input.staffMemberId });
  const hash = termsHash({
    modality: input.modality, commissionBase: input.commissionBase ?? null, bps: input.bps ?? null,
    fixedAmountMinor: input.fixedAmountMinor ?? null, rentAmountMinor: input.rentAmountMinor ?? null,
    periodCadence: input.periodCadence ?? null, validFrom: input.validFrom, validTo: input.validTo
  });
  return executeOperation({ operationId, command: "agreement.createVersion", actor, payload: { ...input, termsHash: hash } }, async (tx) => {
    await lockAgreementTerms(tx, actor.businessId, input.staffMemberId, true);
    const agreement = await tx`select id from econ.agreements where business_id=${actor.businessId} and staff_member_id=${input.staffMemberId} and status='ACTIVE' order by created_at limit 1`;
    let agreementId: string;
    if (agreement.length) {
      agreementId = agreement[0]!.id as string;
    } else {
      const [created] = await tx`
        insert into econ.agreements(business_id, staff_member_id, created_by_account_id, operation_id)
        values (${actor.businessId}, ${input.staffMemberId}, ${actor.accountId}, ${operationId}) returning id`;
      agreementId = created!.id as string;
    }
    const [latest] = await tx`select coalesce(max(version),0)::int version from econ.agreement_versions where business_id=${actor.businessId} and agreement_id=${agreementId}`;
    const version = Number(latest!.version) + 1;
    let row: { id: string }[];
    try {
      row = await tx`
        insert into econ.agreement_versions(
          business_id, agreement_id, version, modality, commission_base, bps,
          fixed_amount_minor, rent_amount_minor, period_cadence, valid_from, valid_to, terms_hash,
          created_by_account_id, operation_id)
        values (${actor.businessId}, ${agreementId}, ${version}, ${input.modality},
                ${input.commissionBase ?? null}, ${input.bps ?? null}, ${input.fixedAmountMinor ?? null},
                ${input.rentAmountMinor ?? null}, ${input.periodCadence ? JSON.stringify(input.periodCadence) : null}::jsonb,
                ${input.validFrom}, ${input.validTo}, ${hash},
                ${actor.accountId}, ${operationId}) returning id`;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505" || code === "23P01") throw new DomainError("AGREEMENT_OVERLAP", "An agreement version is already active for that period", 409);
      throw error;
    }
    await revalidateAuthority(tx, actor, AGREEMENT_CAPABILITY, { staffMemberId: input.staffMemberId });
    await audit(tx, { actor, operationId, action: "agreement.version_created", capability: AGREEMENT_CAPABILITY, resourceType: "AGREEMENT_VERSION", resourceId: row[0]!.id as string, changes: { agreementId, version, modality: input.modality, termsHash: hash } });
    return { agreementId, version, id: row[0]!.id as string, termsHash: hash };
  });
}

export async function agreementVersions(actor: Actor, staffMemberId: string) {
  // `agreement_versions` NO tiene staff_member_id: el vínculo es
  // agreement_id -> agreements(business_id, staff_member_id).
  return rows(sql`
    select v.id, v.version, v.modality, v.commission_base "commissionBase", v.bps,
           v.fixed_amount_minor "fixedAmountMinor", v.rent_amount_minor "rentAmountMinor",
           v.period_cadence "periodCadence", v.valid_from "validFrom", v.valid_to "validTo", v.terms_hash "termsHash", v.status
    from econ.agreement_versions v
    join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
    where v.business_id=${actor.businessId} and a.staff_member_id=${staffMemberId}
    order by v.version desc`);
}

export type AgreementVersionRow = {
  id: string; modality: string; commission_base: string | null; bps: number | null;
  fixed_amount_minor: string | null; rent_amount_minor: string | null;
  valid_from: Date; valid_to: Date; terms_hash: string; period_cadence: PeriodCadence | null; created_at: Date;
};

/** CL-07/CL-05: vigencia por fecha efectiva, NUNCA por última versión. */
export async function applicableVersion(tx: Tx, businessId: string, staffMemberId: string, occurredAt: Date): Promise<AgreementVersionRow | null> {
  const result = await tx`
    select v.id, v.modality, v.commission_base, v.bps, v.fixed_amount_minor, v.rent_amount_minor,
           v.valid_from, v.valid_to, v.terms_hash, v.period_cadence, v.created_at
    from econ.agreement_versions v join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
    where v.business_id=${businessId} and a.staff_member_id=${staffMemberId}
      and a.status='ACTIVE' and v.status='ACTIVE' and v.valid_from <= ${occurredAt.toISOString()} and v.valid_to > ${occurredAt.toISOString()}
      and v.created_at <= ${occurredAt.toISOString()}
    order by v.valid_from desc, v.version desc limit 1`;
  return (result[0] as unknown as AgreementVersionRow) ?? null;
}
