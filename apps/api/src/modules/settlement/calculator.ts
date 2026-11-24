import { createHash } from "node:crypto";
import { DomainError, minorToString, parseMinor, type PeriodCadence } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { lockAvailabilityGuard } from "../availability/guard.js";
import { lockBusiness } from "../h05/domain.js";
import type { Tx } from "../system/operations.js";
import { applicableVersion, lockAgreementTerms, type AgreementVersionRow } from "./agreements.js";
import { eligibleSources, type EconomicSource } from "./attribution.js";

export type EstimateResult = {
  staffMemberId: string;
  periodStart: string;
  periodEnd: string;
  agreementVersionId: string | null;
  termsHash: string | null;
  sourceFingerprint: string;
  agreementVersions: Array<{ id: string; termsHash: string }>;
  lines: Array<{ sourceType: string; sourceId: string; component: string; amountMinor: string; versionNote: string; versionId?: string;
    basis?: { attendanceId: string; occurredAt: string; lineTotalMinor: string; baseMinor: string;
      collectedOperations?: string[]; refundOperations?: string[] } }>;
} & ({ state: "NOT_CONFIGURED"; payableMinor: null; receivableMinor: null }
  | { state: "OPEN_ESTIMATE"; payableMinor: string; receivableMinor: string });

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fingerprint(estimate: Omit<EstimateResult, "sourceFingerprint">, sources: EconomicSource[]): string {
  return hash({
    ...estimate,
    bases: sources.map((source) => [source.sourceId, source.baseMinor.toString()])
  });
}

