# YOUNGKINGZ — H05 V1 · HANDOFF FINAL A ACTOR A

Documento autocontenido de entrega de ingeniería. No reabre desarrollo,
Especificación, EGM ni aceptación funcional.

---

## A. Identificación

| Campo | Valor |
|---|---|
| Proyecto | YoungKingZ Barber Management System |
| Hito | H05 V1 — Sales, Money, Recovery, Cash, Obligations, Checkout, Corrections |
| Estado | **`FROZEN / PASS`** |
| Fecha de aceptación funcional | 17/11/2026 |
| Autoridad de aceptación | Actor B |
| Ejecutor | Actor C (OpenCode) |
| Commit funcional aceptado | `116148f2279fc092cbec3eede7c66144ee4d730f` (`116148f`) |
| Rama funcional original | `feature/h05-global-implementation` |
| Rama de entrega | `handoff/h05-v1-qa-accepted-20261117` |
| Repositorio | `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation` |

`116148f` corresponde al cierre focalizado F08/F14/F46 ("test(h05): close
F08, F14 and F46 acceptance gaps with independent DB oracles"). No se ha
modificado código productivo desde ese commit.

## B. Alcance

Las siete capacidades congeladas están implementadas e integradas:

| CAP | Dominio | Módulo principal |
|---|---|---|
| CAP-05-01 | Sales | `apps/api/src/modules/sales/` |
| CAP-05-02 | Money | `apps/api/src/modules/money/` |
| CAP-05-03 | Recovery | `system/operations.ts` + Money |
| CAP-05-04 | Cash | `apps/api/src/modules/cash/` |
| CAP-05-05 | Obligations | `apps/api/src/modules/obligations/` |
| CAP-05-06 | Checkout | `apps/api/src/modules/checkout/` + frontera H04 |
| CAP-05-07 | Corrections | `apps/api/src/modules/corrections/` |

Superficies Owner/Receptionist: `/caja`, `/ventas`, `/cobro`, `/finanzas`,
`/correcciones`, `/cobro-incierto` (S33). Migración
`supabase/migrations/202611160001_h05_finances.sql`.

## C. Evidencia de aceptación

Ejecutada sobre PostgreSQL QA aislado y navegador real:

| Garantía | Evidencia |
|---|---|
| F01–F46 | **46/46 `PASS_VERIFIED`** en `ACCEPTANCE_MATRIX.md`, con oráculo individual y efectos persistidos |
| Suite H05 final | **99/99 tests PASS** (16 archivos) |
| Regresiones H01–H04 | **400/400 tests PASS** (36 archivos) |
| Playwright integral | **33/33 ejecuciones PASS** = 11 recorridos × 3 viewports (390, 410, 1440). **No son 33 recorridos funcionales distintos** |
| Typecheck / Lint / Build | PASS |
| F40 | Crash recovery con interrupción real del proceso (`SIGKILL`) y reconcilación en PID distinto |
| F37 | Checkout autorizado sin `inventory.operate` general + 6 negativas ejecutadas |
| F08 | Cobro efectivo único: 1 MoneyOperation y 1 CashMovement correcto, con replay e idempotencia y negativa por payload distinto |
| F14 | Pago mixto en una sola operación: $3.000 efectivo (300.000 minor) + transferencia 200.000 + tarjeta 100.000; **sólo 300.000 afectan la caja** |
| F46 | Atomicidad local en 5 puntos de fallo + pago externo simulado confirmado, entrega fallida, incidencia recuperable y recuperación sin duplicación |

**Precisiones de ejecución:**

- El último Playwright integral (33/33) se ejecutó durante la pasada correctiva
  anterior, **no después del commit `116148f`**. Ese commit sólo añadió pruebas
  y documentación, sin modificar código productivo ni contratos HTTP; por eso
  no se repitieron los E2E por obligación formal.
- El cierre focalizado F08/F14/F46 se ejecutó después de esa campaña:
  11 pruebas nuevas (2 + 2 + 7) con consultas independientes a PostgreSQL.
- Las regresiones H01–H04 (400/400) se repitieron sobre el estado final.

Detalle reproducible en `TEST_EXECUTIONS.md`, `ACCEPTANCE_MATRIX.md`,
`BROWSER_ACCEPTANCE.md` y `FINDINGS_REGISTER.md`.

## D. Incidentes corregidos

Defectos reales corregidos en la pasada correctiva:

1. Checkout marcado `DELIVERED` con dinero UNKNOWN y `confirmed_minor = 0`.
2. Contrato de caja: `/v1/cash/sessions` devolvía `id` en vez de
   `cashSessionId`, rompiendo el cobro en efectivo desde la UI.
3. S33 perdía el intento al recargar porque no actualizaba la URL.
4. Confirmación de tarjeta/transferencia sin evidencia obligatoria; default de
   tarjeta cambiado a `UNKNOWN`.
5. `resumeCheckout` no revalidaba la sesión revocada dentro de la transacción.
6. Next.js 16.4.3 actualizado a 16.4.5 tras verificar avisos oficiales.

Las tres brechas finales del cierre focalizado — **F08, F14 y F46** — fueron
`TEST_INCOMPLETE`: **no requirieron modificar código productivo**. Se agregaron
pruebas con oráculos independientes; no se debilitaron aserciones previas.

## E. Seguridad

- Sin permisos generales de inventario para el operador comercial: F37 usa
  `checkout.create` y una frontera H05→H04 revalidada en transacción.
- Sin ledgers paralelos: un único ledger físico H04 y hechos monetarios H05.
- Sin dinero duplicado: idempotencia por `operation_id` y evidencia obligatoria.
- IAM server-side, multirol y revocación revalidada dentro de la Tx.
- Aislamiento multi-business con `business_id` y FKs compuestas.
- Auditoría y causalidad en cada escritura crítica.
- Sin deployment productivo, sin push a la rama funcional, sin migraciones
  sobre producción.

## F. Limitaciones

- Las pruebas se ejecutaron sobre **PostgreSQL QA aislado**; no sobre datos reales.
- F46 utilizó un **simulador de terminal externa** (`YOUNGKINGZ_QA_TERMINAL_SIMULATOR_V1`), no una integración bancaria ni con terminal real.
- No se certifican transacciones contra proveedores reales ni pagos reales.
- `FROZEN / PASS` es la aceptación funcional de **H05 V1 dentro del alcance probado**.
- No autoriza deployment, migración productiva ni merge automático.
- En este harness se usa `__NEXT_AGENT_UPGRADE=none` para que el CLI de Next.js
  no detenga `dev`/`build` con su aviso; no afecta al binario instalado.

## G. Próximos pasos

1. Conservar la rama de aceptación `handoff/h05-v1-qa-accepted-20261117`.
2. Revisar y decidir el merge cuando Actor A lo autorice.
3. Mantener la trazabilidad de la migración H05 (`202611160001_h05_finances.sql`).
4. Planificar el siguiente hito del roadmap con autorización separada.

No se inicia H06, H08, H09 ni ningún otro hito en este handoff.
