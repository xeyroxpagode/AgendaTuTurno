# H05 · IMPLEMENTATION LEDGER

> Registro operativo único de la implementación H05 (F01). **No es una fuente
> canónica de dinero, inventario ni producto**: sólo documenta el trabajo de
> ingeniería. La verdad del producto vive en los contratos congelados de
> `C:\Users\thega\Desktop\H05_GLOBAL_PREIMPLEMENTATION`.

---

## 1. Baseline y protección del trabajo preexistente

| Dato | Valor |
|---|---|
| Repositorio | `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation` |
| Raíz Git verificada | `C:/Users/thega/Desktop/YoungKingZ-U03-Implementation` |
| Baseline H04 | `6201809087ff8857380ec93087aeb16650227215` |
| Branch creada | `feature/h05-global-implementation` (desde el baseline, sin reescribir historia) |
| Workspace prohibido | `C:\Users\thega\Desktop\YoungKingzBarber-P2-VISUAL` — **no utilizado** |

### Cambios preexistentes preservados (no pertenecen a H05)

| Ruta | Estado | Tratamiento |
|---|---|---|
| `apps/web/next-env.d.ts` | `M` (tracked modificado) | preservado; **no** stageado en commits H05 |
| `PROMPT_CLOUD_CURRENT_AUDIT.md` | `??` untracked | preservado; no stageado |
| `artifacts/h04.rar` | `??` untracked | preservado; no stageado |
| `artifacts/h04/` | `??` untracked | preservado; no stageado |
| `tone and final browser acceptance…qq` | `??` untracked | preservado; no stageado |

Estrategia: rama nueva desde el baseline con `git checkout -b` (conserva el
working tree). Ningún `reset`, `clean`, `stash` destructivo, ningún push.
Los archivos ajenos se dejan intactos y se stagean **por ruta explícita**.

---

## 2. Freeze reproducible · SHA-256 de los contratos congelados

| Documento | SHA-256 |
|---|---|
| `00_CONTROL.md` | `C1B05B0092AE5E5C8D06C2143A20440E06B2788BB4F5DE5783F81B9163874C6C` |
| `01_CURRENT_AUDIT.md` | `99934EBFD2C7F42A29B785FC55CD014E3FBFD0D6809A9629FE4E85052B17CDAD` |
| `02_GLOBAL_SPEC.md` | `2F43F04A0D08805A2F64B78478B59F77AE800B138504484DDCC72DF43E572CA1` |
| `03_TECHNICAL_PLAN.md` | `916CA094C9E7ADACF3188AE0BC589D4C9F42E1E581E126F555B7FF647F22B576` |
| `04_IMPLEMENTATION_TASKS.md` | `7EBAD183B96FB060F287B779B65598E30E203D177DB7A419D8206ECC2D64A190` |
| `05_QA_TRACEABILITY.md` | `41ACEDFACDF81351426600EF8BA90D640F2595258DB9A189CFC3D67C200C4D61` |
| `06_EGM_FINDINGS.md` | `EF07710125A37973D74ADE052311FAD98EABC036A4DC6A9A583F4B6CCC0B725F` |
| `07_ANALYZE_READINESS.md` | `5F38802522A35AA17ED4A66397FE6970DDA665B17BFAC96013748A29467B3362` |
| `08_H05_IMPLEMENTATION_CONTRACT.md` | `11DED969CA1CAA22B987B855B6AAB67A39C50476FF34A1A7EE0BB5A53CAED339` |
| `INDEX.md` | `DF962AFA29B398C9A3B54EE0347A99816894D0444CEA20FCBCC3BCECB4CB51A4` |
| `INPUTS\YOUNGKINGZ_H05_GLOBAL_A_B_V1.0(1).zip` | `96184AF884EE8796860645A6428ABA71C28949B82C4CDC8484D7EB180FEFBFE2` |

El hash del ZIP coincide con el registrado en `00_CONTROL.md` R01.1 y en
`08_H05_IMPLEMENTATION_CONTRACT.md` §1: **no hay delta material** respecto del
Freeze autorizado.

---

## 3. Entorno QA (aislado, verificado)

| Dato | Valor |
|---|---|
| Supabase local (proyecto) | `youngkingz-h01` (`supabase/config.toml`) |
| PostgreSQL QA | `127.0.0.1:55322` (loopback) — `postgresql://postgres:postgres@127.0.0.1:55322/<db>` |
| Auth local | `http://127.0.0.1:55321` |
| Base QA H05 (cadena completa) | `youngkingz_h05_qa_20261116` — H01→H05 aplicadas desde cero |
| Base QA H05 (upgrade) | `youngkingz_h05_upgrade_20261116` — clon de `youngkingz_h04_qa_20261115` + sólo H05 |
| Base QA H04 (referencia) | `youngkingz_h04_qa_20261115` — preservada, **no** modificada |

