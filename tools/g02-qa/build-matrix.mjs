/** Construye G02_CONTRACTUAL_QA_FINAL.csv desde la matriz original de 88 escenarios. */
import fs from "node:fs";
const SRC = "C:/Users/thega/Desktop/YKZ-H07-H08-IMPLEMENTATION-QA/H07_H08_FINAL_QA_TRACEABILITY.csv";
const OUT = "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE/03_CONTRACTUAL_QA/G02_CONTRACTUAL_QA_FINAL.csv";
const ev = {
  PASS: {
    "Q07-01": "smoke.mjs + journey_owner: create_draft",
    "Q07-02": "journey_owner: publish_course -> DB PUBLISHED",
    "Q07-06": "smoke.mjs: instructors=1 + session SCHEDULED",
    "Q07-07": "h07-courses.spec.ts: rechaza instructor de otro Business",
    "Q07-11": "h07-courses.spec.ts: ciclo completo + confirmar",
    "Q07-14": "h07-courses.spec.ts: dos confirmaciones concurrentes (1 ganador/SLOT_CONFLICT)",
    "Q07-16": "h07-courses.spec.ts: ausencia efectiva bloquea confirmación",
    "Q07-17": "h07-courses.spec.ts: DST inexistente/ambigua rechazada",
    "Q07-24": "e18_results.json: public key listing + journey public_discovery",
    "Q07-27": "h07-courses.spec.ts: publicación oculta borradores + e18 draft_not_exposed",
    "Q08-01": "h08-settlement.spec.ts: acuerdo versionado 10% sobre 100000=10000",
    "Q08-07": "h08-settlement.spec.ts: comisión REALIZED sobre attendance elegible",
    "Q08-09": "h08-settlement.spec.ts: P0 EGM COLLECTED refund_of_id por venta",
    "Q08-13": "h08-settlement.spec.ts: estimación reproducible",
    "Q08-18": "h08-settlement.spec.ts: cierre inmutable + obligación H05",
    "Q08-19": "h08-settlement.spec.ts: doble cierre rechazado",
    "Q08-23": "e08_results.json: pago parcial 1000/8000 con saldo 7000 auditado",
    "Q08-27": "h08-settlement.spec.ts: refund posterior, base neta 3000, comisión 300",
    "Q08-30": "journey_owner: history_visible",
    "QX-01": "h07 + h08: cross-business denegado",
    "QX-02": "h08-settlement.spec.ts: CL-13 Barber sólo su economía",
    "NEW-01": "h07-courses.spec.ts: sesión confirmada + ausencia efectiva",
    "NEW-04": "h07-courses.spec.ts: DST rechazada",
    "NEW-06": "h07/h08 cross-business: businessId ajeno denegado",
    "NEW-08": "h08-settlement.spec.ts: NOT_CONFIGURED sin acuerdo",
    "NEW-10": "31/31 migraciones + h07 integración"
  },
  BLOCKED: {
    "Q07-03": "Sin retest vigente de despublicación en navegador",
    "Q07-04": "Sin retest vigente de edición en navegador",
    "Q07-05": "Sin retest vigente de publicar sin sesiones",
    "Q07-08": "Sin evidencia de selector real persistido en UI",
    "Q07-09": "Sin evidencia vigente de medianoche",
    "Q07-10": "Sin evidencia de dos sesiones mismo courseId en UI",
    "Q07-12": "SLOT_CONFLICT observado (probe-confirm) pero sin journey cliente↔curso completo",
    "Q07-13": "Sin journey completo curso→booking",
    "Q07-15": "Sin evidencia de dos comandos simultáneos mismo sessionId en browser (si en test)",
    "Q07-18": "Sin retest vigente de reprogramación (slot ocupado en el journey)",
    "Q07-19": "Sin evidencia de fallo a mitad de reprogramación",
    "Q07-20": "journey_owner cancel_session ejecutado; sin oráculo DB de liberación",
    "Q07-21": "Sin evidencia",
    "Q07-22": "Sin evidencia de realización manual",
    "Q07-23": "Sin evidencia de sesión pasada sin acción",
    "Q07-25": "Sin evidencia de intento de matrícula (endpoint ausente)",
    "Q07-26": "Sin evidencia de intento de pago de curso",
    "Q07-28": "Responsive parcial (390/1440); faltan 320/410/430/768/1024",
    "Q07-29": "Sin evidencia de contacto público",
    "Q07-30": "Historial visible en UI; sin verificación de versiones",
    "Q08-02": "Sin oráculo independiente de FIXED aislado",
    "Q08-03": "Sin oráculo de RENT receivable",
    "Q08-04": "Sin oráculo de mixto sin duplicado",
    "Q08-05": "Sin evidencia vigente de superposición rechazada",
    "Q08-06": "Sin evidencia de Staff sin acuerdo en UI",
    "Q08-08": "Sin evidencia de cancelada/no-show sin comisión",
    "Q08-10": "Sin evidencia de dinero UNKNOWN",
    "Q08-11": "Sin evidencia de mixto con pago parcial",
    "Q08-12": "Sin evidencia de reintento por misma fuente",
    "Q08-14": "periodFixedRent implementado; sin oráculo de cambio a mitad de período",
    "Q08-15": "Sin evidencia",
    "Q08-16": "Sin evidencia de descuentos",
    "Q08-17": "Sin evidencia",
    "Q08-20": "Sin evidencia de replay tras timeout",
    "Q08-21": "Sin evidencia de snapshot inmutable tras nuevo acuerdo",
    "Q08-22": "Sin evidencia de revalidación preview↔cierre",
    "Q08-24": "Sin evidencia de pago total",
    "Q08-25": "Sin evidencia de RENT cobrado",
    "Q08-26": "Sin evidencia de mixto payable+receivable",
    "Q08-28": "Sin evidencia de refund antes de cierre",
    "Q08-29": "Sin evidencia de corrección repetida",
    "QX-03": "Sin evidencia de revocación entre preview y commit",
    "QX-04": "Sin evidencia de multirol",
    "QX-05": "Sin evidencia de CourseSession→Money",
    "QX-06": "Sin evidencia de Settlement→occupancy",
    "QX-07": "Sin kill real",
    "QX-08": "31 migraciones; sin prueba de upgrade limpio en esta campaña",
    "QX-09": "Regresión H01-H06 parcial (VER h05/h06-regression.log)",
    "QX-10": "Playwright ejecutado; faltan 7 viewports y journeys A-M completos",
    "NEW-02": "Sin evidencia",
    "NEW-03": "Sin oráculo de doble cierre con operation_id distinto en browser",
    "NEW-05": "e08_results.json: grant scope BUSINESS, emisión/revocación",
    "NEW-07": "Matriz 88 preservada; discrepancy documentado",
    "NEW-09": "Sin evidencia de traductor 22000/23514",
    "NEW-11": "Sin evidencia",
    "NEW-12": "Sin evidencia",
    "NEW-13": "Sin evidencia",
    "NEW-14": "Sin evidencia",
    "NEW-15": "Sin evidencia",
    "NEW-16": "Sin evidencia",
    "NEW-17": "Sin evidencia de includeDiscounts",
    "NEW-18": "typecheck PASS con espejo bigint"
  }
};
const csv = fs.readFileSync(SRC, "utf8").trim().split(/\r?\n/);
const header = csv[0];
const rows = csv.slice(1).map((line) => {
  const m = line.match(/^"([^"]+)","([^"]+)","([^"]+)","((?:[^"]|"")*)"[,](.*)$/);
  if (!m) return line;
  const id = m[1];
  let status = "NOT_RUN", evidence = "Sin evidencia vigente en esta campaña";
  if (ev.PASS[id]) { status = "PASS"; evidence = ev.PASS[id]; }
  else if (ev.BLOCKED[id]) { status = "BLOCKED"; evidence = ev.BLOCKED[id]; }
  const cols = line.split('","');
  cols[13] = status;
  cols[14] = evidence;
  return cols.join('","');
});
fs.writeFileSync(OUT, [header, ...rows].join("\n"), "utf8");
const counts = rows.reduce((a, r) => { const s = r.split('","')[13]; a[s] = (a[s] ?? 0) + 1; return a; }, {});
console.log(JSON.stringify({ total: rows.length, counts, out: OUT }, null, 2));
