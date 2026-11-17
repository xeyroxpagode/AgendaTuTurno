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
    // Serialize the first insert too: SELECT FOR UPDATE cannot lock a missing row.
    await tx`select pg_advisory_xact_lock(hashtextextended(${input.operationId}, 104))`;
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

/* ─────────────────────────────────────────────────────────────────────────
 * H05 · CAP-05-03 Recovery · dos fronteras de persistencia (C01.8).
 *
 * `executePrincipalOperation` inserta el intento y ejecuta el handler en la
 * MISMA transacción. Eso es correcto para efectos puramente locales, pero
 * es INSUFICIENTE para un efecto externo no atómico (terminal de tarjeta,
 * transferencia bancaria): si el proceso cae antes del commit, el intento
 * desaparece y no queda nada que reconciliar.
 *
 * El protocolo H05 separa las dos fronteras:
 *  · FRONTERA DE PREPARACIÓN — `prepareDurableOperation` inserta el intento y
 *    COMMITEA. A partir de ese momento el intento original existe y
 *    sobrevive a un crash, una recarga o una desconexión.
 *  · FRONTERA DE RESULTADO — `settleDurableOperation` confirma el resultado
 *    real (`SUCCEEDED`) o un fallo PROBADO (`FAILED`), o devuelve el resultado
 *    guardado cuando el intento ya estaba confirmado.
 *
 * El intento NO se resuelve nunca por timeout: si queda `STARTED` (semántica
 * `PROCESSING`) o `UNKNOWN`, sigue siendo recuperable por `operation_id`.
 * ───────────────────────────────────────────────────────────────────────── */

export type DurableAttemptState = "PREPARED" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

/**
 * FRONTERA DE PREPARACIÓN. Persiste el intento y COMMITEA.
 *
 * · misma `operation_id` + mismo contenido → `replayed: true` (no se vuelve a
 *   ejecutar el efecto externo);
 * · misma `operation_id` + distinto contenido → `IDEMPOTENCY_CONFLICT`;
 * · el intento queda durable: un crash posterior lo deja en `STARTED`.
 */
export async function prepareDurableOperation(input: { operationId: string; command: string; actor: Actor; payload: unknown; attemptStatus?: "STARTED" | "UNKNOWN" }): Promise<{ prepared: true; replayed: boolean }> {
  const requestHash = stableHash({ command: input.command, payload: input.payload });
  const identity = principalIdentity({ kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId });
  const outcome = await database.client.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${input.operationId}, 104))`;
    const existing = await tx`select request_hash, status::text status, business_id, actor_account_id, principal_kind, principal_ref from system.operation_attempts where operation_id = ${input.operationId} for update`;
    if (existing.length) {
      const row = existing[0]!;
      if (row.business_id !== identity.businessId) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id already used by another actor or business", 409);
      if (row.actor_account_id !== identity.accountId || row.principal_kind !== identity.principalKind) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id already used by another actor or business", 409);
      }
      if (row.request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id was already used with different content", 409);
      return { replayed: true as const };
    }
    await tx`insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,principal_kind,principal_ref,status)
      values (${input.operationId},${identity.businessId},${identity.accountId},${input.command},${requestHash},${identity.principalKind},${identity.principalRef},${input.attemptStatus ?? "STARTED"})`;
    return { replayed: false as const };
  });
  return { prepared: true, replayed: outcome.replayed };
}

/**
 * FRONTERA DE RESULTADO. Confirma el resultado real de un intento durable.
 *
 * · intento `SUCCEEDED` → devuelve el resultado guardado (`replayed: true`);
 * · intento `FAILED` → devuelve el error guardado;
 * · intento `STARTED`/`UNKNOWN` → ejecuta el handler y consolida el
 *   resultado; si el handler falla, el intento queda `FAILED` con su código
 *   de error (fallo PROBADO, nunca por timeout).
 */
export async function settleDurableOperation<T>(input: { operationId: string; command: string; actor: Actor; payload: unknown; handler: (tx: Tx) => Promise<T>; failedStatus?: "FAILED" | "UNKNOWN" }): Promise<{ data: T; replayed: boolean }> {
  const requestHash = stableHash({ command: input.command, payload: input.payload });
  const identity = principalIdentity({ kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId });
  const result = await database.client.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${input.operationId}, 104))`;
    const existing = await tx`select request_hash, status::text status, response_body, response_status, error_code, business_id, actor_account_id, principal_kind, principal_ref from system.operation_attempts where operation_id = ${input.operationId} for update`;
    if (!existing.length) throw new DomainError("CONFLICT", "The operation was not prepared", 409);
    const row = existing[0]!;
    if (row.business_id !== identity.businessId) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id already used by another actor or business", 409);
    if (row.actor_account_id !== identity.accountId || row.principal_kind !== identity.principalKind) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id already used by another actor or business", 409);
    }
    if (row.request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id was already used with different content", 409);
    if (row.status === "SUCCEEDED") return { ok: true as const, data: row.response_body as T, replayed: true as const };
    if (row.status === "FAILED") {
      const body = (row.response_body ?? {}) as { error?: { code?: string; message?: string; details?: unknown } };
      const code = body.error?.code ?? row.error_code ?? "CONFLICT";
      const message = body.error?.message ?? "The operation already failed";
      throw new DomainError((code === "INTERNAL_ERROR" ? "CONFLICT" : code) as never, message, (row.response_status ?? 409) as never, body.error?.details);
    }
    try {
      const data = await tx.savepoint((operationTx) => input.handler(operationTx)) as T;
      await tx`update system.operation_attempts set status='SUCCEEDED',response_status=200,response_body=${JSON.stringify(data)}::jsonb,completed_at=now() where operation_id=${input.operationId}`;
      return { ok: true as const, data, replayed: false as const };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
      const status = error instanceof DomainError ? error.statusCode : 500;
      const body = error instanceof DomainError ? { error: { code, message: error.message, details: error.details } } : { error: { code, message: "Unexpected infrastructure error" } };
      await tx`update system.operation_attempts set status=${input.failedStatus ?? "FAILED"},response_status=${status},response_body=${JSON.stringify(body)}::jsonb,error_code=${code},completed_at=now() where operation_id=${input.operationId}`;
      return { ok: false as const, error };
    }
  });
  if (!result.ok) throw result.error;
  return { data: result.data, replayed: result.replayed };
}