function matchesCadence(cadence: PeriodCadence, from: Date, to: Date): boolean {
  const anchor = new Date(`${cadence.anchorDate}T00:00:00Z`);
  const dayMillis = 86_400_000;
  if (cadence.unit === "DAYS") {
    const periodMillis = cadence.interval * dayMillis;
    const offset = from.getTime() - anchor.getTime();
    return offset >= 0 && offset % periodMillis === 0 && to.getTime() - from.getTime() === periodMillis;
  }
  if (from.getTime() % dayMillis !== 0 || from.getUTCDate() !== 1) return false;
  const months = (from.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + from.getUTCMonth() - anchor.getUTCMonth();
  const expectedEnd = new Date(from);
  expectedEnd.setUTCMonth(from.getUTCMonth() + cadence.interval);
  return months >= 0 && months % cadence.interval === 0 && to.getTime() === expectedEnd.getTime();
}

/**
 * E-14 · FIXED/RENT son importes por período, no prorrateables (CL-09).
 * Se respetan TODAS las vigencias que intersectan el período: debe existir
 * cobertura continua y un único importe inequívoco. Si una versión cambia el
 * importe a mitad de período o hay un hueco, el cierre se bloquea con
 * NOT_CONFIGURED en lugar de inventar un prorrateo o cobrar dos veces.
 */
async function periodFixedRent(
  tx: Tx, businessId: string, staffMemberId: string, from: Date, to: Date
): Promise<{ fixed: bigint | null; rent: bigint | null; versions: EstimateResult["agreementVersions"]; ambiguous: boolean }> {
  const rows = await tx`
    select v.id, v.modality, v.fixed_amount_minor, v.rent_amount_minor,
           v.valid_from, v.valid_to, v.terms_hash, v.period_cadence, v.created_at
    from econ.agreement_versions v join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
    where v.business_id=${businessId} and a.staff_member_id=${staffMemberId}
      and a.status='ACTIVE' and v.status='ACTIVE' and v.valid_from < ${to.toISOString()} and v.valid_to > ${from.toISOString()}
    order by v.valid_from` as unknown as AgreementVersionRow[];

  const versions = rows.map((row) => ({ id: row.id, termsHash: row.terms_hash }));
  let cursor = from.getTime();
  for (const row of rows) {
    const start = new Date(row.valid_from).getTime();
    const end = new Date(row.valid_to).getTime();
    if (start > cursor) return { fixed: null, rent: null, versions, ambiguous: true };
    cursor = Math.max(cursor, end);
  }
  if (cursor < to.getTime()) return { fixed: null, rent: null, versions, ambiguous: true };

  const unique = (values: Array<string | null>) => {
    if (!values.length || values.some((value) => value === null)) return null;
    const first = values[0]!;
    return values.every((value) => value === first) ? first : null;
  };
  // EGM R1.1: decidir sobre TODAS las versiones del período, no sólo la de `from`.
  // Un componente que comienza a mitad de período también genera obligación.
  const needsFixed = rows.some((row) => row.modality === "FIXED" || row.fixed_amount_minor !== null);
  const needsRent = rows.some((row) => row.modality === "CHAIR_RENT" || row.rent_amount_minor !== null);
  const fixedRaw = unique(rows.map((row) => row.fixed_amount_minor));
  const rentRaw = unique(rows.map((row) => row.rent_amount_minor));
  const fixed = needsFixed && fixedRaw !== null ? parseMinor(fixedRaw) : null;
  const rent = needsRent && rentRaw !== null ? parseMinor(rentRaw) : null;
  const validCadence = (!needsFixed && !needsRent) || rows.every((row) =>
    row.period_cadence !== null && new Date(row.created_at).getTime() <= from.getTime()
      && matchesCadence(row.period_cadence, from, to));
  return { fixed, rent, versions, ambiguous: !validCadence || (needsFixed && fixed === null) || (needsRent && rent === null) };
}

/**
 * CAP-08-03 · OPEN_ESTIMATE reproducible y explicable.
 * NO escribe en money.* ni en obligations.*: sólo calcula y cachea en econ.
 * Un accordo incompleto produce NOT_CONFIGURED, NUNCA $0 como cuantía.
 */
export async function calculateEstimate(
  tx: Tx, actor: Actor, input: { staffMemberId: string; from: Date; to: Date }
): Promise<EstimateResult> {
  // Attendance obtains the availability guard before writing. H05 source writers share the finance lock.
  await lockAvailabilityGuard(tx, actor.businessId);
  await lockBusiness(tx, actor.businessId);
  await lockAgreementTerms(tx, actor.businessId, input.staffMemberId);
  const sources = await eligibleSources(tx, actor.businessId, input.staffMemberId, input.from, input.to);
  // CL-07: la versión aplicable se resuelve en el momento de los HECHOS del
  // período, no en el límite arbitrario `from`. `eligibleSources` ya exige
  // `created_at <= occurred_at` para cada fuente; usar `from` descartaba
  // acuerdos creados dentro del período cuyas prestaciones son posteriores
  // y devolvía NOT_CONFIGURED aunque la atribución sí era válida.
  const referenceAt = sources.length
    ? new Date(Math.max(...sources.map((source) => source.occurredAt.getTime())))
    : input.from;
  const version = await applicableVersion(tx, actor.businessId, input.staffMemberId, referenceAt);
  const periodTerms = await periodFixedRent(tx, actor.businessId, input.staffMemberId, input.from, input.to);
  const agreementVersions = periodTerms.versions;
  const termsHash = agreementVersions.length === 1 ? agreementVersions[0]!.termsHash
    : agreementVersions.length > 0 ? hash(agreementVersions) : null;
  const basis = {
    staffMemberId: input.staffMemberId,
    periodStart: input.from.toISOString(),
    periodEnd: input.to.toISOString(),
    agreementVersionId: version?.id ?? null,
    agreementVersions,
    termsHash
  };

  if (!version || periodTerms.ambiguous || sources.some((source) => source.versionNote === "NOT_CONFIGURED")) {
    await tx`delete from econ.estimates where business_id=${actor.businessId} and staff_member_id=${input.staffMemberId}
      and period_start=${basis.periodStart} and period_end=${basis.periodEnd}`;
    const estimate = { ...basis, state: "NOT_CONFIGURED" as const, payableMinor: null, receivableMinor: null, lines: [] };
    return { ...estimate, sourceFingerprint: fingerprint(estimate, sources) };
  }

  const lines: EstimateResult["lines"] = [];
  let payable = 0n;
  let receivable = 0n;
  for (const source of sources) {
    payable += source.commissionMinor;
    lines.push({
      sourceType: source.sourceType, sourceId: source.sourceId, component: "COMMISSION",
      amountMinor: minorToString(source.commissionMinor), versionNote: source.versionNote, versionId: source.versionId!,
      basis: { attendanceId: source.attendanceId, occurredAt: source.occurredAt.toISOString(),
        lineTotalMinor: minorToString(source.lineTotalMinor), baseMinor: minorToString(source.baseMinor),
        collectedOperations: source.collectedOperations, refundOperations: source.refundOperations }
    });
  }
  if (periodTerms.fixed !== null) {
    payable += periodTerms.fixed;
    lines.push({ sourceType: "PERIOD", sourceId: "FIXED", component: "FIXED", amountMinor: minorToString(periodTerms.fixed), versionNote: termsHash! });
  }
  if (periodTerms.rent !== null) {
    receivable += periodTerms.rent;
    lines.push({ sourceType: "PERIOD", sourceId: "CHAIR_RENT", component: "RENT", amountMinor: minorToString(periodTerms.rent), versionNote: termsHash! });
  }
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (payable > maximum || receivable > maximum) {
    throw new DomainError("ADJUSTMENT_INVALID", "La estimación excede el rango admitido por Obligaciones.", 409);
  }
  const estimate = { ...basis, state: "OPEN_ESTIMATE" as const, payableMinor: minorToString(payable), receivableMinor: minorToString(receivable), lines };
  const fp = fingerprint(estimate, sources);

  // Caché de LECTURA: cero escrituras financieras.
  await tx`
    insert into econ.estimates(business_id, staff_member_id, period_start, period_end, agreement_version_id,
      terms_hash, source_fingerprint, total_payable_minor, total_receivable_minor, lines, state)
    values (${actor.businessId}, ${input.staffMemberId}, ${input.from.toISOString()}, ${input.to.toISOString()},
      ${version.id}, ${termsHash}, ${fp}, ${payable.toString()}, ${receivable.toString()},
      ${JSON.stringify(lines)}::jsonb, 'OPEN_ESTIMATE')
    on conflict (business_id, staff_member_id, period_start, period_end) do update set
      agreement_version_id=excluded.agreement_version_id, terms_hash=excluded.terms_hash,
      source_fingerprint=excluded.source_fingerprint, total_payable_minor=excluded.total_payable_minor,
      total_receivable_minor=excluded.total_receivable_minor, lines=excluded.lines, state=excluded.state,
      created_at=now()`;

  return { ...estimate, sourceFingerprint: fp };
}
