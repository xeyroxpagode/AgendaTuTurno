# F01 — HANDOFF FINAL A G01 (H06 integral)

**Proyecto:** AgendaTuTurno · **Hito:** H06 Pedidos de productos para retiro
**Fecha:** 2026-11-19 · **Ejecutor:** Actor C (OpenCode)
**Autoridad:** G0a registrado en `F01_GATE0A_ACCEPTANCE.md`
**Veredicto:** **NO se declara `H06 FUNCTIONAL FROZEN/PASS`.** Q50 y la aceptación visual G0b pertenecen a G01.

---

## 1. Estado Git

| Campo | Valor |
|---|---|
| Rama | `feature/h05-global-implementation` |
| HEAD inicial y final | `116148f2279fc092cbec3eede7c66144ee4d730f` (sin commit; sin push) |
| Remote | `origin https://github.com/xeyroxpagode/YoungKingzBarber.git` (URL histórica permitida, CF-10) |
| Worktree / stash | sin worktree nuevo; `stash@{0}: u05-wip-temp` intacto |
| Cambios preexistentes | `CLOUD_*`, `PROMPT_CLOUD_CURRENT_AUDIT.md`, `artifacts/h04.rar`, `artifacts/h04/`, `tone and final browser acceptance…qq` — preservados |
| `git diff --check` | sin errores (sólo avisos LF→CRLF del entorno) |

Los cinco archivos `artifacts/h05/acceptance/*.json` que la regresión H05 reescribió
por su propio generador de evidencia fueron devueltos byte-a-byte a HEAD
(`git hash-object` = `git rev-parse HEAD:<path>`). El indicador `M` residual en
uno de ellos es sólo caché de stat, sin diferencia de contenido.

## 2. Work packages ejecutados

| WP | Entrega principal | Checkpoint |
|---|---|---|
| WP-0 | `packages/contracts/src/orders.ts`; 11 caps `orders.*` en los 4 mapas; 10 códigos de error; `lib/security/opaque-token.ts` | `pnpm typecheck` PASS; 6 tests unitarios |
| WP-1 | M1 (`orders`: 2 tablas, 3 vistas, 2 triggers), M2 (`clients.order_credentials` + FK), M3 (`assert_complete_lines`, `guard_delivered`, `guard_checkout_source`, oráculos) | QA limpia + upgrade + rollback: `evidence/h06/F01_MIGRATION_EVIDENCE.md` |
| WP-2 | `client-auth/order-credential.ts`: emisión, validación en-Tx, reemisión y revocación; redacción `x-order-credential` | Tests Q25/Q26/Q27 y typecheck |
| WP-3 | Extensión H04: variant `ORDER`, `releaseStockCommitments`, comparación de `source_reference` en entrega plural | Regresión H04 33/33 (F31–F37) |
| WP-4 | `orders/domain.ts` + `orders/commands.ts`: 7 comandos + D22 + reemisión; locks 104→404→FOR UPDATE; revalidación in-Tx | Q13, Q14, Q29, Q30, Q32/Q33, Q42, Q46 |
| WP-5 | `checkout/commands.ts`: `sourceReference` derivado, `reuseCommitments` interno, igualdad agregada; entrega durable por fases | Q36, Q39, Q40, Q41/Q43 |
| WP-6 | `orders/routes.ts` (18 endpoints, reutiliza `/v1/operations/:id` y `/v1/audit`) + `queries.ts` | `tests/h06/integration/api.spec.ts`; 3 PASS |
| WP-7 | `UX_V3B06_COMPOSITION_BASIS.md` (T071) → catálogo/andamiaje (T061/T064) → componentes (T070) → superficies (T065..T069) → Playwright (T087) | `pnpm build` PASS; Playwright 3/3 viewports |
| WP-8 | Eventos de auditoría, correlación causal, recovered UNKNOWN, retención sin TTL | `evidence/h06/F01_AUDIT_RECOVERY.md` |
| WP-9 | 20 tests unitarios/integración + 3 e2e; bases QA aisladas; regresión H04/H05 | Ver §4 |

Estado detallado de las 91 tareas: `evidence/h06/F01_TASK_STATUS_91.md`.

## 3. Matriz de cobertura