/**
 * FRONTERA DE RESULTADO PARA INTENTOS DURABLES.
 *
 * Ejecuta el handler sobre un intento ya preparado (Frontera de
 * Preparación) y REGISTRA el hecho de negocio sin cerrar el intento: el
 * intento queda `STARTED` (semántica `PROCESSING`) o `UNKNOWN` según el
 * resultado real externo.
 *
 * Esto es lo que hace que "crash después de persistir un intento" sea
 * recuperable: el intento existe, el hecho de negocio existe, y el estado
 * sigue siendo `PROCESSING`/`UNKNOWN` hasta que un operador autorizado
 * lo resuelva con evidencia. NUNCA se degrada a fallo por timeout.
 */
export async function executeDurableAttempt<T>(input: {
  operationId: string; command: string; actor: Actor; payload: unknown;
  attemptStatus: "STARTED" | "UNKNOWN";
  handler: (tx: Tx) => Promise<T>;
}): Promise<{ data: T; replayed: boolean }> {
  const requestHash = stableHash({ command: input.command, payload: input.payload });
  const identity = principalIdentity({ kind: "STAFF", businessId: input.actor.businessId, accountId: input.actor.accountId });
  const result = await database.client.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${input.operationId}, 104))`;
    const existing = await tx`select request_hash, status::text status, response_body, response_status, error_code, business_id, actor_account_id, principal_kind, principal_ref from system.operation_attempts where operation_id = ${input.operationId} for update`;
    if (!existing.length) throw new DomainError("CONFLICT", "The operation was not prepared", 409);
    const row = existing[0]!;
    if (row.business_id !== identity.businessId) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id already used by another actor or business", 409);
    if (row.actor_account_id !== identity.accountId || row.principal_kind !== identity.principalKind) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id already used by another actor or business", 409);
    }
    if (row.request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id was already used with different content", 409);
    if (row.status === "SUCCEEDED") return { ok: true as const, data: row.response_body as T, replayed: true as const };
    if (row.status === "FAILED") {
      const body = (row.response_body ?? {}) as { error?: { code?: string; message?: string; details?: unknown } };
      const code = body.error?.code ?? row.error_code ?? "CONFLICT";
      const message = body.error?.message ?? "The operation already failed";
      throw new DomainError((code === "INTERNAL_ERROR" ? "CONFLICT" : code) as never, message, (row.response_status ?? 409) as never, body.error?.details);
    }
    // El intento ya tiene hechos de negocio registrados: es un replay.
    if (row.response_body !== null && row.response_body !== undefined) {
      return { ok: true as const, data: row.response_body as T, replayed: true as const };
    }
    try {
      const data = await tx.savepoint((operationTx) => input.handler(operationTx)) as T;
      await tx`update system.operation_attempts set status=${input.attemptStatus},response_status=200,response_body=${JSON.stringify(data)}::jsonb where operation_id=${input.operationId}`;
      return { ok: true as const, data, replayed: false as const };
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

/**
 * Estado durable de un intento, expuesto para S33 (cobro incierto) y para la
 * reconciliación manual autorizada. `STARTED` significa PROCESSING y
 * `UNKNOWN` significa resultado no confirmable: NINGUNO de los dos se
 * degrada a fallo por el solo paso del tiempo.
 */
export async function durableAttemptState(operationId: string, actor: Actor): Promise<{
  operationId: string; status: string; semantic: DurableAttemptState; responseStatus: number | null; responseBody: unknown; errorCode: string | null; completedAt: string | null;
}> {
  const rows = await database.client`select operation_id, status::text status, response_status "responseStatus", response_body "responseBody", error_code "errorCode", completed_at "completedAt" from system.operation_attempts where operation_id = ${operationId} and business_id = ${actor.businessId}`;
  const row = rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "Operation not found", 404);
  const status = String(row.status);
  const semantic: DurableAttemptState = status === "SUCCEEDED" ? "SUCCEEDED" : status === "FAILED" ? "FAILED" : status === "UNKNOWN" ? "UNKNOWN" : "PREPARED";
  return {
    operationId: String(row.operation_id),
    status,
    semantic,
    responseStatus: row.responseStatus === null ? null : Number(row.responseStatus),
    responseBody: row.responseBody,
    errorCode: row.errorCode === null ? null : String(row.errorCode),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt as Date).toISOString()
  };
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
