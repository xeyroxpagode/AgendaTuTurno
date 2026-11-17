# H05 — INFORME GLOBAL DE IMPLEMENTACIÓN (F01)

**Estado global: `H05 IMPLEMENTATION — READY FOR B ACCEPTANCE`**

Este informe es una ÚNICA candidatura integral para la aceptación funcional de
Actor B. No se emite el veredicto final en nombre de Actor B.

Repositorio: `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation`
Branch: `feature/h05-global-implementation`
Baseline: `6201809087ff8857380ec93087aeb16650227215`

---

## 1. Git

| Dato | Resultado |
|---|---|
| Worktree raíz verificado | `C:/Users/thega/Desktop/YoungKingZ-U03-Implementation` |
| Branch H05 aislada creada desde baseline | `feature/h05-global-implementation` |
| HEAD inicial | `6201809087ff8857380ec93087aeb16650227215` |
| Push automático | NO |
| Operaciones destructivas (`reset`/`clean`/`stash`) | NO |
| Cambios preexistentes preservados | `apps/web/next-env.d.ts`, `PROMPT_CLOUD_CURRENT_AUDIT.md`, `artifacts/h04.rar`, `artifacts/h04/`, `tone and final browser acceptance…qq` |
| Archivos ajenos incluidos en commits H05 | NINGUNO (stageo por ruta explícita) |

---

## 2. Implementación

### 2.1 Capacidades (7/7)

| CAP | Dominio | Módulos | Estado |
|---|---|---|---|
| CAP-05-01 | Sales | `apps/api/src/modules/sales/` | IMPLEMENTADO |
| CAP-05-02 | Money | `apps/api/src/modules/money/` | IMPLEMENTADO |
| CAP-05-03 | Recovery | `apps/api/src/modules/money/` + `system/operations.ts` | IMPLEMENTADO |
| CAP-05-04 | Cash | `apps/api/src/modules/cash/` | IMPLEMENTADO |
| CAP-05-05 | Obligations | `apps/api/src/modules/obligations/` | IMPLEMENTADO |
| CAP-05-06 | Checkout | `apps/api/src/modules/checkout/` + frontera H04 | IMPLEMENTADO |
| CAP-05-07 | Corrections | `apps/api/src/modules/corrections/` | IMPLEMENTADO |

### 2.2 Work packages (WP-00…WP-08)

WP-00 (contratos, IAM, migración), WP-01 (Sales), WP-02 (Money+Recovery),
WP-03 (Cash), WP-04 (Obligations), WP-05 (Checkout+H04), WP-06 (Corrections),
WP-07 (UX Owner/Receptionist) y WP-08 (QA, seguridad, regresiones, E2E).
**25/25 Task IDs completados** (detalle en `IMPLEMENTATION_LEDGER.md` §4).

### 2.3 Contratos y migración

- Contratos Zod nuevos: `money.ts`, `sales.ts`, `cash.ts`, `obligations.ts`,
  `checkout.ts`, `corrections.ts` en `packages/contracts/src/`; exportados por
  `index.ts` y por el `exports` map del paquete.
- `packages/contracts/src/index.ts`: 18 capabilities H05, mapeo por rol,
  50+ `DomainErrorCode` nuevos. `inventory.operate` NO es delegable.
- Migración `supabase/migrations/202611160001_h05_finances.sql`: 6 esquemas,
  13 tablas canónicas, FKs compuestas, `business_id` en todas, `revision`,
  claves `(business_id,id)`, unicidad causal por `operation_id`, índices y
  12 triggers de invariantes (inmutabilidad de líneas, dinero, caja,
  obligaciones y correcciones; bloqueo de cierre de caja).
- Operaciones: `prepareDurableOperation`, `settleDurableOperation`,
  `executeDurableAttempt`, `durableAttemptState` en `system/operations.ts`
  (dos fronteras de persistencia para efectos externos).

### 2.4 Cambio mínimo H04 (ratificado)

`inventory/commitments.ts` acepta una autoridad `CHECKOUT` **opcional** en
`confirmStockCommitment`, `deliverStockCommitment` y
`deliverStockCommitments`. El camino por defecto (exigir `inventory.operate`)
queda intacto — demostrado por las 264 regresiones H03/H04.
No hay `backendPrincipal`, `systemActor`, `skipAuthorization`, endpoint
público de commit/deliver ni grants universales.

---

## 3. Checkpoints

| CP | Alcance | Estado |
|---|---|---|
| CP-00 | Arranque protegido, freeze, QA aislado | PASS |
| CP-01 | Financial Foundations | PASS |
| CP-02 | Núcleo financiero | PASS |
| CP-03 | Checkout / H04 / Corrections | PASS |
| CP-04 | Owner/Receptionist UX | PASS |
| CP-05 | Aceptación global | PASS |