**Guardas verificadas** (`scripts/apply-migrations.ts`):
- el proyecto declarado debe ser `youngkingz-h01` y el puerto `55322`;
- la base destino DEBE llamarse `youngkingz_h05_*` / `youngkingz_h04_*`;
- el host DEBE ser loopback;
- nunca se toca `postgres` (base de trabajo con datos acumulados) ni
  producción; no hay credenciales de producción en el repositorio.

**Limitación de entorno registrada**: el CLI de Supabase instalado no puede
leer `supabase/config.toml` (clave `local_smtp` no reconocida), por lo que
`supabase db reset` no es utilizable en esta sesión. Se implementó
`scripts/apply-migrations.ts`, que aplica **los mismos archivos SQL
versionados** en orden y registra las versiones aplicadas, con las mismas
guardas de aislamiento. El seed de identidades QA manual (`supabase/seeds/`)
no se necesita para las pruebas H05: las pruebas crean sus actores en
PostgreSQL, igual que la suite de integración de H04.

---

## 4. Backlog congelado — 25 Task IDs

| WP | Tasks | Estado |
|---|---|---|
| WP-00 Financial Foundations | WP-00-T01, WP-00-T02, WP-00-T03 | COMPLETADO |
| WP-01 Sales | WP-01-T01, WP-01-T02, WP-01-T03 | COMPLETADO |
| WP-02 Money + Recovery | WP-02-T01…T06 | COMPLETADO |
| WP-03 Cash | WP-03-T01, WP-03-T02, WP-03-T03 | COMPLETADO |
| WP-04 Obligations | WP-04-T01, WP-04-T02 | COMPLETADO |
| WP-05 Checkout + H04 | WP-05-T01, WP-05-T02, WP-05-T03 | COMPLETADO |
| WP-06 Corrections + Refunds | WP-06-T01, WP-06-T02 | COMPLETADO |
| WP-07 Owner/Receptionist UX | WP-07-T01, WP-07-T02 | COMPLETADO |
| WP-08 Global QA + Regressions | WP-08-T01 | EN CURSO |

---

## 5. Checkpoints

| CP | Alcance | Estado |
|---|---|---|
| CP-00 | Arranque protegido | **PASS** |
| CP-01 | Financial Foundations | **PASS** |
| CP-02 | Núcleo financiero | **PASS** |
| CP-03 | Checkout / H04 / Corrections | **PASS** |
| CP-04 | Owner/Receptionist UX | **PASS** |
| CP-05 | Aceptación global | EN CURSO |

---

## 6. Registro de decisiones técnicas (D1 — adaptación compatible)

