/**
 * H03/H06 · CAP-06-07 · OrderCredential (extensión H03, propiedad H03).
 *
 * Una credencial de recurso por pedido invitado. El token en claro se
 * devuelve SOLO en el momento de emisión/reemisión; en base se persiste
 * únicamente su digest SHA-256 base64url, con el MISMO algoritmo que
 * `booking.guest_credentials` (helper compartido `lib/security/opaque-token`).
 *
 * Invariantes:
 *  · D08/D18 — sin credencial en URL, logs, body de `operation_attempts`
 *    ni respuesta de seguimiento; nunca teléfono/nombre como prueba.
 *  · T-07 — un activo por pedido, generación creciente, reemisión atómica
 *    que revoca la anterior; `expires_at` nullable (sin TTL por reloj).
 *  · C01 §10.4 — `executePrincipalOperation` NO compara `proofDigest`: H06
 *    debe hacerlo DENTRO de su transacción antes de cualquier mutación.
 *  · Q25/Q26 — token inválido o revocado ⇒ 404 (nunca 403), sin revelar
 *    existencia del pedido.
 */
import { DomainError } from "@youngkingz/contracts";
import type { Tx } from "../system/operations.js";
import { database } from "../../lib/runtime.js";
import { issueOpaqueToken, opaqueTokenDigest, safeEqualOpaqueToken } from "../../lib/security/opaque-token.js";

export type OrderCredentialView = {
  credentialId: string;
  orderId: string;
  generation: number;
  token: string;
};

/** Emisión dentro de la Tx del llamador (order.request). SÓLO el digest se persiste. */
export async function issueOrderCredentialTx(
  tx: Tx,
  businessId: string,
  orderId: string,
  issued?: { token: string; digest: string }
): Promise<OrderCredentialView & { digest: string }> {
  const { token, digest } = issued ?? issueOpaqueToken();
  const [row] = await tx`
    insert into clients.order_credentials(business_id, order_id, token_digest, generation)
    values (${businessId}, ${orderId}, ${digest}, 1)
    returning id, generation`;
  if (!row) throw new Error("No se pudo emitir la credencial del pedido");
  return { credentialId: String(row.id), orderId, generation: Number(row.generation), token, digest };
}

/**
 * Validación DENTRO de la Tx: calcula el digest y lo compara en tiempo
 * constante contra la fila activa del pedido. Devuelve el `proofDigest`
 * requerido por el principal `GUEST_INTENT`.
 */
export async function validateOrderCredentialInTx(
  tx: Tx,
  businessId: string,
  orderId: string,
  token: string
): Promise<{ credentialId: string; orderId: string; proofDigest: string }> {
  const digest = opaqueTokenDigest(token);
  const [row] = await tx`
    select id, token_digest "tokenDigest", status::text status, order_id "orderId"
      from clients.order_credentials
     where business_id = ${businessId} and order_id = ${orderId}
     order by generation desc limit 1
     for update`;
  if (!row || !safeEqualOpaqueToken(String(row.tokenDigest), digest)) {
    throw new DomainError("ORDER_CREDENTIAL_INVALID", "Credencial de pedido inválida", 404);
  }
  if (String(row.status) !== "ACTIVE") {
    throw new DomainError("ORDER_CREDENTIAL_REVOKED", "Credencial de pedido revocada", 404);
  }
  return { credentialId: String(row.id), orderId: String(row.orderId), proofDigest: digest };
}

/** Validación de lectura (sin lock): misma semántica 404 para inválida/revocada. */
export async function resolveOrderCredential(
  token: string,
  businessId: string,
  orderId: string,
  tx?: Tx
): Promise<{ credentialId: string; orderId: string; proofDigest: string }> {
  const digest = opaqueTokenDigest(token);
  const rows = tx
    ? await tx`select id, token_digest "tokenDigest", status::text status, order_id "orderId" from clients.order_credentials where business_id=${businessId} and order_id=${orderId} and token_digest=${digest}`
    : await database.client`select id, token_digest "tokenDigest", status::text status, order_id "orderId" from clients.order_credentials where business_id=${businessId} and order_id=${orderId} and token_digest=${digest}`;
  const row = rows[0];
  if (!row || !safeEqualOpaqueToken(String(row.tokenDigest), digest)) {
    throw new DomainError("ORDER_CREDENTIAL_INVALID", "Credencial de pedido inválida", 404);
  }
  if (String(row.status) !== "ACTIVE") {
    throw new DomainError("ORDER_CREDENTIAL_REVOKED", "Credencial de pedido revocada", 404);
  }
  return { credentialId: String(row.id), orderId: String(row.orderId), proofDigest: digest };
}

/** Reemisión autenticada: nueva generación + revocación atómica de la anterior. */
export async function reissueOrderCredentialTx(
  tx: Tx,
  businessId: string,
  orderId: string,
  reason: string,
  issued?: { token: string; digest: string }
): Promise<OrderCredentialView & { digest: string }> {
  const [current] = await tx`
    select id, generation from clients.order_credentials
     where business_id = ${businessId} and order_id = ${orderId} and status = 'ACTIVE'
     for update`;
  if (!current) throw new DomainError("ORDER_CREDENTIAL_REVOKED", "El pedido no tiene una credencial activa", 404);
  const { token, digest } = issued ?? issueOpaqueToken();
  const generation = Number(current.generation) + 1;
  const [row] = await tx`
    update clients.order_credentials
       set status='REVOKED', revoked_at=now(), revoked_reason=${reason}, revision=revision+1
     where business_id = ${businessId} and id = ${current.id}
    returning id`;
  if (!row) throw new Error("No se pudo revocar la credencial anterior");
  const [fresh] = await tx`
    insert into clients.order_credentials(business_id, order_id, token_digest, generation, reissued_from_id)
    values (${businessId}, ${orderId}, ${digest}, ${generation}, ${current.id})
    returning id`;
  if (!fresh) throw new Error("No se pudo reemitir la credencial del pedido");
  return { credentialId: String(fresh.id), orderId, generation, token, digest };
}

/** Revocación por recurso: NO afecta sesiones IAM (H03). */
export async function revokeOrderCredentialTx(
  tx: Tx,
  businessId: string,
  credentialId: string,
  reason: string
): Promise<{ credentialId: string; revoked: true }> {
  const [row] = await tx`
    update clients.order_credentials
       set status='REVOKED', revoked_at=now(), revoked_reason=${reason}, revision=revision+1
     where business_id = ${businessId} and id = ${credentialId} and status = 'ACTIVE'
    returning id`;
  if (!row) throw new DomainError("ORDER_CREDENTIAL_REVOKED", "La credencial ya estaba revocada", 404);
  return { credentialId, revoked: true };
}

/** Nunca incluir el token en cambios auditados ni en response_body persistido. */
export function redactCredential<T extends { token?: string }>(value: T): Omit<T, "token"> {
  const { token, ...rest } = value;
  void token;
  return rest;
}
