import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { closeCashSession, createCashMovement, openCashSession } from "../../../apps/api/src/modules/cash/commands.js";
import { createMoneyOperation, resolveMoneyOperation } from "../../../apps/api/src/modules/money/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, op, seedActor, seedBusiness } from "../support.js";

/** H05 · CAP-05-04 Cash · escenarios F20–F27, F35. */
describe("H05 Cash (F20–F27, F35)", () => {
  let owner: Actor;
  let barber: Actor;
  let receptionA: Actor;
  let receptionB: Actor;

  beforeAll(async () => {
    await assertQaDatabase();
    const businessId = await seedBusiness("H05 Cash QA");
    owner = await seedActor(businessId, "OWNER", "Dueño");
    barber = await seedActor(businessId, "BARBER", "Barbero");
    receptionA = await seedActor(businessId, "RECEPTIONIST", "Cajera A");
    receptionB = await seedActor(businessId, "RECEPTIONIST", "Cajera B");
  });

  it("F20 · caja abre con fondo real y caja física identificada", async () => {
    const result = await openCashSession(owner, { cashboxName: "Caja Física 1", openingAmountMinor: 15_000 }, op());
    expect(result.data.status).toBe("OPEN");
    expect(result.data.openingAmountMinor).toBe(15_000);
    expect(result.data.cashboxId).toBeTruthy();
    await expect(openCashSession(owner, { cashboxName: "Caja Física 1", openingAmountMinor: 1_000 }, op()))
      .rejects.toMatchObject({ code: "CASH_SESSION_ALREADY_OPEN" });
  });

  it("F21 · dos operadores comparten sesión; cada movimiento conserva su actor", async () => {
    const [session] = await database.client`select id from cash.cash_sessions where business_id = ${owner.businessId} and status = 'OPEN' limit 1`;
    await createCashMovement(receptionA, { cashSessionId: String(session!.id), type: "INCOME", amountMinor: 2_000, reason: "Ingreso A" }, op());
    await createCashMovement(receptionB, { cashSessionId: String(session!.id), type: "EXPENSE", amountMinor: 500, reason: "Gasto B" }, op());
    const rows = await database.client`
      select actor_account_id "actorAccountId", amount_minor::int "amountMinor" from cash.cash_movements
       where cash_session_id = ${session!.id} and reason in ('Ingreso A','Gasto B') order by reason`;
    expect(rows).toHaveLength(2);
    const actors = rows.map((row) => String(row.actorAccountId));
    expect(actors).toContain(receptionA.accountId);
    expect(actors).toContain(receptionB.accountId);
  });

  it("F22/F23 · conteo cero válido; conteo obsoleto da STALE_REVISION", async () => {
    const [session] = await database.client`select id, revision::int revision from cash.cash_sessions where business_id = ${owner.businessId} and status = 'OPEN' limit 1`;
    await expect(closeCashSession(owner, String(session!.id), {
      countedAmountMinor: 16_000, expectedRevision: 999, reason: "Conteo descartado por obsoleto"
    }, op())).rejects.toMatchObject({ code: "STALE_REVISION" });
    // Conteo CERO con motivo es válido (F22). Se cierra con conteo distinto
    // del esperado y motivo explícito (F25).
    const result = await closeCashSession(owner, String(session!.id), {
      countedAmountMinor: 0, expectedRevision: Number(session!.revision), reason: "Conteo cero documentado"
    }, op());
    expect(result.data.countedAmountMinor).toBe(0);
    expect(result.data.differenceMinor).not.toBe(0);
  });

  it("F24 · dos cierres simultáneos: uno gana, el otro es rechazado", async () => {
    const opened = await openCashSession(owner, { cashboxName: "Caja Carrera", openingAmountMinor: 5_000 }, op());
    const id = String(opened.data.cashSessionId);
    const results = await Promise.allSettled([
      closeCashSession(owner, id, { countedAmountMinor: 5_000, expectedRevision: 1 }, op()),
      closeCashSession(owner, id, { countedAmountMinor: 5_000, expectedRevision: 1 }, op())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [session] = await database.client`select status::text status from cash.cash_sessions where id = ${id}`;
    expect(session!.status).toBe("CLOSED");
  });

  it("F26 · cierre bloqueado por UNKNOWN de efectivo y liberado tras resolución", async () => {
    const opened = await openCashSession(owner, { cashboxName: "Caja Unknown", openingAmountMinor: 1_000 }, op());
    const id = String(opened.data.cashSessionId);
    await createMoneyOperation(owner, {
      cashSessionId: id,
      components: [{ method: "CASH", amountMinor: 3_000, tenderedMinor: 3_000, changeMinor: 0, outcome: "UNKNOWN" }]
    }, op());
    await expect(closeCashSession(owner, id, { countedAmountMinor: 1_000, expectedRevision: 1 }, op()))
      .rejects.toMatchObject({ code: "CASH_CLOSE_BLOCKED_UNKNOWN" });
    const [money] = await database.client`select id from money.money_operations where business_id = ${owner.businessId} and status = 'UNKNOWN' order by created_at desc limit 1`;
    await resolveMoneyOperation(owner, String(money!.id), {
      outcome: "PROVEN_FAILED", evidenceReference: "Efectivo no recibido, comprobante verificado"
    }, op());
    const closed = await closeCashSession(owner, id, { countedAmountMinor: 1_000, expectedRevision: 1 }, op());
    expect(closed.data.status).toBe("CLOSED");
  });

  it("F27 · el logout no cierra la caja (la sesión operativa es independiente)", async () => {
    const opened = await openCashSession(owner, { cashboxName: "Caja Logout", openingAmountMinor: 4_000 }, op());
    await database.client`update iam.access_sessions set revoked_at = now(), revoked_reason = 'USER_TERMINATED' where id = ${owner.accessSessionId}`;
    const [session] = await database.client`select status::text status from cash.cash_sessions where id = ${opened.data.cashSessionId}`;
    expect(session!.status).toBe("OPEN");
    await database.client`update iam.access_sessions set revoked_at = null, revoked_reason = null where id = ${owner.accessSessionId}`;
  });

  it("F35 · BARBER no puede alterar caja", async () => {
    const opened = await openCashSession(owner, { cashboxName: "Caja Barbero", openingAmountMinor: 1_000 }, op());
    await expect(createCashMovement(barber, {
      cashSessionId: String(opened.data.cashSessionId), type: "INCOME", amountMinor: 100, reason: "Intento no autorizado"
    }, op())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(closeCashSession(barber, String(opened.data.cashSessionId), { countedAmountMinor: 1_000, expectedRevision: 1 }, op()))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