| ID | Decisión | Motivo |
|---|---|---|
| T-01 | Se extiende `packages/contracts/src/index.ts` con las capabilities H05 y los `DomainErrorCode` nuevos, sin alterar ningún código ni capability previa. | C01.5/R-02; los contratos congelados H01–H04 no cambian. |
| T-02 | `sales.discount` es capability explícita: base de OWNER, delegable a RECEPTIONIST por grant expreso. | B-DEC-01 exige "capability efectiva"; B-DEC-10 exige que lo sensible no sea base del cajero. |
| T-03 | El estado durable de `system.operation_attempts` se mapea sobre su enum existente (`STARTED`/`SUCCEEDED`/`FAILED`/`UNKNOWN`); `money.money_operations.status` conserva la semántica H05 (`PROCESSING`/`SUCCEEDED`/`PROVEN_FAILED`/`UNKNOWN`). | El enum `system.operation_status` es un contrato H01 congelado; B01.5 dice que los estados H05 son semánticos, no enums obligatorios. |
| T-04 | Dos fronteras de persistencia implementadas en `system/operations.ts`: `prepareDurableOperation` (confirma el intento y COMMITea) y `settleDurableOperation` (frontera de resultado). | C01.8: el intento de un efecto externo no atómico debe sobrevivir a un crash. |
| T-05 | `inventory.commitments` / `inventory.deliverStockCommitments` aceptan una autoridad `CHECKOUT` opcional además de la autoridad por actor. El comportamiento por defecto (exigir `inventory.operate`) queda **intacto**. | C01.2/R-01 y ratificación de Actor B en `08_…CONTRACT.md` §12: cambio mínimo acotado, sin endpoint público, sin identidad ficticia. |
| T-06 | El saldo de la venta y el saldo de la obligación son **DERIVADOS** por agregación de `money.money_allocations` / `obligations.obligation_payments`; no se persisten. | B01.2/B01.3: no hay saldos canónicos paralelos. |
| T-07 | `UNKNOWN_AMOUNT` se representa con `amount_minor IS NULL` + `amount_state='UNKNOWN_AMOUNT'`; el saldo derivado de esa obligación es `null` (desconocido), nunca `0`. | D22 / F28. |
| T-08 | La venta se corrige **en el mismo agregado**: las líneas anteriores se marcan `superseded_at` (su snapshot comercial es inmutable por trigger) y se insertan las líneas de la nueva revisión; el before/after íntegro vive en `corrections.corrections`. | Réplica exacta del patrón H03 de `attendance.attendance_corrections`, con la misma garantía de historia. |
| T-09 | Los cobros con componente externo no confirmado (transferencia sin acreditar, tarjeta UNKNOWN) se registran con estado durable `PROCESSING`/`UNKNOWN` y **no** confirman dinero ni generan `CashMovement`. Luego se resuelven con `operations.resolve`. | D05/D06/D20, F11/F13/B-DEC-03. |
| T-10 | `checkout.checkouts.source_reference` es único por Business y se deriva del `operation_id` del checkout; es la referencia causal que amarra los compromisos de inventario a ese checkout. | D24/F37: el adaptador H04 no puede reutilizarse para otro checkout. |

---

## 7. Cambios principales por checkpoint

### CP-00
- Rama `feature/h05-global-implementation` creada desde `6201809`.
- `scripts/apply-migrations.ts` — runner de migraciones QA con guardas.
- Bases QA `youngkingz_h05_qa_20261116` (cadena H01→H05) y
  `youngkingz_h05_upgrade_20261116` (upgrade desde H04) creadas y verificadas.

### CP-01
- `packages/contracts/src/{money,sales,cash,obligations,checkout,corrections}.ts` — contratos Zod.
- `packages/contracts/src/index.ts` — capabilities H05, mapeo por rol, `DomainErrorCode`.
- `packages/contracts/package.json` — `exports` de los módulos nuevos.
- `supabase/migrations/202611160001_h05_finances.sql` — migración H05 (13 tablas, 6 esquemas, 12 triggers de invariantes).
- `apps/api/src/modules/system/operations.ts` — fronteras de persistencia durables.

### CP-02
- `apps/api/src/modules/sales/` — ventas, snapshot de precios, descuentos, anulación y corrección.
- `apps/api/src/modules/money/` — MoneyOperation, componentes, allocations, refunds, reconciliación, protocolo UNKNOWN.
- `apps/api/src/modules/cash/` — caja física, sesiones, movimientos, conteo y cierre con snapshot.
- `apps/api/src/modules/obligations/` — obligaciones, pagos parciales y settlement.

### CP-03
- `apps/api/src/modules/checkout/` — orquestador + frontera interna H05→H04.
- `apps/api/src/modules/inventory/commitments.ts` — autoridad `CHECKOUT` opcional (cambio mínimo acotado).
- `apps/api/src/modules/corrections/` — correcciones comerciales, monetarias, de caja y físicas.

### CP-04
- `apps/web/src/features/{sales,money,cash,obligations,checkout,corrections}/` — superficies Owner/Receptionist.
- `apps/web/src/app/(staff)/{ventas,caja,finanzas,correcciones}/` — rutas.

### CP-05
- `tests/h05/{unit,integration,e2e}/` — cobertura F01–F46.
- `artifacts/h05/IMPLEMENTATION_REPORT.md` — informe global único de entrega.

---

## 8. Migraciones QA aplicadas

| Base | Cadena | Resultado |
|---|---|---|
| `youngkingz_h05_qa_20261116` | H01→H05 (18 migraciones, en orden) | APLICADA |
| `youngkingz_h05_upgrade_20261116` | clon H04 QA + H05 | APLICADA |

---

## 9. Tests ejecutados

