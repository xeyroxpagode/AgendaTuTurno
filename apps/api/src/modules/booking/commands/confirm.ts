/**
 * H03.U04 · ConfirmBooking — transacción única Reservation + Allocation.
 *
 * Núcleo ÚNICO de confirmación: U04 lo usa para GUEST y U02 lo reutiliza para
 * CLIENT. No hay una segunda implementación de confirmación; sólo cambia el
 * principal de idempotencia y el tipo de propietario persistido.
 */
import { randomUUID } from "node:crypto";
import { DomainError, type BookingQuotePayload } from "@youngkingz/contracts";
import { executePrincipalOperation, type Tx } from "../../system/operations.js";
import { lockAvailabilityGuard } from "../../availability/guard.js";
import { resolveSlot } from "../../availability/queries.js";
import { claimAllocation } from "../../availability/allocation.js";
import { verifyQuote } from "../domain/quote.js";
import { computeReservationSnapshot, toPolicySnapshot } from "../domain/reservation.js";
import { issueGuestToken, intentProofDigest, encryptEnvelope, CURRENT_KEY_VERSION } from "../security/guest-access.js";

const CONFIRM_COMMAND = "booking.reservation.confirm";
const ENVELOPE_TTL_HOURS = 24;

export type ConfirmGuestInput = {
  businessId: string;
  quoteToken: string;
  intentId: string;
  intentProof: string;
  contact: { name: string; phone: string; email?: string };
  operationId: string;
};

export type ConfirmClientInput = {
  accountId: string;
  authSessionId: string;
  quoteToken: string;
  contact: { name: string; phone: string; email?: string | null };
  operationId: string;
};

export type ConfirmResult = {
  reservationId: string;
  status: "CONFIRMED";
  startsAt: string;
  endsAt: string;
  occupiedStartsAt: string;
  occupiedEndsAt: string;
  staffMemberId: string;
  commercialTotalMinor: number;
  currency: "ARS";
  businessLocalDate: string;
  operationId: string;
  guestCredentialIssued: boolean;
};

async function loadTerms(tx: Tx, businessId: string, serviceIds: string[]) {
  const rowsResult = await tx`select s.id, s.name, s.current_terms_version_id "currentTermsVersionId", v.id "termsVersionId", v.duration_minutes "durationMinutes", v.pre_buffer_minutes "preBufferMinutes", v.post_buffer_minutes "postBufferMinutes", v.price_minor "priceMinor", v.currency "currency", v.conditions "conditions" from catalog.services s join catalog.service_terms_versions v on v.business_id=s.business_id and v.service_id=s.id and v.id=s.current_terms_version_id where s.business_id=${businessId} and s.id=any(${serviceIds}::uuid[])`;
  const byId = new Map(rowsResult.map(r => [r.id as string, r]));
  return serviceIds.map(id => {
    const r = byId.get(id);
    if (!r) throw new DomainError("SERVICE_NOT_BOOKABLE", "A selected Service is not bookable", 409, { serviceId: id });
    return {
      serviceId: id,
      name: r.name as string,
      termsVersionId: r.termsVersionId as string,
      durationMinutes: Number(r.durationMinutes),
      preBufferMinutes: Number(r.preBufferMinutes),
      postBufferMinutes: Number(r.postBufferMinutes),
      priceMinor: Number(r.priceMinor),
      currency: r.currency as string,
      conditions: (r.conditions as string | null) ?? null,
    };
  });
}

async function loadPolicyVersion(tx: Tx, businessId: string, policyVersionId: string) {
  const [row] = await tx`select v.id,v.version_number "versionNumber",s.revision "revision",v.horizon_calendar_dates "horizonCalendarDates",v.min_lead_minutes "minLeadMinutes",v.start_step_minutes "startStepMinutes",v.cancel_cutoff_minutes "cancelCutoffMinutes",v.reschedule_cutoff_minutes "rescheduleCutoffMinutes",v.public_booking_enabled "publicBookingEnabled" from business.booking_policy_versions v join business.booking_policy_states s on s.business_id=v.business_id and s.current_version_id=v.id where v.business_id=${businessId} and v.id=${policyVersionId}`;
  if (!row) throw new DomainError("BOOKING_POLICY_UNAVAILABLE", "Booking Policy version not found", 409);
  return {
    id: row.id as string,
    versionNumber: Number(row.versionNumber),
    revision: Number(row.revision),
    horizonCalendarDates: Number(row.horizonCalendarDates),
    minLeadMinutes: Number(row.minLeadMinutes),
    startStepMinutes: Number(row.startStepMinutes),
    cancelCutoffMinutes: Number(row.cancelCutoffMinutes),
    rescheduleCutoffMinutes: Number(row.rescheduleCutoffMinutes),
    publicBookingEnabled: row.publicBookingEnabled as boolean,
  };
}

