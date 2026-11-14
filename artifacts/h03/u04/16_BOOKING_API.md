# 16 — BOOKING API (G16)

**Estado:** VERIFIED_PASS

`modules/booking/routes.ts` registradas en `app.ts`: quote, confirm guest, reconcile, guest read/cancel/reschedule, staff list/detail/history, overrides, assisted recovery, staff capability-gated. Zod en todos los inputs. Rate limit mínimo in-memory (429 `RATE_LIMITED`) por origen/Business/intención. OpenAPI vía swagger existente (tag `availability`/`booking`). Respuestas sanitizadas (sin secretos, sin SQL). CLIENT routes registradas como fail-closed (501) por ausencia de U02. Proyección pública no expone CRM ni internals.
Pruebas: `booking-confirm.spec.ts` 2/2 PASS (400/401/403/404/409/429 cubiertos por suites U03 + booking).
