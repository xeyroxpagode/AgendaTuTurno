# GF-01R FRESH RE-AUDIT REPORT — PARTE 3 (RESUMEN)

## RESUMEN

- Total hallazgos: 25
- P0: 7 | P1: 15 | P2: 2 | P3: 1
- FIXED_VERIFIED: 22 | CONFIRMED_DEFECT: 0 | STRONG_HYPOTHESIS: 2 | EVIDENCE_GAP: 1 | SPEC_AMBIGUITY: 0 | FALSE_POSITIVE: 0

## DETALLE POR ESTADO

**FIXED_VERIFIED (22):** GF-01R-001, 002, 003, 004, 005, 006, 007, 008, 009, 010, 011, 012, 013, 014, 015, 017, 018, 019, 020, 021, 022, 025

**STRONG_HYPOTHESIS (2):**
- GF-01R-016 (P1): Dos weak assertions permanecen sin estrechar (`booking-confirm.spec.ts:110` rango 403/404; `booking-domain-error-codes.spec.ts:43` rango 400/409). CP-012 no las cubrió todas.
- GF-01R-023 (P2): Ventana de race teórica entre `resolveSlot` (línea 132) y `claimAllocation` (línea 170) en `confirm.ts`: `claimAllocation` re-resuelve el slot internamente y con `professionalPreference === "ANY"` podría asignar staff distinto al del INSERT de la reserva (línea 166), violando el trigger de integridad BD (`assert_reservation_allocation_integrity`, migración SQL:237-244).

**EVIDENCE_GAP (1):**
- GF-01R-024 (P3): `booking-reservation.spec.ts`, `booking-security.spec.ts`, `booking-quote.spec.ts` existen pero su contenido no fue leído en esta sesión; solo se verificó existencia.

## RESPUESTAS A PREGUNTAS DE RE-AUDITORÍA

### Q1 — Defectos P0 originales: ¿desaparecieron?
- `guest-access.ts` fail-fast `BOOKING_GUEST_KEY_V1` en producción: SÍ (líneas 51-55). FIXED_VERIFIED.
- `quote.ts` fail-fast `BOOKING_QUOTE_SECRET` en producción: SÍ (líneas 17-18). FIXED_VERIFIED.
- `recovery.ts` usa `encryptEnvelope` (no `Buffer.from` plano): SÍ (línea 64). FIXED_VERIFIED.
- `client-principal.ts` import dinámico con fallback 501: SÍ (líneas 34-50, 81-88). FIXED_VERIFIED.
- `routes.ts` feature flag `ENABLE_CLIENT_BOOKING`: SÍ (línea 52, 324-443). FIXED_VERIFIED.
- `confirm.ts` pasa `termsOverride` a `resolveSlot`: SÍ (líneas 140-146). FIXED_VERIFIED.
- `page.tsx` (reserva pública) token show/hide + copiar + warning: SÍ (líneas 41-42, 202-211, 291-323). FIXED_VERIFIED.
- `globals.css` `prefers-reduced-motion` y slot buttons 44x44px: SÍ (líneas 76-83, 72). FIXED_VERIFIED.

### Q2 — Defectos P1 originales: ¿desaparecieron?
- `app.ts` CORS allowlist array (no single origin): SÍ (`runtime.ts:30`, `app.ts:29`). FIXED_VERIFIED.
- `queries.ts` sin validación duplicada (línea 105 eliminada): SÍ, una sola validación de cadencia (línea 104). FIXED_VERIFIED.
- `staff-exceptions.ts` emite evento `STAFF_EXCEPTION_APPLIED`: SÍ (líneas 26-28, 54-56). FIXED_VERIFIED.
- `recovery.ts` usa `CURRENT_KEY_VERSION` (no `'recovery'` literal): SÍ (líneas 64-65). FIXED_VERIFIED.

### Q3 — ¿Las correcciones introdujeron regresiones?
- `packages/database/src/booking.ts` existe y es consistente con migración SQL: SÍ. FIXED_VERIFIED.
- `booking-fault-injection.spec.ts` y `booking-domain-error-codes.spec.ts` existen: SÍ. FIXED_VERIFIED.
- `booking-confirm.spec.ts` verifica token identidad en reconcile: SÍ (líneas 50-70). FIXED_VERIFIED.
- `booking-principals.spec.ts` verifica ledger sin secretos: SÍ (líneas 86-101). FIXED_VERIFIED.
- `availability.spec.ts` test de 100 iteraciones determinismo: SÍ, en `tests/h03/integration/availability.spec.ts:102-110`. FIXED_VERIFIED.
- Regresión potencial detectada: GF-01R-023 (race confirm→claim con ANY). STRONG_HYPOTHESIS, no confirmada.

### Q4 — ¿Contradicciones entre Specify y código?
- `BookingQuotePayload` coincide con lo que `confirm.ts` usa: SÍ. FIXED_VERIFIED.
- `AllocationClaimInput` coincide con lo que `confirm.ts` pasa a `claimAllocation`: SÍ. FIXED_VERIFIED.

## CONCLUSIÓN
Los correctivos P0/P1 implementados resuelven los defectos originales sin regresiones confirmadas. Todos los controles de fail-fast, AEAD, feature flag, CORS array, cadencia única, evento staff-exception, y clave versionada en recovery están presentes y verificados estáticamente. Quedan dos hallazgos abiertos: weak assertions residuales en tests (CP-012 incompleto) y una hipotética ventana de race en confirm→claim bajo `professionalPreference === "ANY"` que requiere validación de concurrencia real antes de descartar.

**Recomendación:** estrechar las dos aserciones débiles (GF-01R-016) y ejecutar una prueba de concurrencia confirm+claim con ANY para confirmar o descartar GF-01R-023.
