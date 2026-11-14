# 19 — CONCURRENCY & FAULT INJECTION (G19)

**Estado:** PARTIAL (pruebas reales, no solo mocks)

- U03: 2 confirmaciones último slot → solo una gana (`availability.spec.ts`); ANY con dos profesionales → dos confirmaciones (`allows distinct professionals`).
- Booking: `booking-principals.spec.ts` retry concurrente (3 llamadas → un efecto); `booking-confirm.spec.ts` idempotencia de confirm + reconcile.
- Fault injection cubierto por triggers diferidos + rollback (G02/G08) y por la atomicidad de `executePrincipalOperation` (savepoint + commit único). No se inyectaron fallos en cifrado de envelope ni en Release/Replace de forma aislada; documentado como riesgo residual.

No se declaran 16 carreras individualmente; las críticas (último slot, doble clic, response perdida) están probadas.
