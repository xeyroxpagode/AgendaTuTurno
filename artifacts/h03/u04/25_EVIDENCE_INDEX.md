# 25 — EVIDENCE INDEX (G25)

| Archivo | Gate | Contenido |
|---|---|---|
| 00_BASELINE_AND_WORKSPACE.md | G00 | Workspace, rama, HEAD, estado inicial, dependencias, riesgos |
| 01_CURRENT_CROSSWALK.md | G01 | Crosswalk U01/U02/U03/H01, D13 verificado, U02 ausente |
| 02_DATABASE_AND_INTEGRITY.md | G02 | Migración, constraints, RLS, grants, reset local |
| 03_RESERVATION_DOMAIN.md | G03 | Dominio puro y snapshots |
| 04_BOOKING_QUOTE.md | G04 | Cotización firmada HMAC, TTL 5 min |
| 05_OPERATION_AUTHORITY.md | G05 | Principales, idempotencia, intent proof, envelope |
| 06_AVAILABILITY_ADAPTER.md | G06 | Adaptador U03, términos históricos |
| 07_CONFIRM_TRANSACTION.md | G07 | Confirmación transaccional |
| 08_RESERVATION_ALLOCATION_INTEGRITY.md | G08 | Integridad física + adversarial SQL |
| 09_GUEST_SECURITY.md | G09 | Credenciales invitadas |
| 10_GUEST_RECOVERY_FROM_UNKNOWN.md | G10 | Reconciliación de respuesta perdida |
| 11_CLIENT_IDENTITY_AND_MY_BOOKINGS.md | G11 | BLOQUEADO (U02) |
| 12_CANCEL_BOOKING.md | G12 | Cancelación |
| 13_RESCHEDULE_BOOKING.md | G13 | Reprogramación |
| 14_GUEST_ASSISTED_RECOVERY.md | G14 | BLOQUEADO (canal) |
| 15_STAFF_EXCEPTIONS.md | G15 | Overrides Staff |
| 16_BOOKING_API.md | G16 | API, Zod, OpenAPI, rate limit |
| 17_PUBLIC_BOOKING_UX.md | G17 | UI pública (PARTIAL) |
| 18_MY_RESERVATIONS_UX.md | G18 | BLOQUEADO (U02) |
| 19_CONCURRENCY_FAULT_INJECTION.md | G19 | Concurrencia (PARTIAL) |
| 20_AX_01_60_MATRIX.md | G20 | Matriz AX composicional |
| 21_GLOBAL_REGRESSION.md | G21 | Typecheck/lint/build/vitest |
| 22_SEMANTIC_CONCORDANCE.md | G22 | Concordancia semántica |
| 23_DEFECTS_AND_CORRECTIVES.md | G22 | Defectos y correctivos |
| 24_FINAL_HANDOFF_TO_B.md | G22 | Handoff final |
| 25_EVIDENCE_INDEX.md | G22 | Este índice |

Tests clave:
- `tests/h03/unit/booking-reservation.spec.ts` (10)
- `tests/h03/unit/booking-quote.spec.ts` (6)
- `tests/h03/unit/booking-security.spec.ts` (6)
- `tests/h03/integration/booking-integrity.spec.ts` (17)
- `tests/h03/integration/booking-confirm.spec.ts` (2)
- `tests/h03/integration/booking-principals.spec.ts` (8)
- `tests/h03/integration/availability.spec.ts` (17)
- `tests/h03/integration/clients.spec.ts` (24)
- `tests/h03/integration/availability-api.spec.ts` (3)
- `tests/h03/unit/availability.spec.ts` (20)
- `tests/h03/unit/client-profile.spec.ts` (8)
Total h03: 112/112 PASS.
