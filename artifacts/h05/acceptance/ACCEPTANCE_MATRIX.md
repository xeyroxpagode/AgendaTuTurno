# ACEPTACIÓN MATRIX — F01…F46 (estado final real)

Fuente: `H05_ADVERSARIAL_QA_MATRIX.md` del ZIP normativo. Estado asignado sólo
cuando existe ejecución real con oráculos específicos y comprobación de efectos
persistidos y ausentes. Los números de test son del commit final.

| F-ID | Garantía | Test / oráculo | Persistencia comprobada | Efecto prohibido excluido | Estado |
|---|---|---|---|---|---|
| F01 | Sólo servicios realizados; precio snapshot | `sales.spec.ts` F01 — líneas del snapshot performed y precio 12.000 | `sales.sale_lines` con `unitPriceMinor` | Línea sin snapshot | PASS_VERIFIED |
| F02 | No cobrar servicios no realizados | `sales.spec.ts` F02 — Attendance PARTIAL, total 9.000, saldo PENDING | `sales.sales.total_minor` | Sale SETTLED sin money | PASS_VERIFIED |
| F03 | Walk-in sin reserva ficticia | `sales.spec.ts` F03 — conteo de `booking.reservations` y `clients.client_profiles` antes/después | `sales.sales.source=WALK_IN`, `attendance_id=NULL` | Reservation/CLIENT nueva | PASS_VERIFIED |
| F04 | Una Sale por intento válido | `sales.spec.ts` F04 — replay mismo `operation_id` + contenido distinto | una sola fila por `operation_id` | Segunda Sale | PASS_VERIFIED |
| F05 | Sin Order ficticio, salida H04 | `f37-authority.spec.ts` positivo — `inventory.movements` DELIVERY | movement con `actor_account_id` real y stock -1 | Order/movimiento falso | PASS_VERIFIED |
| F06 | Total y efectos físicos correctos | `sales.spec.ts` F06 + `checkout.spec.ts` — 2 líneas, total 20.000 y entrega | total exacto + DELIVERY | Dos sales / total erróneo | PASS_VERIFIED |
| F07 | Rechazo de descuento backend | `sales.spec.ts` F07 — sin capability → 403; excedente → rechazo | sin Sale creada | Descuento aplicado | PASS_VERIFIED |
| F08 | CashMovement correcto, sin duplicados | **Cierre:** `f08-cash-idempotency.spec.ts` (2 tests) — además de `money.spec.ts` F08. Replay mismo payload y negativa con payload distinto. Consultas independientes: `money_operations`, `cash_movements`, `money_allocations`, `cash_sessions.cashbox_id` y saldo derivado de caja. | 1 MoneyOperation (SUCCEEDED, 6.000 minor), 1 CashMovement `SALE_CASH` de 6.000 con business/sesión/caja/actor/operation_id correctos, 1 allocation de 6.000; saldo +6.000 una sola vez; payload distinto → `IDEMPOTENCY_CONFLICT` sin efectos | 2ª operación, 2º movimiento, 2ª allocation, saldo duplicado | PASS_VERIFIED |
| F09 | Neto coincide con aplicado, no Refund | `money.spec.ts` F09 — SALE_CASH 10.000 y CHANGE 2.000, neto 8.000 | 2 movimientos de caja | Refund/expense | PASS_VERIFIED |
| F10 | Transferencia acreditada sin caja | `external-evidence.spec.ts` F10/F14 — con referencia+evidencia | `confirmedMinor=5.000`, 0 CashMovement | Dinero sin evidencia / efectivo falso | PASS_VERIFIED |
| F11 | Transferencia no acreditada: sin falso cobro | `money.spec.ts` F11 — PROCESSING, confirmed 0 | 0 CashMovement, 0 allocation | Confirmación ficticia | PASS_VERIFIED |
| F12 | Referencia/evidencia, sin tarjetas | `external-evidence.spec.ts` — sin evidencia → 0 operaciones; con evidencia → campos persistidos; PAN/CVV rechazados | `external_reference`/`evidence_reference` | PAN en request o DB | PASS_VERIFIED |
| F13 | UNKNOWN por mismo intento, sin doble ingreso | `money.spec.ts` F13 + `crash-recovery.spec.ts` — resolución y reconcilación | 1 MoneyOperation, status final SUCCEEDED | Segundo cobro | PASS_VERIFIED |
| F14 | Cobro mixto exacto, sólo efectivo a caja | **Cierre:** `f14-mixed-payment.spec.ts` (2 tests) — UNA sola operación mixta: efectivo $3.000 = 300.000 minor, transferencia acreditada 200.000 con referencia+evidencia, tarjeta confirmada 100.000 con referencia+evidencia. Escala verificada contra el contrato. Consultas independientes de componentes, allocation, CashMovement y saldo. | Total 600.000 minor; 3 componentes con importe/método/evidencia; allocation 600.000 a la Sale; **1 CashMovement `SALE_CASH` de 300.000** (no 600.000); saldo +300.000; replay sin duplicar; tarjeta UNKNOWN en operación mixta queda UNKNOWN y confirma sólo 300.000 | CashMovement por transferencia/tarjeta o por el total mixto; componente UNKNOWN acreditado | PASS_VERIFIED |
| F15 | Abierto en resolución, no fiado | `money.spec.ts` F15 — PARTIAL por dinero real | allocation 5.000 sobre 10.000 | SETTLED sin cobro / crédito | PASS_VERIFIED |
| F16 | Una recepción, dos momentos | `money.spec.ts` F16 — allocate sin nueva operación | 1 MoneyOperation, 1 allocation | 2ª recepción de dinero | PASS_VERIFIED |
| F17 | Idempotencia y serialization | `money.spec.ts` F17 + `f46-atomicity.spec.ts` — replay y 10 checkouts concurrentes | 1 efecto | Handler ejecutado dos veces | PASS_VERIFIED |
| F18 | Hecho nuevo, límite y autorización | `money.spec.ts` F18 + `f46-atomicity.spec.ts` refunds concurrentes | refund vinculado, original intacto | Refund > remanente | PASS_VERIFIED |
| F19 | Egreso actual, snapshot anterior intacto | `money.spec.ts` F19 — caja cerrada + refund en caja nueva | caja histórica CLOSED, refund nuevo | Modificación de snapshot | PASS_VERIFIED |
| F20 | Una sesión ordinaria por caja | `cash.spec.ts` F20 — doble apertura rechazada | sesión OPEN con cashbox | 2 sesiones abiertas | PASS_VERIFIED |
| F21 | Actor correcto y expected consistente | `cash.spec.ts` F21 — dos operadores | 2 movimientos con actores distintos | Actor no registrado | PASS_VERIFIED |
| F22 | Conteo cero válido | `cash.spec.ts` F22 — `countedAmountMinor=0` con motivo | snapshot con conteo 0 | Conteo cero bloqueado | PASS_VERIFIED |
| F23 | Detecta stale; exige revalidar | `cash.spec.ts` F23 — revisión 999 | sesión sigue OPEN | Conteo obsoleto aceptado | PASS_VERIFIED |
| F24 | Un cierre | `cash.spec.ts` F24 — 2 cierres concurrentes | 1 CLOSED, 1 rechazado | 2 snapshots | PASS_VERIFIED |
| F25 | Snapshot esperado/contado/diferencia/actor | `cash.spec.ts` F22 — diferencia con motivo | snapshot JSONB con diferencia | Diferencia oculta | PASS_VERIFIED |
| F26 | UNKNOWN bloquea o protocolo seguro | `cash.spec.ts` F26 — CASH_CLOSE_BLOCKED_UNKNOWN, luego resolución | cierra sólo tras resolver | UNKNOWN→FAILED por timeout | PASS_VERIFIED |
| F27 | Caja abierta tras logout | `roles-and-s33.spec.ts` — logout real desde UI | `cash_sessions.status=OPEN` | Cierre forzado | PASS_VERIFIED |
| F28 | Unknown != 0 ni settled | `obligations.spec.ts` F28 — NULL, status OPEN | `amount_minor IS NULL` | 0 / SETTLED | PASS_VERIFIED |
| F29 | Saldo residual, sin doble aplicación | `obligations.spec.ts` F29 — pago 4.000 de 10.000 | balance 6.000 | Pago excedente/duplicado | PASS_VERIFIED |
| F30 | Recepción H04 separada del pago | `obligations.spec.ts` F30 — RECEIPT y conteo de payments | 0 payments nuevos | Deuda saldada inventada | PASS_VERIFIED |
| F31 | No entrega falsa ni venta settled | `money-coverage.spec.ts` — UNKNOWN → status UNKNOWN, 0 DELIVERY, commitment ACTIVE | 0 movimientos físicos | Entrega sin dinero | PASS_VERIFIED |
| F32 | Sin doble entrega y recuperación | `f46-atomicity.spec.ts` — 10 checkouts última unidad | physical 0, 1 DELIVERY | 2 salidas físicas | PASS_VERIFIED |
| F33 | Incidencia sin borrar dinero | `checkout.spec.ts` F33 — DELIVERY_PENDING → reanudación | MoneyOperation SUCCEEDED, sin refund | Entrega ficticia / refund automático | PASS_VERIFIED |
| F34 | Server side bloquea revocación | `f37-authority.spec.ts` + `roles-and-s33.spec.ts` — sesión revocada rechaza resume y POST | sin audit ni cambio de checkout | Escritura con sesión revocada | PASS_VERIFIED |
| F35 | BARBER rechazo inequívoco | `cash.spec.ts` F35 — 403 en movimiento y cierre | 0 movimientos | Alteración de caja | PASS_VERIFIED |
| F36 | RECEPTIONIST refund sin grant | `money.spec.ts` F36 — 403; `roles-and-s33.spec.ts` verifica backend | 0 refund | Refund aceptado | PASS_VERIFIED |
| F37 | Venta legítima sí, pérdida arbitraria no | `f37-authority.spec.ts` — positivo + 6 negativas ejecutadas | DELIVERY real, 0 LOSS/ADJUSTMENT/CONSUMPTION indebidos | Ajuste/pérdida/consumo arbitrario | PASS_VERIFIED |
| F38 | Aislamiento total | `checkout.spec.ts` F38 + `qa.spec.ts` — FK compuesta 23503 | 0 filas de otro negocio | Datos cross-business | PASS_VERIFIED |
| F39 | Histórico se conserva | `sales.spec.ts` F39 — precio de catálogo cambiado, línea intacta | `unitPriceMinor=8.000` | Reescritura histórica | PASS_VERIFIED |
| F40 | Recuperable tras reinicio | `crash-recovery.spec.ts` — SIGKILL (PID 26120) → PID 26244 → PID 3292 | attempt survive y reconcilia; 1 money, 0 allocations/cash | Intento borrado / doble cobro | PASS_VERIFIED |
| F41 | No exceder aplicación ni propina | `money.spec.ts` F41 — 12.000 pagados, allocated 0, available 12.000 | 0 allocation automática | Propina/ingreso extra | PASS_VERIFIED |
| F42 | Recorridos accionables y accesibilidad | `finance.spec.ts` (6 escenarios × 3 viewports) + `roles-and-s33.spec.ts` — axe 0 violaciones | UI contra API real | Éxito ficticio al abortar request | PASS_VERIFIED |
| F43 | Migración QA íntegra | `qa.spec.ts` — 18 versiones, 13 tablas, 12 triggers; `apply-migrations.ts` en H01→H05 y H04+upgrade | constraints y FKs verificados | Migración fallida / producción | PASS_VERIFIED |
| F44 | Sin roturas H01–H04 | `vitest run tests/h01…h04` — 400/400 | — | Regresión causada por H05 | PASS_VERIFIED |
| F45 | Sin secretos en logs/errores | `qa.spec.ts` F45 — error con secreto no lo expone; `external-evidence.spec.ts` — PAN/CVV rechazados; `app.ts` redact | sin PAN en DB | Token/PAN en mensaje o log | PASS_VERIFIED |
| F46 | Atomicidad DB y reconciliación externa | **Cierre:** `f46-closure.spec.ts` (7 tests) con `faults/qa-faults.ts` y `faults/external-terminal.ts`. Escenario A: fallos en `sale_confirm`, `money_operation`, `money_allocation`, `cash_movement`, `commitment` y `delivery_movement`. Escenario B: intento durable → confirmación del simulador QA → fallo físico → incidencia → recuperación → repetición. | A: Sale DRAFT, 0 checkout/money/cash/commitment e intento FAILED en los 5 puntos; en entrega: dinero SUCCEEDED + DELIVERY_PENDING sin movimiento. B: pago externo SUCCEEDED con evidencia del simulador, 0 CashMovement, 0 DELIVERY, stock 2, commitment ACTIVE, incidencia con motivo; tras recuperar: DELIVERED, 1 MoneyOperation, 1 allocation, 1 DELIVERY, stock 1, 4 acciones de auditoría y `confirmedAt` del simulador inalterado | Rollback falso, entrega ficticia, doble cobro, doble entrega, reejecución del cobro externo | PASS_VERIFIED |

**46/46 PASS_VERIFIED.** Ningún estado se derivó del nombre del test: cada fila
cita el oráculo y el efecto comprobado. `F40` incluye reemplazo real de PID;
`F37` incluye denegaciones ejecutadas; `F46` incluye inyección de fallo en QA.
