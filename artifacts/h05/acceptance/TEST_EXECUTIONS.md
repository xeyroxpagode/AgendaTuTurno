# TEST EXECUTIONS — pasada correctiva

Commit final: ver `git log -1`. Entorno: PostgreSQL QA aislado `127.0.0.1:55322`,
proyecto `youngkingz-h01`. Variables: `DATABASE_URL` apunta a
`youngkingz_h05_qa_20261116` para H05 y a `youngkingz_h04_qa_20261115` para
regresiones. `__NEXT_AGENT_UPGRADE=none` evita el aviso del CLI de Next.js.

| # | Comando | Resultado | Fecha |
|---|---|---|---|
| 1 | `pnpm exec vitest run tests/h05` | **88 passed / 0 failed** (13 archivos) | 2026-11-17 |
| 2 | `pnpm exec vitest run tests/h05/integration/crash-recovery.spec.ts` | 3 passed; PIDs reales 26120 → 26244 → 3292 | 2026-11-17 |
| 3 | `pnpm exec vitest run tests/h05/integration/f37-authority.spec.ts` | 7 passed (1 positivo + 6 negativas ejecutadas) | 2026-11-17 |
| 4 | `pnpm exec vitest run tests/h05/integration/f46-atomicity.spec.ts` | 4 passed (inyección de fallo + 3 carreras) | 2026-11-17 |
| 5 | `pnpm exec vitest run tests/h05/integration/external-evidence.spec.ts` | 7 passed (ACC-01) | 2026-11-17 |
| 6 | `pnpm exec vitest run tests/h05/integration/money-coverage.spec.ts` | 3 passed (NEW-01) | 2026-11-17 |
| 7 | `pnpm exec playwright test tests/h05/e2e` | **33 passed / 0 failed** (3 viewports) | 2026-11-17 |
| 8 | `pnpm exec vitest run tests/h01 tests/h02 tests/h03 tests/h04` | **400 passed / 0 failed** (36 archivos) | 2026-11-17 |
| 9 | `pnpm -r --if-present typecheck` | PASS | 2026-11-17 |
| 10 | `pnpm lint` | PASS | 2026-11-17 |
| 11 | `pnpm build` | PASS (Next.js 16.4.5) | 2026-11-17 |
| 12 | `pnpm --filter @youngkingz/web exec pnpm audit` | Sin avisos para `next`; quedan avisos dev-only de vite/glob/minimatch/source-map-js | 2026-11-17 |

Ejecución 1 se repitió tras cada corrección material (ACC-01, NEW-01, NEW-02,
NEW-03). Todas las repeticiones terminaron en verde. No se usaron `.skip`,
`.only`, retries automáticos ni excepciones permanentes.

La inyección de fallo de la ejecución 4 creó el schema temporal `qa_faults` en
QA y lo eliminó en `afterAll`. No existe código de fault injection en
`apps/api/src` ni rutas públicas asociadas.

## Evidencias persistentes

- `artifacts/h05/acceptance/crash-{prepared,query,recovered,query-repeat}.json`
- `artifacts/h05/acceptance/{mobile-390,small-410,desktop-1440}-{caja,s33}.png`
- `artifacts/h05/acceptance/{mobile-390,small-410,desktop-1440}-reception-caja.png`
- `artifacts/h05/acceptance/*-s33-real.png`

## Cierre focalizado F08 / F14 / F46

| # | Comando | Resultado | Base |
|---|---|---|---|
| 13 | `pnpm exec vitest run tests/h05/integration/f08-cash-idempotency.spec.ts` | 2 passed | `youngkingz_h05_qa_20261116` |
| 14 | `pnpm exec vitest run tests/h05/integration/f14-mixed-payment.spec.ts` | 2 passed | `youngkingz_h05_qa_20261116` |
| 15 | `pnpm exec vitest run tests/h05/integration/f46-closure.spec.ts` | 7 passed | `youngkingz_h05_qa_20261116` |
| 16 | `pnpm exec vitest run tests/h05` (tras el cierre) | **99 passed / 0 failed** (16 archivos) | `youngkingz_h05_qa_20261116` |
| 17 | `pnpm -r --if-present typecheck` / `pnpm lint` | PASS | — |
| 18 | `pnpm exec vitest run tests/h01 tests/h02 tests/h03 tests/h04` | **400 passed / 0 failed** | `youngkingz_h04_qa_20261115` |

Verificación de limpieza QA: `to_regclass('qa_faults.sentinel') = null` y
0 disparadores `qa_fault_*` residuales tras la ejecución 15. No se ejecutaron
E2E adicionales porque no se modificó código productivo ni contrato HTTP.

Evidencia nueva: `artifacts/h05/acceptance/external-terminal-simulation.json`
(resultado de la terminal simulada, con `simulator` explícitamente marcado como
QA y separado de PostgreSQL).

## Nota sobre la ejecución `pnpm exec vitest run` global

Ejecutar la suite completa con `DATABASE_URL` de H04 produce 12 fallos
esperados: los tests H05 contienen una guarda `assertQaDatabase()` que exige
una base `youngkingz_h05_*`. Por eso las regresiones se ejecutaron con rutas
explícitas `tests/h01…h04`; ese comando dio 400/400 PASS. No se relajó la
guarda para ocultar el dato.
