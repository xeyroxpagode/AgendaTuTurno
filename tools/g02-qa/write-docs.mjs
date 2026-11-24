import fs from "node:fs";
const D = "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE";
const w = (f, c) => fs.writeFileSync(`${D}/${f}`, c, "utf8");

w("G02_SECURITY_CONCURRENCY_RECOVERY.md", `# G02 — Seguridad, concurrencia y recovery

## IAM y aislamiento (evidencia confirmada)
- **Cross-business**: tests H07 y H08 confirman que un actor de B2 no ve ni opera sobre B1 (404/403, cero escrituras).
- **Cross-professional**: CL-13 se valida en servidor (\`settlement/self.ts\`);Owner no tiene acceso a economía propia; Barber sólo lee la suya (\`h08-settlement.spec.ts\`).
- **Scope**: \`revalidateAuthority\` consulta grants vigentes con \`FOR SHARE\` inmediatamente antes del commit; el scope \`staffMemberId\` se comprueba contra el grant.
- **Grant financiero (E-08)**: emisión legítima por \`iam.grants.issue\`, denegación sin grant, pago auditado con actor Recepción, revocación y denegación posterior. Grant persistido con \`scope={"type":"BUSINESS"}\`.
- **UI comunica autoridad**: \`FinanceWorkspace\` condiciona el botón de pago a \`can("obligations.pay")\`; H08 devuelve \`ECONOMY_FORBIDDEN\` accionable.

## Concurrencia
- Dos confirmaciones simultáneas con solape total: **un ganador + SLOT_CONFLICT** (\`h07-courses.spec.ts\`).
- Doble cierre de liquidación: **un settlement canónico**, segundo rechazado (\`h08-settlement.spec.ts\`).
- \`SLOT_CONFLICT\` observado en vivo al intentar confirmar un slot ya ocupado (\`probe-confirm.mjs\`) → la ocupación canónica se respeta.

## Recovery
- Idempotencia centralizada en \`system.operation_attempts\` con \`operationId\`, hash de payload y principal.
- Replay del mismo intento: respuesta cacheada (\`replayed: true\`).
- Diferencia de payload con mismo \`operationId\` → \`IDEMPOTENCY_CONFLICT\`.
- **Pendiente de evidencia en esta campaña**: timeout antes/después de commit, kill real, UNKNOWN y revocación en vuelo (QX-03/QX-07 → BLOCKED en la matriz). Se preservan los resultados del dossier anterior y no se declaran como propios.

## Migraciones
31/31 aplicadas en \`youngkingz_h07_qa_20261124\` (última \`202611240009\`). Sin migraciones productivas.
`);

w("G02_ACTOR_EXPERIENCE_REPORT.md", `# G02 — Experiencia real del producto por actor

Observaciónautónoma del agente representando a cada actor (no usuarios humanos externos).

## Owner
Entró con login real, encontró Cursos por navegación, creó oferta con un formulario comprensible (título, resumen, contacto), guardó borrador, lo editó, navegó a Sesiones, seleccionó instructor real, fecha y hora, programó, publicó y verificó el resultado en discovery público. En Economía pudo ver acuerdos/liquidaciones y conceder el grant financiero a Recepción desde Equipo.
**Fricción corregida**: el selector de instructor estaba vacío por un desajuste de envelope H02↔H07 (G02-D04); tras el correctivo carga 1 profesional elegible.

## Reception
Accedió con su identidad real. Sin grant, el intento de pago fue denegado con \`ECONOMY_FORBIDDEN\`; con grant emitido por Owner completó un pago de 1000 sobre una obligación de 8000, con saldo 7000 y auditoría de su cuenta. Tras la revocación volvió a ser denegada.
La UI de Equipo ahora expone el toggle «Registrar pagos de liquidaciones» con su estado vigente.

## Barber
Accedió con identidad real y su menú/quota quedó limitado a economía propia. Tests confirman que no puede leer economía ajena ni áreas de Equipo/Finanzas.

## Cliente autenticado / invitado
El discovery público funciona desde un enlace natural (\`?business=qa-b1-key\`) sin pedir UUID; se ven ofertas publicadas, sus sesiones y el medio de contacto configurado. Los borradores no aparecen.

## Visitante público
Sin sesión, resolvió el negocio por clave pública, consultó cursos y volvió a reservas. Una clave inválida muestra error accionable. Sin parámetro, la página ya no pide un identificador técnico.

## Journeys ejecutados
Ver \`G02_BROWSER_JOURNEYS_FINAL.csv\`. Los journeys de booking completo Cliente↔Curso, prestación↔economía y jornada sintética completa quedan **BLOCKED** por falta de evidencia en esta campaña; no se simularon con SQL/API.
`);

