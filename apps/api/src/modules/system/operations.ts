import type { Actor } from "../iam/authorization.js";
import { DomainError } from "@youngkingz/contracts";
import { stableHash } from "../../lib/crypto.js";
import { database } from "../../lib/runtime.js";
import type { TransactionSql } from "postgres";

export type Tx = TransactionSql<Record<string, never>>;

export type OperationPrincipal =
  | { kind: "STAFF"; businessId: string; accountId: string; principalRef?: string }
  | { kind: "CLIENT"; businessId: string; accountId: string; principalRef?: string }
  | { kind: "GUEST_INTENT"; businessId: string; intentId: string; proofDigest: string }
  | { kind: "GUEST_RESERVATION"; businessId: string; reservationId: string; credentialId: string };

type PrincipalIdentity = { businessId: string; accountId: string | null; principalKind: string; principalRef: string | null };

function principalIdentity(principal: OperationPrincipal): PrincipalIdentity {
  switch (principal.kind) {
    case "STAFF":
    case "CLIENT":
      return { businessId: principal.businessId, accountId: principal.accountId, principalKind: principal.kind, principalRef: principal.principalRef ?? principal.accountId };
    case "GUEST_INTENT":
      return { businessId: principal.businessId, accountId: null, principalKind: principal.kind, principalRef: principal.intentId };
    case "GUEST_RESERVATION":
      return { businessId: principal.businessId, accountId: null, principalKind: principal.kind, principalRef: principal.reservationId };
  }
}

/**
 * Núcleo único de idempotencia para todos los principales (H01 adaptada, no duplicada).
 * Comportamiento preservado para STAFF: mismo business/actor/hash ⇒ replay idéntico;
 * diferencias ⇒ IDEMPOTENCY_CONFLICT; operación en vuelo/fallida ⇒ CONFLICT.
 * Para invitados el resultado persistido debe estar sanitizado (el token viaja cifrado
 * en booking.guest_delivery_envelopes, nunca en operation_attempts.response_body).
 */
export async function executePrincipalOperation<T>(input: { operationId: string; command: string; principal: OperationPrincipal; payload: unknown }, handler: (tx: Tx) => Promise<T>): Promise<{ data: T; replayed: boolean }> {
  const requestHash = stableHash({ command: input.command, payload: input.payload });
  const identity = principalIdentity(input.principal);
  const result = await database.client.begin(async (tx) => {
    const existing = await tx`select request_hash, status::text status, response_body, business_id, actor_account_id, principal_kind, principal_ref from system.operation_attempts where operation_id = ${input.operationId} for update`;
    if (existing.length) {
      const row = existing[0]!;
      if (row.business_id !== identity.businessId) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id already used by another actor or business", 409);
      const samePrincipal = identity.accountId !== null
        ? row.actor_account_id === identity.accountId && row.principal_kind === identity.principalKind
        : row.principal_kind === identity.principalKind && row.principal_ref === identity.principalRef;
      if (!samePrincipal) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id already used by another actor or business", 409);
      if (row.request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id was already used with different content", 409);
      if (row.status === "SUCCEEDED") return { ok: true as const, data: row.response_body as T, replayed: true };
      throw new DomainError("CONFLICT", "The operation is already being reconciled", 409);
    }
    await tx`insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,principal_kind,principal_ref) values (${input.operationId},${identity.businessId},${identity.accountId},${input.command},${requestHash},${identity.principalKind},${identity.principalRef})`;
    try {
      const data = await tx.savepoint((operationTx) => handler(operationTx)) as T;
      await tx`update system.operation_attempts set status='SUCCEEDED',response_status=200,response_body=${JSON.stringify(data)}::jsonb,completed_at=now() where operation_id=${input.operationId}`;
      return { ok: true as const, data, replayed: false };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
      const status = error instanceof DomainError ? error.statusCode : 500;
      const body = error instanceof DomainError ? { error: { code, message: error.message, details: error.details } } : { error: { code, message: "Unexpected infrastructure error" } };
      await tx`update system.operation_attempts set status='FAILED',response_status=${status},response_body=${JSON.stringify(body)}::jsonb,error_code=${code},completed_at=now() where operation_id=${input.operationId}`;
      return { ok: false as const, error };
    }
  });
  if (!result.ok) throw result.error;
  return { data: result.data, replayed: result.replayed };
}

export async function executeOperation<T>(input: { operationId: string; command: string; actor: Actor; payload: unknown }, handler: (tx: Tx) => Promise<T>): Promise<{ data: T; replayed: boolean }> {
  return executePrincipalOperation<T>({ operationId: input.operationId, command: input.command, principal: { kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId }, payload: input.payload }, handler);
}

export async function audit(tx: Tx, input: { actor: Actor; operationId: string; action: string; capability: string; resourceType: string; resourceId?: string; changes?: object; outcome?: string }) {
  await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
    values (${input.actor.businessId},${input.actor.accountId},${input.operationId},${input.action},${input.capability},${JSON.stringify({type:"BUSINESS",businessId:input.actor.businessId})}::jsonb,${input.resourceType},${input.resourceId ?? null},${input.outcome ?? "SUCCEEDED"},${JSON.stringify(input.changes ?? {})}::jsonb)`;
}

export function operationId(headers: Record<string, unknown>): string {
  const value = headers["x-operation-id"];
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new DomainError("VALIDATION_ERROR", "x-operation-id must be a UUID v4", 400);
  return value;
}