---

## 4. Pruebas (comandos, resultados y evidencia)

| Suite | Resultado |
|---|---|
| `vitest run tests/h05` (unit + integration, 8 archivos) | **64 PASS / 0 FAIL** |
| `playwright test tests/h05/e2e/finance.spec.ts` (3 viewports) | **18 PASS / 0 FAIL** |
| `vitest run tests/h01/... tests/h02/...` | **136 PASS / 0 FAIL** |
| `vitest run tests/h03/... tests/h04/...` | **264 PASS / 0 FAIL** |
| `pnpm -r --if-present typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm build` | PASS |

Evidencia: `artifacts/h05/e2e/*.png` (caja y S33 en 390 / 410 / 1440 px).
Base QA (cadena H01→H05): `youngkingz_h05_qa_20261116`.
Base QA (upgrade H04→H05): `youngkingz_h05_upgrade_20261116`.

---

## 5. Matriz adversarial F01–F46 (ejecutada)

| F-ID | Escenario | Test ejecutado | Resultado |
|---|---|---|---|
| F01 | Sale desde Attendance COMPLETED | `sales.spec.ts` | PASS |
| F02 | Attendance PARTIAL | `sales.spec.ts` | PASS |
| F03 | Walk-in sin Reservation/CLIENT | `sales.spec.ts` | PASS |
| F04 | Doble confirmación / replay | `sales.spec.ts` | PASS |
| F05 | Venta directa de producto + snapshot | `sales.spec.ts` | PASS |
| F06 | Venta mixta servicio + producto | `sales.spec.ts` | PASS |
| F07 | Descuento no autorizado / excedente | `sales.spec.ts` | PASS |
| F08 | Cobro efectivo una sola vez | `money.spec.ts` | PASS |
| F09 | Efectivo entregado y vuelto | `money.spec.ts` | PASS |
| F10 | Transferencia acreditada | `money.spec.ts` | PASS |
| F11 | Transferencia no acreditada ≠ dinero | `money.spec.ts` | PASS |
| F12 | Terminal confirmada | `money.spec.ts` | PASS |
| F13 | Tarjeta UNKNOWN no es FAILED | `money.spec.ts` | PASS |
| F14 | Cobro mixto | `money.spec.ts` | PASS |
| F15 | Cobro parcial → saldo PARTIAL | `money.spec.ts` | PASS |
| F16 | Anticipo aplicado después, sin dinero nuevo | `money.spec.ts` | PASS |
| F17 | Intento repetido / carrera | `money.spec.ts` | PASS |
| F18 | Refund parcial conserva original | `money.spec.ts` | PASS |
| F19 | Refund desde caja cerrada | `money.spec.ts` | PASS |
| F20 | Caja abre con fondo real | `cash.spec.ts` | PASS |
| F21 | Dos operadores, actor real por movimiento | `cash.spec.ts` | PASS |
| F22 | Conteo cero válido | `cash.spec.ts` | PASS |
| F23 | Conteo obsoleto → STALE_REVISION | `cash.spec.ts` | PASS |
| F24 | Dos cierres simultáneos | `cash.spec.ts` | PASS |
| F25 | Diferencia registrada con motivo | `cash.spec.ts` | PASS |
| F26 | Cierre bloqueado por UNKNOWN de efectivo | `cash.spec.ts` | PASS |
| F27 | Logout no cierra caja | `cash.spec.ts` | PASS |
| F28 | UNKNOWN_AMOUNT ≠ cero | `obligations.spec.ts` | PASS |
| F29 | Pago parcial con saldo remanente | `obligations.spec.ts` | PASS |
| F30 | Recepción H04 ≠ pago | `obligations.spec.ts` | PASS |
| F31 | Venta sin stock rechazada sin cobrar | `checkout.spec.ts` | PASS |
| F32 | Última unidad disputada (concurrencia) | `checkout.spec.ts` | PASS |
| F33 | Dinero confirmado + entrega fallida | `checkout.spec.ts` | PASS |
| F34 | Sesión revocada antes del commit | `checkout.spec.ts` | PASS |
| F35 | BARBER no altera caja | `cash.spec.ts` | PASS |
| F36 | RECEPTIONIST sin grant no hace refund | `money.spec.ts` | PASS |
| F37 | Checkout sin `inventory.operate` (+ negativos) | `checkout.spec.ts` | PASS |
| F38 | Cross-business | `checkout.spec.ts` + `qa.spec.ts` | PASS |
| F39 | Precio histórico preservado | `sales.spec.ts` | PASS |
| F40 | Intento durable tras crash | `money.spec.ts` + `qa.spec.ts` | PASS |
| F41 | Sobrepago como saldo aplicable | `money.spec.ts` | PASS |
| F42 | Responsive móvil/desktop | `finance.spec.ts` (3 viewports) | PASS |
| F43 | Migraciones H01→H05 + upgrade H04→H05 | `qa.spec.ts` + runner QA | PASS |
| F44 | Regresiones H01–H04 | 400 tests H01–H04 | PASS |
| F45 | Sin secretos en errores | `qa.spec.ts` | PASS |
| F46 | Cambios concurrentes Sales/Money/Inventory | `checkout.spec.ts` (F32) | PASS |

