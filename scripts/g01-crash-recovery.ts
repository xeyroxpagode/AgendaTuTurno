/**
 * G01 / T083 — Crash/restart REAL con terminación forzada de proceso QA.
 *
 * Modos:
 *   seed    · prepara negocio, producto, caja y pedido READY; instala un trigger
 *             de QA que duerme 6s al fijar sale_id (ventana de interrupción).
 *   deliver · ejecuta order.deliver con un operationId determinista.
 *   resume  · tras matar el proceso, reintenta con el MISMO operationId.
 *
 * El trigger NO existe en el repositorio de migraciones: se crea y se elimina
 * únicamente en la base QA aislada (fallo inyectado identificado como tal).
 */
import { writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { roleCapabilities } from "@youngkingz/contracts";
import { database } from "../apps/api/src/lib/runtime.js";
import { orderRequest, orderConfirm, orderPrepare, orderReady, orderDeliver } from "../apps/api/src/modules/orders/commands.js";
import { assertQaDatabase, createSellableItem, openCash, seedActor, seedBusiness, op } from "../tests/h06/support.js";

const CONTEXT = "evidence/g01/crash-context.json";
const mode = process.argv[2] ?? "seed";

type Ctx = {
  businessId: string; operationId: string; orderId: string; sku: string;
  cashSessionId: string; accountId: string; staffMemberId: string;
  accessSessionId: string; roleAssignmentId: string;
};

async function loadCtx(): Promise<Ctx> {
  return JSON.parse(await readFile(CONTEXT, "utf8")) as Ctx;
}

function actorOf(ctx: Ctx) {
  return {
    accountId: ctx.accountId, personId: "", staffMemberId: ctx.staffMemberId,
    businessId: ctx.businessId, accessSessionId: ctx.accessSessionId,
    roleAssignmentId: ctx.roleAssignmentId, role: "OWNER" as const,
    contextRevision: 1, capabilities: new Set(roleCapabilities.OWNER), email: "g01-crash@qa.test"
  };
}

const deliverInput = (ctx: Ctx) => ({
  expectedRevision: 4,
  receiver: { kind: "CUSTOMER" as const, name: "Retiro Crash QA", verificationMethod: "DOCUMENT" as const },
  components: [{ method: "CASH" as const, amountMinor: 4500, outcome: "CONFIRMED" as const }],
  cashSessionId: ctx.cashSessionId
});

async function main() {
  await assertQaDatabase();
  if (mode === "seed") {
    const businessId = await seedBusiness("G01 Crash QA");
    const actor = await seedActor(businessId, "OWNER", "G01Crash");
    const item = await createSellableItem(actor, `CRH-${randomUUID().slice(0, 6)}`, 4500, 5);
    const cashSessionId = await openCash(actor);
    const created = await orderRequest({ kind: "STAFF", actor }, {
      businessId, lines: [{ sku: item.sku, quantity: 1 }]
    }, op());
    const orderId = String((created.data as { id: string }).id);
    const operationId = op();
    await orderConfirm(actor, orderId, { expectedRevision: 1 }, op());
    await orderPrepare(actor, orderId, { expectedRevision: 2 }, op());
    await orderReady(actor, orderId, { expectedRevision: 3, verifiedLines: [{ sku: item.sku, quantity: 1 }] }, op());
    const ctx: Ctx = {
      businessId, operationId, orderId, sku: item.sku, cashSessionId,
      accountId: actor.accountId, staffMemberId: actor.staffMemberId,
      accessSessionId: actor.accessSessionId, roleAssignmentId: actor.roleAssignmentId
    };
    await writeFile(CONTEXT, JSON.stringify(ctx, null, 2));
    await database.client.unsafe(`
      create or replace function g01_sleep_on_sale() returns trigger language plpgsql as $$
      begin perform pg_sleep(6); return new; end $$;
      drop trigger if exists g01_crash_sale on orders.product_orders;
      create trigger g01_crash_sale before update of sale_id on orders.product_orders
        for each row execute function g01_sleep_on_sale();
    `);
    console.log(JSON.stringify({ mode, ...ctx }));
    return;
  }
  const ctx = await loadCtx();
  const result = await orderDeliver(actorOf(ctx), ctx.orderId, deliverInput(ctx), ctx.operationId);
  console.log(JSON.stringify({ mode, status: (result.data as { status?: string }).status, operationId: ctx.operationId }));
}

void main()
  .then(async () => { await database.client.end({ timeout: 1 }); process.exit(0); })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
