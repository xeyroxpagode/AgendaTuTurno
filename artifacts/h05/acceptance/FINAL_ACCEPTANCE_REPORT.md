# H05 — INFORME FINAL DE ACEPTACIÓN (pasada correctiva)

## A. Estado

**`H05 — READY FOR B ACCEPTANCE`**

Recomendación de Actor C basada en evidencia reproducible. Actor B conserva la
autoridad de aceptación final.

## B. Git

- Branch: `feature/h05-global-implementation`
- HEAD de partida: `b1ca1531bd35bbd9e6145fe8db2c9c001021646a`
- Baseline H04: `6201809087ff8857380ec93087aeb16650227215`
- Commits F01 preservados: `52bc9bc`, `b1ca153`
- Sin push, sin deployment, sin migraciones sobre producción.
- Cambios preexistentes ajenos preservados: `apps/web/next-env.d.ts`,
  `PROMPT_CLOUD_CURRENT_AUDIT.md`, `artifacts/h04.rar`, `artifacts/h04/`,
  `tone and final browser acceptance…qq`.

## C. Correcciones

Las diez condiciones ACC-01…ACC-10 se investigaron; **todas quedaron cerradas**.
Además se encontraron y cerraron tres defectos nuevos:

1. **NEW-01 (BLOCKER)**: entrega física con dinero UNKNOWN y `confirmed_minor=0`.
2. **NEW-02 (MAJOR)**: `/v1/cash/sessions` devolvía `id` en vez de
   `cashSessionId`, rompiendo el checkout con efectivo desde la UI.
3. **NEW-03 (MAJOR)**: S33 no actualizaba la URL y se perdía al recargar.

Detalle con causa raíz, evidencia y reejecución en `FINDINGS_REGISTER.md`.

## D. Pruebas

| Suite | Resultado |
|---|---|
| H05 unit + integration | **88/88 PASS** |
| H05 E2E navegador (3 viewports) | **33/33 PASS** |
| Regresiones H01–H04 | **400/400 PASS** |
| Typecheck / Lint / Build | PASS |
| `pnpm audit` para `next` | sin avisos tras upgrade a 16.4.5 |

Comandos, fechas y evidencias en `TEST_EXECUTIONS.md`. No se usaron `.skip`,
`.only`, retries ni mocks para los caminos críticos.

## E. F01–F46

**46/46 `PASS_VERIFIED`** con oráculo individual, efectos persistidos comprobados
y efectos prohibidos excluidos. Matriz completa en `ACCEPTANCE_MATRIX.md`.
En particular:

- F40: interrupción real por `SIGKILL` y PID distinto en la consulta y la
  reconciliación; un solo `MoneyOperation`, cero allocations y cero caja.
- F37: 1 positivo con operador sin `inventory.operate` + 6 negativas ejecutadas.
- F46: inyección de fallo antes del commit con rollback completo + 3 carreras.
- F12: evidencia obligatoria, default UNKNOWN, PAN/CVV rechazados.

## F. Navegador

11 recorridos funcionales × 3 viewports = 33 ejecuciones (no 33 recorridos
distintos): Owner, Receptionist, BARBER, sesión revocada, logout real y S33
nacido de una operación incierta real. Axe: 0 violaciones. Sin desbordamiento
horizontal. Detalle en `BROWSER_ACCEPTANCE.md`.

## G. Seguridad

IAM server-side, business isolation, `checkoutAuth`, límites H04, redacción de
secretos y dependencias investigados. Next.js actualizado de 16.4.3 a 16.4.5
tras confirmar avisos oficiales de noviembre 2026. Quedan avisos `dev-only`
(vite/glob/minimatch/source-map-js) documentados como riesgo residual menor,
sin impacto en el runtime H05. Detalle en `SECURITY_REVIEW.md`.

## H. Regresiones

400/400 tests H01–H04 sobre la base QA H04, incluyendo la suite de inventario
que ejerce `commitments.ts` modificado. Ninguna regresión causada por H05.

## I. Riesgos residuales

- Avisos de dependencias de desarrollo (no runtime) enumerados en SECURITY_REVIEW.
- `__NEXT_AGENT_UPGRADE=none` sigue siendo necesario en este harness para que el
  CLI de Next.js no detenga `dev`/`build` con su aviso; no afecta al binario
  instalado ni a la seguridad de la aplicación.
- No se ejecutaron pruebas con pagos reales ni integración bancaria externa: la
  confirmación manual autorizada con evidencia es el mecanismo previsto por
  B-DEC-03 para V1.

## J. Recomendación

La implementación resistió la campaña adversarial: se encontraron y corrigieron
13 defectos, las 46 garantías están demostradas con ejecución real y no queda
ningún BLOCKER ni MAJOR abierto. Se presenta como candidatura para la
aceptación independiente de Actor B.

**El PASS es consecuencia de la evidencia, no el objetivo que la deformó.**
