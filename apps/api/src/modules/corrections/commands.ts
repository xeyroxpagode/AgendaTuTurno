import { DomainError, createCorrectionSchema } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { audit, executeOperation, type Tx } from "../system/operations.js";
import { conflict, lockBusiness, missing, requireCapability } from "../h05/domain.js";
import { performMovementCorrection } from "../inventory/commands.js";
import { correctSale } from "../sales/commands.js";
import { loadMoneyOperation } from "../money/domain.js";

/**
 * H05 · CAP-05-07 Corrections · comandos.
 *
 * Una corrección es un HECHO POSTERIOR que conserva el original (D14/D26):
 *  · el motivo es obligatorio;
 *  · el before/after queda registrado;
 *  · el hecho original NO se reescribe para ocultar errores;
 *  · una corrección financiera NO genera una devolución física;
 *  · una corrección física NO genera un movimiento monetario.
 *
 * Cada tipo exige SU capability, no una genérica:
 *  · COMMERCIAL → `sales.correct`
 *  · MONETARY  → `money.refund` (la devolución de dinero es un refund; la
 *    corrección monetaria sólo rectifica METADATOS y no genera dinero)
 *  · CASH      → `cash.adjust`
 *  · PHYSICAL  → `inventory.adjust`
 *
 * Todas exigen además `corrections.create`: registrar una corrección es un
 * acto administrativo propio.
 */
export async function createCorrection(actor: Actor, body: unknown, operationId: string) {
  requireCapability(actor, "corrections.create");
  const input = createCorrectionSchema.parse(body);

  if (input.type === "COMMERCIAL") {
    requireCapability(actor, "sales.correct");
    // La corrección comercial la materializa el módulo de ventas (que ya
    // registra el before/after en `corrections.corrections`).
    return correctSale(actor, input.targetId, {
      reason: input.reason,
      expectedRevision: (await currentSaleRevision(actor, input.targetId)),
      lines: input.lines
    }, operationId);
  }

  if (input.type === "PHYSICAL") {
    requireCapability(actor, "inventory.adjust");
    return executeOperation({
      actor, operationId, command: "correction.physical", payload: input
    }, async (tx) => {
      await lockBusiness(tx, actor.businessId);
      const [movement] = await tx`select id, kind::text kind, business_id "businessId" from inventory.movements where business_id = ${actor.businessId} and id = ${input.targetId}`;
      if (!movement) throw missing("ese movimiento de inventario");
      if (String(movement.kind) === "DELIVERY") {
        throw conflict("La entrega se corrige mediante el contrato causal del dominio propietario");
      }
      const before = await movementSnapshot(tx, actor.businessId, input.targetId);
      const [correction] = await tx`
        insert into corrections.corrections(business_id,operation_id,type,target_type,target_id,status,reason,evidence_reference,before_snapshot,after_snapshot,actor_account_id)
        values (${actor.businessId},${operationId},'PHYSICAL','INVENTORY_MOVEMENT',${input.targetId},'PENDING',${input.reason},${input.evidenceReference ?? null},
                ${JSON.stringify(before)}::jsonb,${JSON.stringify({ pending: true })}::jsonb,${actor.accountId})
        returning id`;
      const result = await performMovementCorrection(tx, actor, input.targetId, input.reason, operationId);
      const after = await movementSnapshot(tx, actor.businessId, input.targetId);
      await tx`
        update corrections.corrections set status='APPLIED', after_snapshot=${JSON.stringify(after)}::jsonb where business_id=${actor.businessId} and id=${correction!.id}`;
      await audit(tx, {
        actor, operationId, action: "correction.physical", capability: "inventory.adjust",
        resourceType: "INVENTORY_MOVEMENT", resourceId: input.targetId,
        changes: { correctionId: String(correction!.id), reason: input.reason, movementId: result.movementId }
      });
      return { correctionId: String(correction!.id), ...result };
    });
  }

  if (input.type === "CASH") {
    requireCapability(actor, "cash.adjust");
    return executeOperation({
      actor, operationId, command: "correction.cash", payload: input
    }, async (tx) => {
      await lockBusiness(tx, actor.businessId);
      const [session] = await tx`select id, status::text status, revision::int revision from cash.cash_sessions where business_id = ${actor.businessId} and id = ${input.targetId} for update`;
      if (!session) throw missing("esa sesión de caja");
      if (session.status !== "OPEN") throw new DomainError("CASH_SESSION_CLOSED", "La sesión de caja está cerrada", 409);
      const before = await cashSessionSnapshot(tx, actor.businessId, input.targetId);
      const [correction] = await tx`
        insert into corrections.corrections(business_id,operation_id,type,target_type,target_id,status,reason,evidence_reference,before_snapshot,after_snapshot,actor_account_id)
        values (${actor.businessId},${operationId},'CASH','CASH_SESSION',${input.targetId},'PENDING',${input.reason},${input.evidenceReference ?? null},
                ${JSON.stringify(before)}::jsonb,${JSON.stringify({ pending: true })}::jsonb,${actor.accountId})
        returning id`;
      await tx`
        insert into cash.cash_movements(business_id,cash_session_id,type,amount_minor,reason,correction_id,actor_account_id,operation_id)
        values (${actor.businessId},${input.targetId},${input.direction},${input.amountMinor},${input.reason},${correction!.id},${actor.accountId},${operationId})`;
      const after = await cashSessionSnapshot(tx, actor.businessId, input.targetId);
      await tx`
        update corrections.corrections set status='APPLIED', after_snapshot=${JSON.stringify(after)}::jsonb where business_id=${actor.businessId} and id=${correction!.id}`;
      await audit(tx, {
        actor, operationId, action: "correction.cash", capability: "cash.adjust",
        resourceType: "CASH_SESSION", resourceId: input.targetId,
        changes: { correctionId: String(correction!.id), reason: input.reason, amountMinor: input.amountMinor, direction: input.direction }
      });
      return { correctionId: String(correction!.id), ...after };
    });
  }

  // MONETARY: rectifica METADATOS y evidencia del cobro. NO genera dinero
  // nuevo, NO muta importes y NO devuelve stock.
  requireCapability(actor, "money.refund");
  return executeOperation({
    actor, operationId, command: "correction.monetary", payload: input
  }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const operation = await loadMoneyOperation(tx, actor.businessId, input.targetId, true);
    const before = await moneyMetadataSnapshot(tx, actor.businessId, input.targetId);
    const [correction] = await tx`
      insert into corrections.corrections(business_id,operation_id,type,target_type,target_id,status,reason,evidence_reference,before_snapshot,after_snapshot,actor_account_id)
      values (${actor.businessId},${operationId},'MONETARY','MONEY_OPERATION',${input.targetId},'PENDING',${input.reason},${input.evidenceReference ?? null},
              ${JSON.stringify(before)}::jsonb,${JSON.stringify({ pending: true })}::jsonb,${actor.accountId})
      returning id`;
    await tx`
      update money.money_components
         set evidence_reference=coalesce(evidence_reference, ${input.evidenceReference ?? null})
       where business_id = ${actor.businessId} and money_operation_id = ${input.targetId}`;
    const after = await moneyMetadataSnapshot(tx, actor.businessId, input.targetId);
    await tx`
      update corrections.corrections set status='APPLIED', after_snapshot=${JSON.stringify(after)}::jsonb where business_id=${actor.businessId} and id=${correction!.id}`;
    await audit(tx, {
      actor, operationId, action: "correction.monetary", capability: "money.refund",
      resourceType: "MONEY_OPERATION", resourceId: input.targetId,
      changes: { correctionId: String(correction!.id), reason: input.reason, operationId: operation.operationId }
    });
    return { correctionId: String(correction!.id), ...after };
  });
}