No se declaró PASS ningún escenario no ejecutado.

---

## 6. Regresión H01–H04

400/400 tests unitarios y de integración de H01–H04 pasan sobre la base QA H04,
incluyendo la suite de inventario que ejerce las primitivas
`commitments.ts` modificadas. El comportamiento por defecto de H04 no cambió.

La única incompatibilidad conceptual esperada es que el test H04 que afirma
`to_regclass('sales.sales') IS NULL` sólo es válido en una instalación sin H05;
por eso la regresión se ejecutó contra la base H04 de referencia, no contra la
base H05. No se modificó ese test congelado.

---

## 7. Checkout/H04 — evidencia específica F37

- Operador RECEPTIONIST construido sin `inventory.operate` ejecuta checkout
  con entrega: `DELIVERED`, movimiento `DELIVERY` con
  `actor_account_id` del operador real, sin movimientos `LOSS`/`ADJUSTMENT`.
- Autoridad falsificada → `CHECKOUT_AUTH_INVALID`.
- Checkout de otro negocio → `CHECKOUT_AUTH_INVALID`.
- SKU/cantidad不同 a la línea de venta → `DELIVERY_SKU_MISMATCH` /
  `DELIVERY_QUANTITY_MISMATCH` / `CONFLICT`.
- Entrega duplicada → `DELIVERY_DUPLICATED`; un solo movimiento físico.
- Dinero confirmado + entrega fallida → `DELIVERY_PENDING`, sin
  `InventoryMovement` falso ni refund automático; reanudación exitosa sin
  segundo cobro.
- F31/F32: la reserva se valida dentro de la misma Tx que el dinero.

---

## 8. Integridad financiera

- Idempotencia por `operation_id` en cada escritura; replay con el mismo
  contenido, `IDEMPOTENCY_CONFLICT` con contenido distinto.
- Importes en unidades menores enteras (ARS); vuelto exacto y por componente;
  causas de sobrepago conservadas como saldo aplicable.
- `confirmed_minor` es la suma exacta de componentes CONFIRMED;转移 no
  acreditada y tarjeta UNKNOWN no cuentan como dinero.
- Saldo de venta y obligación DERIVADOS de hechos, nunca almacenados.
- `UNKNOWN_AMOUNT` se representa con `NULL`, nunca 0.
- Cierre de caja inmutable con snapshot; bloqueado ante UNKNOWN que afecta
  efectivo esperado.
- Refund es operación nueva vinculada al original, con límite de remanente.
- Correcciones con before/after, motivo obligatorio e historia preservada.

---

## 9. Frontend

Rutas Owner/Receptionist: `/caja`, `/ventas`, `/cobro`, `/finanzas`,
`/correcciones`, `/cobro-incierto`. Superficie única
`apps/web/src/features/finance/FinanceWorkspace.tsx` con API tipada,
`operation_id` estable en `sessionStorage`, dirty guard, estados
loading/success/error/unknown derivados del servidor, S33 con consulta al
intento original sin cobro duplicado, ocultación por capability efectiva,
accesibilidad (axe 0 violaciones) y responsive 390/410/1440.

---

## 10. Defectos residuales y limitaciones

| Ítem | Estado |
|---|---|
| Blockers críticos | NINGUNO |
| Majors abiertos | NINGUNO |
| Pérdida de integridad financiera | NINGUNA detectada en 64 tests + 18 E2E |
| CLI Supabase inoperativo por `local_smtp` | Mitigado con runner propio con guardas |
| Aviso de actualización de Next.js 16.4.3 en el harness | Mitigado con `__NEXT_AGENT_UPGRADE=none`; dependencias NO modificadas |
| Datos de prueba | Permanecen en bases QA descartables; no se escribió en producción |

---

## 11. Recomendación

Se presenta esta implementación como **candidatura única para la aceptación
funcional de Actor B**. Las siete capacidades están implementadas, integradas
y verificadas en PostgreSQL QA aislado y en navegador real; F01–F46 están
ejecutados con resultado real; las regresiones H01–H04 pasan; no hay
HARD_BLOCKED.

No se solicitaron aprobaciones rutinarias durante la ejecución. No se realizó
deployment productivo ni push automático.
