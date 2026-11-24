import { createHash } from "node:crypto";
import { minorToString, parseMinor } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";
import { applicableVersion } from "./agreements.js";
import { eligibleSources, type EconomicSource } from "./attribution.js";

export type EstimateResult = {
  state: "NOT_CONFIGURED" | "OPEN_ESTIMATE";
  staffMemberId: string;
  periodStart: string;
  periodEnd: string;
  agreementVersionId: string | null;
  termsHash: string | null;
  sourceFingerprint: string;
  payableMinor: string;
  receivableMinor: string;
  lines: Array<{ sourceType: string; sourceId: string; component: string; amountMinor: string; versionNote: string }>;
};

function fingerprint(sources: EconomicSource[], termsHash: string | null): string {
  const canonical = JSON.stringify({ termsHash, sources: sources.map((s) => `${s.sourceType}:${s.sourceId}:${s.baseMinor.toString()}:${s.commissionMinor.toString()}`).sort() });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * CAP-08-03 · OPEN_ESTIMATE reproducible y explicable.
 * NO escribe en money.* ni en obligations.*: sólo calcula y cachea en econ.
 * Un accordo incompleto produce NOT_CONFIGURED, NUNCA $0 como cuantía.
 */
export async function calculateEstimate(
  tx: Tx, actor: Actor, input: { staffMemberId: string; from: Date; to: Date }
): Promise<EstimateResult> {
  const version = await applicableVersion(tx, actor.businessId, input.staffMemberId, input.from);
  const sources = await eligibleSources(tx, actor.businessId, input.staffMemberId, input.from, input.to);
  const fp = fingerprint(sources, version?.terms_hash ?? null);
  // El snapshot declara las versiones REALMENTE usadas por las fuentes. Si el
  // acuerdo cambió a mitad de período, se hashé el conjunto (no una sola).
  const usedTerms = [...new Set(sources.map((source) => source.versionNote))].sort();
  const effectiveTermsHash = usedTerms.length === 1
    ? (usedTerms[0] ?? version?.terms_hash ?? null)
    : createHash("sha256").update(usedTerms.join("|")).digest("hex");
  const unconfiguredSources = sources.filter((source) => source.versionNote === "NOT_CONFIGURED");
  const lines: EstimateResult["lines"] = [];
  let payable = 0n;
  let receivable = 0n;

  if (!version || unconfiguredSources.length > 0) {
    return {
      state: "NOT_CONFIGURED", staffMemberId: input.staffMemberId,
      periodStart: input.from.toISOString(), periodEnd: input.to.toISOString(),
      agreementVersionId: version?.id ?? null, termsHash: effectiveTermsHash,
      sourceFingerprint: fp, payableMinor: "0", receivableMinor: "0", lines: []
    };
  }

  for (const source of sources) {
    payable += source.commissionMinor;
    lines.push({ sourceType: source.sourceType, sourceId: source.sourceId, component: "COMMISSION", amountMinor: minorToString(source.commissionMinor), versionNote: source.versionNote });
  }

  if (version.modality === "FIXED" || version.modality === "MIXED") {
    if (version.fixed_amount_minor === null) {
      return { state: "NOT_CONFIGURED", staffMemberId: input.staffMemberId, periodStart: input.from.toISOString(), periodEnd: input.to.toISOString(), agreementVersionId: version.id, termsHash: effectiveTermsHash, sourceFingerprint: fp, payableMinor: "0", receivableMinor: "0", lines: [] };
    }
    const fixed = parseMinor(version.fixed_amount_minor);
    payable += fixed;
    lines.push({ sourceType: "PERIOD", sourceId: "FIXED", component: "FIXED", amountMinor: minorToString(fixed), versionNote: version.terms_hash });
  }
  if (version.modality === "CHAIR_RENT" || version.modality === "MIXED") {
    if (version.rent_amount_minor === null) {
      return { state: "NOT_CONFIGURED", staffMemberId: input.staffMemberId, periodStart: input.from.toISOString(), periodEnd: input.to.toISOString(), agreementVersionId: version.id, termsHash: effectiveTermsHash, sourceFingerprint: fp, payableMinor: "0", receivableMinor: "0", lines: [] };
    }
    const rent = parseMinor(version.rent_amount_minor);
    receivable += rent;
    lines.push({ sourceType: "PERIOD", sourceId: "CHAIR_RENT", component: "RENT", amountMinor: minorToString(rent), versionNote: version.terms_hash });
  }

  // Caché de LECTURA: cero escrituras financieras.
  await tx`
    insert into econ.estimates(business_id, staff_member_id, period_start, period_end, agreement_version_id,
      terms_hash, source_fingerprint, total_payable_minor, total_receivable_minor, lines, state)
    values (${actor.businessId}, ${input.staffMemberId}, ${input.from.toISOString()}, ${input.to.toISOString()},
      ${version.id}, ${effectiveTermsHash}, ${fp}, ${payable.toString()}, ${receivable.toString()},
      ${JSON.stringify(lines)}::jsonb, 'OPEN_ESTIMATE')
    on conflict (business_id, staff_member_id, period_start, period_end) do update set
      agreement_version_id=excluded.agreement_version_id, terms_hash=excluded.terms_hash,
      source_fingerprint=excluded.source_fingerprint, total_payable_minor=excluded.total_payable_minor,
      total_receivable_minor=excluded.total_receivable_minor, lines=excluded.lines, state=excluded.state,
      created_at=now()`;

  return {
    state: "OPEN_ESTIMATE", staffMemberId: input.staffMemberId,
    periodStart: input.from.toISOString(), periodEnd: input.to.toISOString(),
    agreementVersionId: version.id, termsHash: effectiveTermsHash,
    sourceFingerprint: fp, payableMinor: minorToString(payable), receivableMinor: minorToString(receivable), lines
  };
}