| Suite | Comando | Resultado |
|---|---|---|
| H05 unit + integration (8 archivos) | `DATABASE_URL=<H05 QA> pnpm exec vitest run tests/h05` | **64/64 PASS** |
| H05 E2E navegador (3 viewports) | `DATABASE_URL=<H05 QA> pnpm exec playwright test tests/h05/e2e/finance.spec.ts` | **18/18 PASS** |
| H01–H02 regresiones | `DATABASE_URL=<H04 QA> pnpm exec vitest run tests/h01/... tests/h02/...` | **136/136 PASS** |
| H03–H04 regresiones (incluye `commitments.ts` modificado) | `DATABASE_URL=<H04 QA> pnpm exec vitest run tests/h03/... tests/h04/...` | **264/264 PASS** |
| Typecheck monorepo | `pnpm -r --if-present typecheck` | PASS |
| Lint | `pnpm lint` | PASS |
| Build | `pnpm build` | PASS |

Evidencia E2E: `artifacts/h05/e2e/{mobile-390,small-410,desktop-1440}-{caja,s33}.png`.

Nota de entorno: el CLI de Next.js 16.4.3 emite un aviso de actualización que
detiene `dev`/`build` en este harness. Se ejecutó con
`__NEXT_AGENT_UPGRADE=none` para evitar ese aviso. No se ejecutó ninguna
actualización de dependencias: queda fuera del alcance H05.

---

## 10. Fallos detectados y correcciones

| # | Fallo detectado | Corrección |
|---|---|---|
| 1 | Migración H05 no aplicable desde cero: falta esquema `auth` en DB nueva | Shim QA mínimo `auth.users` en el runner, con guardas de aislamiento |
| 2 | FK circulares Money↔Obligation y Money↔Cash | FKs diferidas al final de la migración |
| 3 | Línea de servicio performed sin `service_id` violaba CHECK | CHECK relajado: exige nombre snapshot, `service_id` es opcional |
| 4 | `UNKNOWN_AMOUNT` no podía pagarse en forma parcial | Se eliminó la UNIQUE de `obligation_payments` por (obligación, dinero) |
| 5 | Anulación de venta confirmada violaba `sales_confirmed_consistency` | El CHECK ahora conserva `confirmed_at` como historia |
| 6 | Corrección comercial bloqueada por trigger de inmutabilidad | El trigger permite el cambio de total SÓLO si existe una corrección trazable en la misma Tx |
| 7 | `corrections.corrections` impedía PENDING→APPLIED | El trigger permite esa transición dentro de la Tx de creación |
| 8 | `checkout.checkouts.id` no se insertaba (usaba el default) → autoridad rechazada | Se inserta el `checkoutId` generado explícitamente |
| 9 | Entrega física rechazada: `project_entry` exige intento STARTED | La entrega usa su PROPIO durable attempt, separado del cobro |
| 10 | Autoridad de entrega comparaba el operation_id del checkout con el de ejecución | Se separaron: la autoridad valida el checkout; el intento de ejecución se valida por el protocolo durable |
| 11 | Checkout UNKNOWN se reportaba SUCCEEDED | El intento durable se alinea al resultado real del cobro (UNKNOWN/PROCESSING) |
| 12 | Nav links H05 ausentes + modules `.js` no resolubles en Turbopack | Imports por subpath del paquete; links gated por capability |
| 13 | A11y: `<main>` duplicado y contraste insuficiente | Root cambiado a `<div>`; colores de alto contraste para tema oscuro |

---

## 11. Commits técnicos

| Commit | Descripción |
|---|---|
| `52bc9bc52266435eac23d768aad05ba1a6816bf2` | Implementación global H05: 7 CAP, contratos, migración, API, UX, tests y evidencia |

Todo se stageó por ruta explícita. No se incluyeron los cambios preexistentes
ajenos a H05 listados en §1, que permanecen intactos en el working tree.
No se hizo push.

---

## 12. Próxima acción ejecutable

Entrega de la candidatura a Actor B mediante
`artifacts/h05/IMPLEMENTATION_REPORT.md`. No quedan tareas de implementación
pendientes.

---

## 13. Riesgos y blockers

| Riesgo | Estado |
|---|---|
| CLI de Supabase inutilizable por `local_smtp` | Mitigado: runner propio con guardas de aislamiento |
| Datos acumulados en la base `postgres` | No se toca; las pruebas H05 usan bases QA dedicadas |
| Identidades QA manuales (seed) | No aplicables a las pruebas H05 (los actores se crean en PostgreSQL, igual que H04) |
| Aviso de actualización de Next.js 16.4.3 en el harness | Mitigado con `__NEXT_AGENT_UPGRADE=none`; no se actualizaron dependencias |
| HARD_BLOCKED | **Ninguno** |