function minuteToHhMm(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Contexto de confirmación. `guestDelivery` presente ⇒GUEST (credencial invitada
 * + envelope de entrega). Ausente ⇒CLIENT (propietario por cuenta global).
 */
type ConfirmContext = {
  businessId: string;
  quote: BookingQuotePayload;
  operationId: string;
  ownerType: "GUEST" | "CLIENT";
  ownerAccountId: string | null;
  contact: { name: string; phone: string; email?: string | null };
  principalType: "GUEST_INTENT" | "CLIENT";
  actorAccountId: string | null;
  guestDelivery: { intentId: string; intentProof: string } | null;
};

/** Núcleo transaccional único Reservation + Allocation (U03/U04). */
async function performConfirm(tx: Tx, ctx: ConfirmContext): Promise<ConfirmResult> {
  const { businessId, quote, operationId } = ctx;
  await lockAvailabilityGuard(tx, businessId);

  const currentTerms = await loadTerms(tx, businessId, quote.serviceIds);
  if (currentTerms.length !== quote.items.length) throw new DomainError("COMMERCIAL_TERMS_CHANGED", "Terms changed since quote; re-quote required", 409);
  for (let i = 0; i < quote.serviceIds.length; i++) {
    const q = quote.items[i]!;
    const c = currentTerms[i]!;
    if (q.termsVersionId !== c.termsVersionId || q.priceMinor !== c.priceMinor || q.durationMinutes !== c.durationMinutes || q.preBufferMinutes !== c.preBufferMinutes || q.postBufferMinutes !== c.postBufferMinutes || q.currency !== c.currency) {
      throw new DomainError("COMMERCIAL_TERMS_CHANGED", "Terms or prices changed since quote; re-quote required", 409, { serviceId: quote.serviceIds[i] });
    }
  }

  const currentPolicy = await loadPolicyVersion(tx, businessId, quote.policyVersionId);
  if (currentPolicy.revision !== quote.policyRevision || currentPolicy.versionNumber !== quote.policyVersionNumber) {
    throw new DomainError("COMMERCIAL_TERMS_CHANGED", "Booking Policy changed since quote; re-quote required", 409);
  }
  const policySnapshot = toPolicySnapshot(currentPolicy);

  const slot = await resolveSlot(tx, {
    businessId,
    serviceIds: quote.serviceIds,
    localDate: quote.localDate,
    visibleStartMinute: quote.visibleStartMinute,
    professionalPreference: quote.professionalPreference,
    requirePublic: true,
    now: new Date(),
    termsOverride: quote.items.map(q => ({
      id: q.serviceId,
      durationMinutes: q.durationMinutes,
      preBufferMinutes: q.preBufferMinutes,
      postBufferMinutes: q.postBufferMinutes,
    })),
  });

  const itemsInput = quote.items.map((q, i) => ({
    serviceId: quote.serviceIds[i]!,
    serviceName: currentTerms[i]!.name,
    termsVersionId: q.termsVersionId,
    durationMinutes: q.durationMinutes,
    preBufferMinutes: q.preBufferMinutes,
    postBufferMinutes: q.postBufferMinutes,
    priceMinor: q.priceMinor,
    currency: q.currency,
    conditions: currentTerms[i]!.conditions,
  }));
  const snapshot = computeReservationSnapshot(itemsInput);
  if (snapshot.commercialTotalMinor !== quote.commercialTotalMinor) {
    throw new DomainError("COMMERCIAL_TERMS_CHANGED", "Commercial total no longer matches accepted quote", 409);
  }

  const [biz] = await tx`select timezone from business.businesses where id=${businessId}`;
  const reservationId = randomUUID();
  await tx`insert into booking.reservations(id,business_id,revision,status,owner_type,owner_account_id,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,current_allocation_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
    values (${reservationId},${businessId},1,'CONFIRMED',${ctx.ownerType},${ctx.ownerAccountId},${JSON.stringify({ name: ctx.contact.name, phone: ctx.contact.phone, email: ctx.contact.email ?? null })}::jsonb,${slot.staffMemberId},${quote.policyVersionId},${JSON.stringify(policySnapshot)}::jsonb,${snapshot.commercialTotalMinor},'ARS',null,${slot.visibleStartAt.toISOString()},${slot.visibleEndAt.toISOString()},${slot.occupiedStartAt.toISOString()},${slot.occupiedEndAt.toISOString()},${slot.localDate},${biz!.timezone as string},${operationId})`;

  const visibleStart = minuteToHhMm(slot.visibleStartMinute);
  const claimed = await claimAllocation(tx, {
    businessId,
    sourceType: "RESERVATION",
    sourceId: reservationId,
    serviceIds: quote.serviceIds,
    localDate: slot.localDate,
    visibleStart,
    professionalPreference: quote.professionalPreference,
  }, new Date());

  await tx`update booking.reservations set current_allocation_id=${claimed.allocationId}, starts_at=${claimed.visibleStartAt.toISOString()}, ends_at=${claimed.visibleEndAt.toISOString()}, occupied_starts_at=${claimed.occupiedStartAt.toISOString()}, occupied_ends_at=${claimed.occupiedEndAt.toISOString()}, staff_member_id=${claimed.staffMemberId} where id=${reservationId}`;

  for (const item of snapshot.items) {
    await tx`insert into booking.reservation_items(business_id,reservation_id,position,service_id,service_name_snapshot,terms_version_id,duration_minutes,pre_buffer_minutes,post_buffer_minutes,price_minor,currency,conditions_snapshot)
      values (${businessId},${reservationId},${item.position},${item.serviceId},${item.serviceName},${item.termsVersionId},${item.durationMinutes},${item.preBufferMinutes},${item.postBufferMinutes},${item.priceMinor},'ARS',${item.conditions ?? null})`;
  }

  if (ctx.guestDelivery) {
    const { token: guestToken, digest: tokenDigest } = issueGuestToken();
    const [cred] = await tx`insert into booking.guest_credentials(business_id,reservation_id,token_digest,generation,status) values (${businessId},${reservationId},${tokenDigest},1,'ACTIVE') returning id`;
    const intentProofDigestValue = intentProofDigest(ctx.guestDelivery.intentProof);
    const envelopePlaintext = JSON.stringify({ reservationId, guestToken, credentialId: cred!.id });
    const envelope = encryptEnvelope(envelopePlaintext, CURRENT_KEY_VERSION);
    await tx`insert into booking.guest_delivery_envelopes(business_id,operation_id,reservation_id,intent_proof_digest,encrypted_payload,key_version,expires_at)
      values (${businessId},${operationId},${reservationId},${intentProofDigestValue},${envelope}::bytea,${CURRENT_KEY_VERSION},now() + ${ENVELOPE_TTL_HOURS} * interval '1 hour')`;
  }

  await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,actor_account_id,changes)
    values (${businessId},${reservationId},1,'RESERVATION_CONFIRMED',${operationId},${ctx.principalType},${ctx.actorAccountId},${JSON.stringify({ status: { before: null, after: "CONFIRMED" }, staffMemberId: { before: null, after: slot.staffMemberId } })}::jsonb)`;
  await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
    values (${businessId},${ctx.actorAccountId},${operationId},'booking.reservation.confirmed','bookings.read',${JSON.stringify({ type: "BUSINESS", businessId })}::jsonb,'RESERVATION',${reservationId},'SUCCEEDED',${JSON.stringify({ ownerType: ctx.ownerType, staffMemberId: slot.staffMemberId })}::jsonb)`;

  return {
    reservationId,
    status: "CONFIRMED" as const,
    startsAt: claimed.visibleStartAt.toISOString(),
    endsAt: claimed.visibleEndAt.toISOString(),
    occupiedStartsAt: claimed.occupiedStartAt.toISOString(),
    occupiedEndsAt: claimed.occupiedEndAt.toISOString(),
    staffMemberId: claimed.staffMemberId,
    commercialTotalMinor: snapshot.commercialTotalMinor,
    currency: "ARS" as const,
    businessLocalDate: slot.localDate,
    operationId,
    guestCredentialIssued: ctx.guestDelivery !== null,
  };
}