async function currentSaleRevision(actor: Actor, saleId: string): Promise<number> {
  const { database } = await import("../../lib/runtime.js");
  const rows = await database.client`select revision::int revision from sales.sales where business_id = ${actor.businessId} and id = ${saleId}`;
  const row = rows[0];
  if (!row) throw missing("esa venta");
  return Number(row.revision);
}

async function movementSnapshot(tx: Tx, businessId: string, movementId: string) {
  const rows = await tx`
    select id, kind::text kind, reason, source_reference "sourceReference", discrepancy, created_at "createdAt"
      from inventory.movements where business_id = ${businessId} and id = ${movementId}`;
  const entries = await tx`
    select sku, location_id "locationId", purpose, delta from inventory.entries where business_id = ${businessId} and movement_id = ${movementId} order by sku, location_id`;
  return { movement: rows[0] ?? null, entries };
}

async function cashSessionSnapshot(tx: Tx, businessId: string, cashSessionId: string) {
  const rows = await tx`
    select id, status::text status, opening_amount_minor::int "openingAmountMinor", revision::int revision
      from cash.cash_sessions where business_id = ${businessId} and id = ${cashSessionId}`;
  const movements = await tx`
    select id, type::text type, amount_minor::int "amountMinor", reason, created_at "createdAt"
      from cash.cash_movements where business_id = ${businessId} and cash_session_id = ${cashSessionId} order by created_at, id`;
  return { session: rows[0] ?? null, movements };
}

async function moneyMetadataSnapshot(tx: Tx, businessId: string, moneyOperationId: string) {
  const rows = await tx`
    select id, status::text status, kind::text kind, amount_minor::int "amountMinor",
           confirmed_minor::int "confirmedMinor", change_minor::int "changeMinor", note
      from money.money_operations where business_id = ${businessId} and id = ${moneyOperationId}`;
  const components = await tx`
    select id, method::text method, outcome::text outcome, amount_minor::int "amountMinor",
           external_reference "externalReference", evidence_reference "evidenceReference"
      from money.money_components where business_id = ${businessId} and money_operation_id = ${moneyOperationId} order by position`;
  return { operation: rows[0] ?? null, components };
}
