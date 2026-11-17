import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createCheckout, resumeCheckout } from "../../../apps/api/src/modules/checkout/commands.js";
import { resolveMoneyOperation } from "../../../apps/api/src/modules/money/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, createProductSale, createSellableItem, openCash, op, seedActor, seedBusiness } from "../support.js";
import { clearQaFaults, installQaFaults, removeQaFaults, setQaFault, type QaFaultStage } from "../faults/qa-faults.js";
import { confirmExternally, readExternalConfirmation } from "../faults/external-terminal.js";

/**
 * F46 (cierre focalizado) ·
 *  A) Atomicidad local: fallos inducidos en 5 puntos de la transacción.
 *  B) Pago externo confirmado + entrega fallida + recuperación sobre el MISMO
 *     intento, sin segundo cobro ni entrega duplicada.
 *
 * El proveedor externo es un simulador QA explícito, no una integración real.
 */
describe("H05 F46 cierre — atomicidad y efecto externo", () => {
  let owner: Actor;
  let cashSessionId: string;

  beforeAll(async () => {
    await assertQaDatabase();
    owner = await seedActor(await seedBusiness("H05 F46 Closure"), "OWNER", "Dueño");
    cashSessionId = (await openCash(owner)).cashSessionId;
    await installQaFaults(database.client);
  });

  afterAll(async () => {
    await removeQaFaults(database.client);
  });

  async function freshSale(quantity = 2): Promise<{ saleId: string; sku: string; locationId: string }> {
    const item = await createSellableItem(owner, `F46C-${randomUUID().slice(0, 6)}`, 5_000, quantity);
    const saleId = await createProductSale(owner, item.sku, item.locationId, 1, 5_000);
    return { saleId, sku: item.sku, locationId: item.locationId };
  }

  describe("A · atomicidad PostgreSQL", () => {
    const stages: QaFaultStage[] = ["sale_confirm", "money_operation", "money_allocation", "cash_movement", "commitment"];

    for (const stage of stages) {
      it(`fallo en ${stage}: rollback completo, sin combinación inconsistente`, async () => {
        const { saleId } = await freshSale();
        const operationId = op();
        try {
          await setQaFault(database.client, stage);
          await expect(createCheckout(owner, {
            saleId,
            components: [{ method: "CASH", amountMinor: 5_000, changeMinor: 0 }],
            cashSessionId,
            deliver: true
          }, operationId)).rejects.toThrow();
        } finally {
          await clearQaFaults(database.client);
        }

        const [sale] = await database.client`select status::text status from sales.sales where id = ${saleId}`;
        expect(String(sale!.status)).toBe("DRAFT");
        const [checkout] = await database.client`select id from checkout.checkouts where operation_id = ${operationId}`;
        expect(checkout).toBeUndefined();
        const [money] = await database.client`select id from money.money_operations where operation_id = ${operationId}`;
        expect(money).toBeUndefined();
        const [cash] = await database.client`select id from cash.cash_movements where operation_id = ${operationId}`;
        expect(cash).toBeUndefined();
        const [commitment] = await database.client`select id from inventory.commitments where operation_id = ${operationId}`;
        expect(commitment).toBeUndefined();
        const [attempt] = await database.client`select status::text status from system.operation_attempts where operation_id = ${operationId}`;
        expect(String(attempt!.status)).toBe("FAILED"); // fallo PROBADO, no UNKNOWN
      });
    }

    it("fallo en delivery_movement: dinero local se conserva e incidencia es recuperable", async () => {
      const { saleId, sku } = await freshSale();
      const operationId = op();
      try {
        await setQaFault(database.client, "delivery_movement");
        const result = await createCheckout(owner, {
          saleId, components: [{ method: "CASH", amountMinor: 5_000, changeMinor: 0 }], cashSessionId, deliver: true
        }, operationId);
        expect(result.data.status).toBe("DELIVERY_PENDING");
        const [money] = await database.client`select status::text status from money.money_operations where operation_id = ${operationId}`;
        expect(String(money!.status)).toBe("SUCCEEDED");
        const [deliveries] = await database.client`
          select count(*)::int n from inventory.movements m
          join inventory.entries e on e.business_id = m.business_id and e.movement_id = m.id
         where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and e.sku = ${sku}`;
        expect(Number(deliveries!.n)).toBe(0);
      } finally {
        await clearQaFaults(database.client);
      }
    });
  });

  describe("B · pago externo confirmado + entrega fallida", () => {
    it("incidencia explícita, recuperación sobre el mismo intento y sin duplicación", async () => {
      const { saleId, sku, locationId } = await freshSale(2);
      const operationId = op();

      // Paso 1 — preparación durable del intento externo.
      const prepared = await createCheckout(owner, {
        saleId,
        components: [{ method: "CARD", amountMinor: 5_000, outcome: "UNKNOWN" }],
        deliver: false
      }, operationId);
      expect(prepared.data.status).toBe("UNKNOWN");
      expect(prepared.data.confirmedMinor).toBe(0);
      const checkoutId = String(prepared.data.id);
      const moneyId = String(prepared.data.moneyOperationId);

      // Paso 2 — confirmación del simulador QA (resultado estable y externo).
      const confirmation = await confirmExternally(operationId);
      const resolved = await resolveMoneyOperation(owner, moneyId, {
        outcome: "SUCCEEDED", evidenceReference: confirmation.evidenceReference
      }, op());
      expect(resolved.data.status).toBe("SUCCEEDED");
      expect(resolved.data.confirmedMinor).toBe(5_000);
      const simulated = await readExternalConfirmation();
      expect(simulated.confirmedAt).toBe(confirmation.confirmedAt);

      const [checkoutAfterResolve] = await database.client`select status::text status from checkout.checkouts where id = ${checkoutId}`;
      expect(String(checkoutAfterResolve!.status)).toBe("MONEY_CONFIRMED");

      // Paso 3 — fallo físico inducido DESPUÉS del dinero confirmado.
      await database.client`update inventory.locations set active = false where business_id = ${owner.businessId} and id = ${locationId}`;
      const [beforeResume] = await database.client`select revision::int revision from checkout.checkouts where id = ${checkoutId}`;
      const failed = await resumeCheckout(owner, checkoutId, {
        resolution: "DELIVER", reason: "Falla física inducida en QA", expectedRevision: Number(beforeResume!.revision)
      }, op());
      expect(failed.data.status).toBe("DELIVERY_PENDING");
      expect(failed.data.incidentReason).toBeTruthy();

      // Paso 4 — verificación de la incidencia y del dinero conservado.
      const [money] = await database.client`
        select status::text status, confirmed_minor::int "confirmedMinor", refund_of_id "refundOfId"
          from money.money_operations where id = ${moneyId}`;
      expect(String(money!.status)).toBe("SUCCEEDED");
      expect(Number(money!.confirmedMinor)).toBe(5_000);
      expect(money!.refundOfId).toBeNull();
      const [component] = await database.client`
        select method::text method, outcome::text outcome,
               external_reference "externalReference", evidence_reference "evidenceReference"
          from money.money_components where money_operation_id = ${moneyId}`;
      expect(String(component!.method)).toBe("CARD");
      expect(String(component!.outcome)).toBe("CONFIRMED");
      expect(String(component!.evidenceReference)).toBe(confirmation.evidenceReference);
      const [cash] = await database.client`select id from cash.cash_movements where money_operation_id = ${moneyId}`;
      expect(cash).toBeUndefined(); // tarjeta nunca genera efectivo
      const [deliveries] = await database.client`
        select count(*)::int n from inventory.movements m
        join inventory.entries e on e.business_id = m.business_id and e.movement_id = m.id
       where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and e.sku = ${sku}`;
      expect(Number(deliveries!.n)).toBe(0);
      const [positionPending] = await database.client`
        select physical::int physical from inventory.positions
         where business_id = ${owner.businessId} and sku = ${sku} and purpose = 'SALE'`;
      expect(Number(positionPending!.physical)).toBe(2);
      const [commitmentPending] = await database.client`
        select state::text state from inventory.commitments where business_id = ${owner.businessId} and source_reference = ${failed.data.sourceReference}`;
      expect(String(commitmentPending!.state)).toBe("ACTIVE");

      // Paso 5 — recuperación autorizada sobre el MISMO checkout y dinero.
      await database.client`update inventory.locations set active = true where business_id = ${owner.businessId} and id = ${locationId}`;
      const [beforeRecovery] = await database.client`select revision::int revision from checkout.checkouts where id = ${checkoutId}`;
      const recovered = await resumeCheckout(owner, checkoutId, {
        resolution: "DELIVER", reason: "Ubicación reactivada, entrega reintentada", expectedRevision: Number(beforeRecovery!.revision)
      }, op());
      expect(recovered.data.status).toBe("DELIVERED");

      // Paso 6 — repetir consulta y recuperación: idempotencia.
      await expect(resumeCheckout(owner, checkoutId, {
        resolution: "DELIVER", reason: "Reintento posterior", expectedRevision: recovered.data.revision
      }, op())).rejects.toMatchObject({ code: "CHECKOUT_ALREADY_DELIVERED" });

      const [moneyCount] = await database.client`
        select count(*)::int n from money.money_operations where business_id = ${owner.businessId} and operation_id = ${operationId}`;
      const [allocationCount] = await database.client`select count(*)::int n from money.money_allocations where money_operation_id = ${moneyId}`;
      const [deliveryCount] = await database.client`
        select count(*)::int n from inventory.movements m
        join inventory.entries e on e.business_id = m.business_id and e.movement_id = m.id
       where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and e.sku = ${sku}`;
      const [positionFinal] = await database.client`
        select physical::int physical from inventory.positions
         where business_id = ${owner.businessId} and sku = ${sku} and purpose = 'SALE'`;
      const actions = await database.client`
        select action, outcome from system.audit_events
         where business_id = ${owner.businessId}
           and (resource_id = ${checkoutId} or resource_id = ${moneyId})
         order by occurred_at`;
      const names = actions.map((row) => String(row.action));
      expect(names).toContain("checkout.create");
      expect(names).toContain("money.resolve_succeeded");
      expect(names).toContain("checkout.delivery_pending");
      expect(names).toContain("checkout.delivered");
      expect(Number(moneyCount!.n)).toBe(1);
      expect(Number(allocationCount!.n)).toBe(1);
      expect(Number(deliveryCount!.n)).toBe(1);
      expect(Number(positionFinal!.physical)).toBe(1);
      const simulatedAgain = await readExternalConfirmation();
      expect(simulatedAgain.confirmedAt).toBe(confirmation.confirmedAt); // NO se reejecutó el cobro externo
    });
  });
});