### CAP (7/7)
| CAP | Oráculo rector | Evidencia |
|---|---|---|
| 01 Catálogo público | Q01–Q04, Q23, Q24, Q47 | `api.spec.ts` (sin stock/ubicación), `/productos` |
| 02 Solicitud | Q05–Q10, Q25–Q30 | `orders.spec.ts` (guest + staff) |
| 03 Confirmación | Q11–Q17, Q23, Q24 | Q13 rollback; `assert_complete_lines` |
| 04 Preparación | Q18–Q22 | `orderPrepare`/`orderReady`; 0 movimientos |
| 05 Retiro y checkout | Q36–Q44, Q46 | Q36/Q39/Q41; sale/movement únicos |
| 06 Cancelaciones | Q31–Q35, Q45 | Q32/Q33; `MONEY_BLOCKS_CANCEL` |
| 07 Historial/privacidad/autoridad | Q25–Q30, Q44, Q47–Q49 | vistas de auditoría; Q29 DENIED; redacción |

### Decisiones D01–D29 (29/29 materializadas)
D01 catálogo sin stock · D02 Order idempotente · D03 all-or-none · D04 PREPARING/READY completo · D05 DELIVERED con hechos · D06 cancelación por fase · D07 precio trazable · D08 credencial privada · D09 capability efectiva · D10 multirol sin suma · D11 cancelación atómica · D12 Money/UNKNOWN bloquea · D13 sin edición silenciosa · D14 snapshot REQUESTED · D15 precio informado/rechazo · D16 precio confirmado congelado · D17 privacidad · D18 tokens sin fuga · D19 receptor ≠ solicitante · D20 checkout recuperable · D21 incidencia ≠ status · D22 hecho físico real · D23 DELIVERED no se cancela · D24 pedidos bajo Inventario · D25 estado de comando separado · D26 sin TTL · D27 no parcial V1 · D28 una Sale por Order · D29 sin expansión V1.

### Decisiones técnicas T-01..T-12 (12/12)
T01 módulo único `orders` · T02 dos tablas + tres vistas · T03 Q13 en Tx del llamador · T04 authority `ORDER` sin `inventory.operate` · T05 H05 dueño de Sale/Money · T06 una Sale/un checkout · T07 credencial H03 · T08 `operation_attempts` única fuente · T09 locks 104→404→FOR UPDATE · T10 excepción D22 fuera de los 7 · T11 11 caps en 4 mapas · T12 M1→M2→M3 aditivas.

### Conflictos CF-01..CF-12 (12/12 reconciliados, no reabiertos)
CF-01 parcial vs Freeze · CF-02 preparación como progreso interno · CF-03 sustituir=cancelar+nueva solicitud · CF-04 `payOrder` rechazado · CF-05 precio · CF-06 solicitante/titular/receptor · CF-07 pago sin entrega · CF-08 entrega con incidencia · CF-09 CTA «Enviar solicitud» · CF-10 identidad Git anclada a `F01-GATE0` · CF-11 métricas journey/viewport separadas · CF-12 sin TTL.

### QA (50 oráculos)
Los 50 oráculos y su trazabilidad están en `E01 — FINAL TRACEABILITY.csv`. Este handoff ejecuta evidencia para los rectores y de alto riesgo: Q01–Q04, Q05–Q10, Q11–Q17 (Q13 con fallo controlado), Q18–Q22, Q25–Q30, Q31–Q35, Q36–Q44, Q46–Q49. **Q50 queda pendiente de ejecución en G01** (regresión con SHA atribuible).

## 4. Evidencia ejecutada (comandos reproducibles)

| Suite | Comando | Resultado |
|---|---|---|
| Tipos/contratos | `pnpm typecheck` | PASS (todos los paquetes) |
| Build | `pnpm build` | PASS (API + Next 16.4.5) |
| H06 unit | `DATABASE_URL=…h06… pnpm exec vitest run tests/h06/unit` | 6/6 |
| H06 integración | `… vitest run tests/h06/integration` | 14/14 (4 Oráculos + 7 adversariales + 3 API) |
| H06 global | `… vitest run tests/h06` | **20/20** |
| Playwright | `E2E_WEB_PORT=3101 … playwright test tests/h06/e2e` | **3/3** (390, 410, 1440) |
| Regresión H05 | `DATABASE_URL=…h05… vitest run tests/h05` | **99/99** |
| Regresión H04 | `DATABASE_URL=…h04… vitest run tests/h04` | **33/33** (F31–F37) |
| Migraciones | `pnpm exec tsx scripts/apply-migrations.ts …` | M1–M3 en QA limpia y upgrade; rollback verificado |