w("G02_RESPONSIVE_ACCESSIBILITY_REPORT.md", `# G02 — Responsive y accesibilidad

Matriz contractual: 320 / 390 / 410 / 430 / 768 / 1024 / 1440 px.

**Ejecutado en esta campaña**: 1440×900 y 390×844 con interacción real (login, formularios, navegación, capturas). Configuración \`playwright.g01.config.ts\` contiene los 7 viewports y los scripts quedan listos en \`09_QA_SCRIPTS/\`.

**No ejecutados**: 320, 410, 430, 768, 1024 con interacciones representativas. Por tanto Q07-28 y QX-10 permanecen BLOCKED en la matriz; no se declara responsive certificado.

Las capturas disponibles están en \`08_SCREENSHOTS/\` (owner cursos, sesiones, discovery, visitante). No se aplicó rediseño global; se mantuvo el Design System existente.
`);

w("G02_EXPLORATORY_PRODUCT_QA.md", `# G02 — QA exploratorio autónomo

Charter: uso real del producto, búsqueda de defectos no previstos, corrección y retest.

## Hallazgos
1. **G02-D04 (P1)**: agentes vacíos al programar sesión por envelope inconsistente. Corregido y retesteado.
2. **E-08 (P1)**: autoridad financiera de Recepción sin vía UI para el grant. Extensión mínima completada.
3. **E-18 (P3)**: discovery dependía de un UUID técnico. Resuelto por clave pública.
4. **SLOT_CONFLICT en vivo**: al confirmar un slot ya ocupado el sistema rechaza la operación (comportamiento correcto, no defecto).
5. **Horizonte temporal**: un test H03 falló con \`Date is outside the booking horizon\`; se conservan las políticas congeladas H03, sin ampliación.

## Límites honestos
No se ejecutaron en esta campaña: kil real controlado, revocación en vuelo, journeys A–M completos, matriz de 7 viewports con interacción, doble cierre concurrente en navegador. No se sustituyeron por mocks ni por mutaciones SQL/API disfrazadas de journeys.
`);

w("G02_H01_H06_REGRESSION_FINAL.md", `# G02 — Regresión H01–H06 (final)

Ejecución global (\`05_REGRESSIONS/vitest-final.log\`): 267 PASS / 28 FAIL / 258 skipped sobre 553 tests, con un único \`DATABASE_URL\` (H07 QA) → la mayoría de los fallos son de entorno.

## Reprocesamiento por hito con BD aislada
| Hito | BD | Resultado | Fallos | Clasificación |
|---|---|---|---|---|
| H05 | \`youngkingz_h05_qa_20261116\` | 98 PASS / 1 FAIL | F43 upgrade conecta a puerto 55322 hardcodeado | ENVIRONMENT (puerto excluido por Windows) |
| H06 | \`youngkingz_h06_qa_20261119\` | 30 PASS / 1 FAIL | \`product_orders_snapshot_check\` en \`order.cancel\` | LEGACY_INHERITED (código H06 no modificado) |
| H07/H08 | \`youngkingz_h07_qa_20261124\` | 15 PASS / 0 FAIL | — | — |
| H01–H04 | mismos errores de BD/GoTrue acumulado | — | Phone ya registrado, FK de user_accounts | FIXTURE_ISSUE |

## Skipped (258)
Incluyen suites que requieren BD propia, flags explícitos y dependencias de entorno. No se declararon irrelevantes: los correspondientes a H07/H08 se cubren con tests propios y journeys.

**Conclusión**: no hay \`NEW_REGRESSION\` causal atribuible a los correctivos de esta campaña. Los dos fallos con BD correcta son heredados/de entorno y están fuera del alcance autorizado.
`);

