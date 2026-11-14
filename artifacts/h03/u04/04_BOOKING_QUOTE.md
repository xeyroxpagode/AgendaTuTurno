# 04 — BOOKING QUOTE (G04)

**Estado:** VERIFIED_PASS

`apps/api/src/modules/booking/domain/quote.ts`: oferta firmada HMAC-SHA256 (base64url payload + firma), TTL 5 min, `verifyQuote` (firma en tiempo constante, expiración), `quoteFingerprint` (canónico). Sin tabla de quotes (estrategia firmada). Read-only, no ocupa slot.

Pruebas: `tests/h03/unit/booking-quote.spec.ts` — 6/6 PASS (round-trip, payload alterado, firma alterada, expirada, JSON canónico estable, fingerprint estable/sensible).
Endpoint `POST /v1/public/businesses/:businessId/booking-quotes` revalida U03 (`resolveSlot`, requirePublic) y enriquece precio/nombre desde catalog.
