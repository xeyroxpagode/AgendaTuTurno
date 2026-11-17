/**
 * Harness de QA — NO es código productivo.
 *
 * Proceso backend aislado que puede interrumpirse abruptamente para demostrar
 * F40 (crash recovery). No expone endpoints, flags ni rutas en la aplicación.
 * Recibe la identidad del Actor desde el proceso coordinador de la prueba.
 */
import { writeFile } from "node:fs/promises";
import { roleCapabilities, type RoleCode } from "@youngkingz/contracts";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createMoneyOperation, resolveMoneyOperation } from "../../../apps/api/src/modules/money/commands.js";
import { durableAttemptState } from "../../../apps/api/src/modules/system/operations.js";

type Args = {
  mode: "prepare" | "query" | "recover";
  out: string;
  operationId: string;
  moneyOperationId: string;
  accountId: string;
  personId: string;
  staffMemberId: string;
  businessId: string;
  roleAssignmentId: string;
  accessSessionId: string;
  role: RoleCode;
  reconciliationOperationId: string;
};

function parseArgs(): Args {
  const map = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    map.set(process.argv[index]!.replace(/^--/, ""), process.argv[index + 1] ?? "");
  }
  return {
    mode: map.get("mode") as Args["mode"],
    out: map.get("out") ?? "",
    operationId: map.get("operationId") ?? "",
    moneyOperationId: map.get("moneyOperationId") ?? "",
    accountId: map.get("accountId") ?? "",
    personId: map.get("personId") ?? "",
    staffMemberId: map.get("staffMemberId") ?? "",
    businessId: map.get("businessId") ?? "",
    roleAssignmentId: map.get("roleAssignmentId") ?? "",
    accessSessionId: map.get("accessSessionId") ?? "",
    role: (map.get("role") ?? "OWNER") as RoleCode,
    reconciliationOperationId: map.get("reconciliationOperationId") ?? ""
  };
}

async function main() {
  const args = parseArgs();
  const actor = {
    accountId: args.accountId,
    personId: args.personId,
    staffMemberId: args.staffMemberId,
    businessId: args.businessId,
    roleAssignmentId: args.roleAssignmentId,
    accessSessionId: args.accessSessionId,
    role: args.role,
    contextRevision: 1,
    capabilities: new Set(roleCapabilities[args.role]),
    email: "recovery-worker@h05.test"
  } as Actor;

  if (args.mode === "prepare") {
    // El componente externo NO confirmado obliga al camino durable: el intento
    // se COMMITEA antes de cualquier efecto externo (Frontera de Preparación).
    const result = await createMoneyOperation(actor, {
      components: [{ method: "CARD", amountMinor: 3_000, outcome: "UNKNOWN" }]
    }, args.operationId);
    await writeFile(args.out, JSON.stringify({
      pid: process.pid,
      moneyOperationId: result.data.id,
      status: result.data.status,
      confirmedMinor: result.data.confirmedMinor,
      writtenAt: new Date().toISOString()
    }));
    // Permanece vivo hasta que el coordinador lo interrumpa abruptamente.
    setInterval(() => undefined, 1000);
    return;
  }

  if (args.mode === "query") {
    const attempt = await durableAttemptState(args.operationId, actor);
    await writeFile(args.out, JSON.stringify({ pid: process.pid, attempt }));
    process.exit(0);
  }

  if (args.mode === "recover") {
    const resolved = await resolveMoneyOperation(actor, args.moneyOperationId, {
      outcome: "SUCCEEDED",
      evidenceReference: "TERMINAL-RECEIPT-AFTER-RESTART"
    }, args.reconciliationOperationId);
    const attempt = await durableAttemptState(args.operationId, actor);
    await writeFile(args.out, JSON.stringify({
      pid: process.pid,
      status: resolved.data.status,
      confirmedMinor: resolved.data.confirmedMinor,
      attempt
    }));
    process.exit(0);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