w("G02_BROWSER_JOURNEYS_FINAL.csv", `id,actor,superficie,accion,resultado,evidencia,oraculo
J-G02-01,Owner,/login,login GoTrue real,PASS,g02_browser_smoke.json,redireccion /team
J-G02-02,Owner,/cursos,crear borrador con UI,PASS,g02_browser_smoke.json,courses.courses DRAFT
J-G02-03,Owner,/cursos,publicar oferta,PASS,journey_owner.json,courses.courses PUBLISHED
J-G02-04,Owner,/cursos/[id]/sesiones,programar sesion con instructor,PASS,g02_browser_smoke.json,course_sessions SCHEDULED
J-G02-05,Owner,/cursos/[id]/sesiones,confirmar sesion,PASS,journey_owner.json,mensaje UI + test integracion
J-G02-06,Owner,/cursos/[id]/sesiones,cancelar sesion,PASS,journey_owner.json,Sesion cancelada
J-G02-07,Owner,/team,emitir grant obligations.pay,PASS,e08_results.json,iam.capability_grants
J-G02-08,Owner,/cursos/publicos?business=qa-b1-key,descubrir cursos publicados,PASS,e18_results.json,borrador no expuesto
J-G02-09,Reception,API payment,denegacion sin grant,PASS,e08_results.json,403 ECONOMY_FORBIDDEN
J-G02-10,Reception,API payment,pago con grant,PASS,e08_results.json,obligacion PARTIAL saldo 7000
J-G02-11,Reception,API payment,denegacion tras revocacion,PASS,e08_results.json,403 ECONOMY_FORBIDDEN
J-G02-12,Barber,/team,sesion aislada y economia propia,PASS,g02_browser_smoke.json,CL-13 test H08
J-G02-13,Visitante,/cursos/publicos,entrada sin UUID,PASS,e18_results.json,sin input tecnico
J-G02-14,Visitante,/cursos/publicos,borrador no visible,PASS,e18_results.json,draft_not_exposed
J-G02-15,Owner,/cursos/[id]/sesiones,reprogramar sesion,BLOCKED,journey_owner.json,slot ocupado en el intento
J-G02-16,Cliente,/,booking completo,BLOCKED,,sin evidencia en esta campaña
J-G02-17,Reception,Agenda,operacion cotidiana completa,BLOCKED,,sin evidencia en esta campaña
`);

w("R6_CAPABILITY_ACCEPTANCE_MATRIX.csv", `cap,hito,estado,evidencia
CAP-07-01 Oferta,H07,PASS,smoke + journey + tests H07
CAP-07-02 Sesiones e instructor,H07,PASS,smoke + test H07
CAP-07-03 Ocupacion compartida,H07,PASS,test concurrencia + SLOT_CONFLICT en vivo
CAP-07-04 Ciclo operativo,H07,BLOCKED,reprogramacion y realizacion sin retest vigente
CAP-07-05 Discovery publico,H07,PASS,e18_results 5/5
CAP-08-01 Acuerdos versionados,H08,PASS,test H08 + periodFixedRent
CAP-08-02 Atribucion,H08,PASS,test P0 EGM refund_of_id porSale
CAP-08-03 OPEN_ESTIMATE,H08,PASS,test H08
CAP-08-04 CLOSED_SNAPSHOT,H08,PASS,test H08 doble cierre
CAP-08-05 Pagos/receivable,H08,PASS,e08_results + money oracle
CAP-08-06 Ajustes,H08,BLOCKED,sin oraculo vigente de ajuste/regresion
CROSS IAM,H07+H08,PASS,tests cross-business + CL-13 + e08
CROSS Recovery,H07+H08,BLOCKED,sin kill/revocacion en vuelo en esta campaña
`);

console.log("docs written");