export async function confirmGuestBooking(input: ConfirmGuestInput): Promise<ConfirmResult & { replayed: boolean }> {
  const quote = verifyQuote(input.quoteToken);
  if (quote.businessId !== input.businessId) throw new DomainError("BOOKING_QUOTE_INVALID", "Quote does not belong to this Business", 400);

  const principal = { kind: "GUEST_INTENT" as const, businessId: input.businessId, intentId: input.intentId, proofDigest: intentProofDigest(input.intentProof) };

  const result = await executePrincipalOperation<ConfirmResult>({
    operationId: input.operationId,
    command: CONFIRM_COMMAND,
    principal,
    payload: { quoteToken: input.quoteToken, intentId: input.intentId, contact: input.contact },
  }, async (tx) => performConfirm(tx, {
    businessId: input.businessId,
    quote,
    operationId: input.operationId,
    ownerType: "GUEST",
    ownerAccountId: null,
    contact: input.contact,
    principalType: "GUEST_INTENT",
    actorAccountId: null,
    guestDelivery: { intentId: input.intentId, intentProof: input.intentProof },
  }));

  return { ...result.data, replayed: result.replayed };
}

/**
 * Confirmación con identidad CLIENT real (U02). El Account ID global validado
 * es el propietario; el snapshot de contacto proviene de la identidad U02 y no
 * del cuerpo del navegador. No se crea ClientProfile ni vínculo CRM.
 */
export async function confirmClientBooking(input: ConfirmClientInput): Promise<ConfirmResult & { replayed: boolean }> {
  const quote = verifyQuote(input.quoteToken);
  const principal = { kind: "CLIENT" as const, businessId: quote.businessId, accountId: input.accountId, principalRef: input.authSessionId };

  const result = await executePrincipalOperation<ConfirmResult>({
    operationId: input.operationId,
    command: CONFIRM_COMMAND,
    principal,
    payload: { quoteToken: input.quoteToken, accountId: input.accountId },
  }, async (tx) => performConfirm(tx, {
    businessId: quote.businessId,
    quote,
    operationId: input.operationId,
    ownerType: "CLIENT",
    ownerAccountId: input.accountId,
    contact: input.contact,
    principalType: "CLIENT",
    actorAccountId: input.accountId,
    guestDelivery: null,
  }));

  return { ...result.data, replayed: result.replayed };
}
