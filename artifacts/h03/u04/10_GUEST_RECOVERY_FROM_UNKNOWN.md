# 10 — GUEST RECOVERY FROM UNKNOWN (G10)

**Estado:** VERIFIED_PASS

Reconciliación `GET /v1/public/businesses/:businessId/booking-operations/:operationId` exige `x-intent-proof`; verifica digest contra el envelope; descifra el token solo con proof válido; envelope expirado → 410 (camino asistido). Retry legítimo recupera la reserva original sin duplicar (E2E 2/2 PASS). Tercero con Operation ID solo es rechazado (403).
