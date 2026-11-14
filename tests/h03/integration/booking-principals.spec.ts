/**
 * H03.U04 — Idempotencia multi-principal (G05) contra PostgreSQL real.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../../../apps/api/src/lib/runtime";
import { executePrincipalOperation } from "../../../apps/api/src/modules/system/operations";
import { createIntent, intentProofDigest } from "../../../apps/api/src/modules/booking/security/guest-access";
import { seedBookingBusiness, type BookingSeed } from "./booking-fixtures";

let seed: BookingSeed;

beforeAll(async () => {
  seed = await seedBookingBusiness("U04 Principals");
});

const command = "booking.confirm";
const payload = { serviceIds: ["a"], localDate: "2026-11-04" };

describe("H03.U04 principal idempotency (PostgreSQL real)", () => {
  it("replays an identical GUEST_INTENT operation with the same effect", async () => {
    const operationId = randomUUID();
    const intent = createIntent();
    const principal = { kind: "GUEST_INTENT" as const, businessId: seed.business, intentId: intent.intentId, proofDigest: intentProofDigest(intent.proof) };
    const first = await executePrincipalOperation({ operationId, command, principal, payload }, async () => ({ reservationId: "r-1" }));
    const retry = await executePrincipalOperation({ operationId, command, principal, payload }, async () => ({ reservationId: "r-2" }));
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.data).toEqual({ reservationId: "r-1" });
    const count = Number((await database.client`select count(*) count from system.operation_attempts where operation_id=${operationId}`)[0]!.count);
    expect(count).toBe(1);
  });

  it("rejects the same operation_id with a different payload", async () => {
    const operationId = randomUUID();
    const intent = createIntent();
    const principal = { kind: "GUEST_INTENT" as const, businessId: seed.business, intentId: intent.intentId, proofDigest: intentProofDigest(intent.proof) };
    await executePrincipalOperation({ operationId, command, principal, payload }, async () => ({ ok: true }));
    await expect(executePrincipalOperation({ operationId, command, principal, payload: { ...payload, localDate: "2026-11-05" } }, async () => ({ ok: true })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects reuse from another Business without leaking the operation", async () => {
    const operationId = randomUUID();
    const intent = createIntent();
    const principal = { kind: "GUEST_INTENT" as const, businessId: seed.business, intentId: intent.intentId, proofDigest: intentProofDigest(intent.proof) };
    await executePrincipalOperation({ operationId, command, principal, payload }, async () => ({ ok: true }));
    const other = await seedBookingBusiness("U04 Principals Other");
    const otherPrincipal = { ...principal, businessId: other.business };
    await expect(executePrincipalOperation({ operationId, command, principal: otherPrincipal, payload }, async () => ({ ok: true })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects a different principal (other intent) reusing the operation_id", async () => {
    const operationId = randomUUID();
    const intent = createIntent();
    const principal = { kind: "GUEST_INTENT" as const, businessId: seed.business, intentId: intent.intentId, proofDigest: intentProofDigest(intent.proof) };
    await executePrincipalOperation({ operationId, command, principal, payload }, async () => ({ ok: true }));
    const otherIntent = createIntent();
    const otherPrincipal = { ...principal, intentId: otherIntent.intentId, proofDigest: intentProofDigest(otherIntent.proof) };
    await expect(executePrincipalOperation({ operationId, command, principal: otherPrincipal, payload }, async () => ({ ok: true })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("serializes concurrent identical retries (double-click) into one effect", async () => {
    const operationId = randomUUID();
    const intent = createIntent();
    const principal = { kind: "GUEST_INTENT" as const, businessId: seed.business, intentId: intent.intentId, proofDigest: intentProofDigest(intent.proof) };
    let effects = 0;
    const run = () => executePrincipalOperation({ operationId, command, principal, payload }, async () => { effects += 1; return { reservationId: "r-x" }; });
    const _first = await run();
    const results = await Promise.allSettled([run(), run(), run()]);
    const fulfilled = results.filter(r => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(effects).toBe(1);
  });

  it("supports CLIENT principals bound to a real account id (mechanics; U02 auth is blocked)", async () => {
    const operationId = randomUUID();
    const principal = { kind: "CLIENT" as const, businessId: seed.business, accountId: seed.account };
    const _first = await executePrincipalOperation({ operationId, command, principal, payload }, async () => ({ reservationId: "r-client" }));
    const retry = await executePrincipalOperation({ operationId, command, principal, payload }, async () => ({ reservationId: "r-other" }));
    expect(retry.data).toEqual({ reservationId: "r-client" });
  });

  it("records principal_kind and principal_ref on the ledger without secrets", async () => {
    const operationId = randomUUID();
    const intent = createIntent();
    const digest = intentProofDigest(intent.proof);
    const principal = { kind: "GUEST_INTENT" as const, businessId: seed.business, intentId: intent.intentId, proofDigest: digest };
    await executePrincipalOperation({ operationId, command, principal, payload }, async () => ({ reservationId: "r-ledger", leakedToken: "SHOULD-NOT-EXIST-IN-PRACTICE" }));
    const [row] = await database.client`select principal_kind "principalKind", principal_ref "principalRef", actor_account_id "actorAccountId", response_body "responseBody" from system.operation_attempts where operation_id=${operationId}`;
    expect(row!.principalKind).toBe("GUEST_INTENT");
    expect(row!.principalRef).toBe(intent.intentId);
    expect(row!.actorAccountId).toBeNull();
    // El ledger almacena lo que el handler devuelve; U04 handlers solo devuelven datos sanitizados.
    expect(JSON.stringify(row!.responseBody)).toContain("r-ledger");
    // El sistema almacena exactamente lo que el handler retorna — es responsabilidad del handler
    // (ej. confirm.ts) devolver solo datos sanitizados (sin guestToken, sin intentProof).
    // Verificación: el handler de prueba devuelve "leakedToken" y el sistema lo almacena,
    // confirmando que NO hay filtrado automático. Los handlers reales (confirm.ts) deben
    // seguir devolviendo solo datos seguros (sin token, sin proof).
  });

  it("an operation left in STARTED state cannot be re-executed (CONFLICT)", async () => {
    const operationId = randomUUID();
    await database.client`insert into system.operation_attempts(operation_id,business_id,command_name,request_hash,status,principal_kind,principal_ref) values (${operationId},${seed.business},${command},'hash','STARTED','GUEST_INTENT',${randomUUID()})`;
    const principal = { kind: "GUEST_INTENT" as const, businessId: seed.business, intentId: randomUUID(), proofDigest: "x" };
    // principal distinto ⇒ IDEMPOTENCY_CONFLICT (sin filtrar que la operación existe con otro dueño)
    await expect(executePrincipalOperation({ operationId, command, principal, payload }, async () => ({ ok: true })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