Nota de entorno: el puerto 3100 está ocupado por un proceso ajeno; Playwright se
ejecutó en 3101 mediante `E2E_WEB_PORT`, sin detener ese proceso.

Archivos de evidencia: `evidence/h06/F01_MIGRATION_EVIDENCE.md`,
`evidence/h06/F01_AUDIT_RECOVERY.md`, `evidence/h06/F01_TASK_STATUS_91.md`,
`F01_GATE0A_ACCEPTANCE.md`, `F01_DEPENDENCY_GRAPH_ADJUSTED.md`,
`UX_V3B06_COMPOSITION_BASIS.md`.

## 5. Autocorrecciones registradas

| ID | Hallazgo | Resolución |
|---|---|---|
| AC-01 | Grafo E01 §4 invertía `T061/T064 → T070` y omitía `T070 → T065..T069` | Ajuste local: 195 aristas, 0 ciclos, sin cambiar Task IDs |
| AC-02..05 | Colisión de constraint SQL, índice parcial inválido, tipo de `resource_id`, rollback incompleto | Migraciones corregidas y verificadas (§5 de la evidencia de migraciones) |
| AC-06 | FK de `audit_events` al emitir `order.pickup_prepared` antes del intento | `order.deliver` usa `prepareDurableOperation` → auditoría → H05 → `settleDurableOperation` |
| AC-07 | `settleDurableOperation` llamado con dos argumentos | Un único objeto de entrada con `handler` |
| AC-08 | `parent_id` (uuid) comparado con SKUs (text) en catálogo | Cast `parent_id::text = any($skus)`; detectado por test HTTP y corregido |
| AC-09 | Q29 sin evento DENIED | `withDeniedAudit` en `orderConfirm`, `outcome:'DENIED'` |

## 6. Riesgos y limitaciones honestas

1. **G0b pendiente**: la composición visual V3-B06 (4 estados faltantes, sin sexta pestaña, sin capacidades H05 expuestas) requiere aprobación de Actor A. `UX_V3B06_COMPOSITION_BASIS.md` contiene los puntos exactos. No se inventó `UX_FAMILY_FREEZE_PASS`.
2. **Q50 no ejecutado**: la regresión global con SHA atribuible se reserva para G01.
3. **T083/T087 parciales**: no se realizó SIGKILL real entre Sale y entrega (sí UNKNOWN durable y replay); Playwright cubre el recorrido Cliente en 3 viewports, no los recorridos Recepción/Owner con sesión real.
4. **Regresión H01–H03 amplia**: 26 fallos preexistentes de entorno (shim `auth.users` en clones QA, teléfonos duplicados en GoTrue, fechas fuera del horizonte de booking). No son causados por H06; H04 y H05, los dominios extendidos, pasan 33/33 y 99/99.
5. **Precio posterior al catálogo**: `assertProductLines` de H05 rechaza un cambio de precio ocurrido después de `CONFIRMED` (`PRICE_CHANGED`). No se modificó H05 ni se repricingó la Sale; la entrega queda bloqueada con incidencia recuperable. Si Actor A desea otro comportamiento, es una decisión de producto fuera de F01.
6. **Retención**: sin TTL/purga (D26/CF-12); crecimiento de `operation_attempts`/`audit_events` es deuda `NON_BLOCKING_FUTURE`.
7. Sin commit/push: se requiere autorización específica posterior de Actor A.

## 7. Entrega a G01

Paquete listo: código, migraciones verificadas, reporte por WP, estado de 91 tareas,
matriz 7/29/12/50 + 3 UX, evidencia SQL/tests/Playwright, regresión H04/H05,
registro de autocorrecciones, estado Git inicial/final, artefacto UX y este handoff.
**Los siete comandos, la excepción D22 y los 18 endpoints están implementados y
probados en QA aislada; el veredicto funcional final se emite en G01.**
