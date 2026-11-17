import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Simulador de terminal externa SOLO para QA.
 *
 * Es un archivo JSON separado de PostgreSQL: representa un resultado externo
 * que NO puede revertirse con un rollback local. NO es una integración real
 * con un banco ni con una terminal de pago.
 */
export type ExternalConfirmation = {
  simulator: "YOUNGKINGZ_QA_TERMINAL_SIMULATOR_V1";
  operationId: string;
  externalReference: string;
  evidenceReference: string;
  outcome: "CONFIRMED";
  confirmedAt: string;
};

const path = resolve(process.cwd(), "artifacts/h05/acceptance/external-terminal-simulation.json");

export async function confirmExternally(operationId: string): Promise<ExternalConfirmation> {
  const confirmation: ExternalConfirmation = {
    simulator: "YOUNGKINGZ_QA_TERMINAL_SIMULATOR_V1",
    operationId,
    externalReference: `SIM-TERM-${randomUUID().slice(0, 8)}`,
    evidenceReference: `SIM-EVIDENCE-${randomUUID().slice(0, 8)}`,
    outcome: "CONFIRMED",
    confirmedAt: new Date().toISOString()
  };
  await writeFile(path, JSON.stringify(confirmation, null, 2), "utf8");
  return confirmation;
}

export async function readExternalConfirmation(): Promise<ExternalConfirmation> {
  return JSON.parse(await readFile(path, "utf8")) as ExternalConfirmation;
}
