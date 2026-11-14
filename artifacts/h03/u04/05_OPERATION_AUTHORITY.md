# 05 — OPERATION AUTHORITY (G05)

**Estado:** VERIFIED_PASS

Adaptación (no duplicación) de H01: `executePrincipalOperation` en `modules/system/operations.ts` soporta STAFF/CLIENT/GUEST_INTENT/GUEST_RESERVATION mediante `principal_kind` + `principal_ref` en `operation_attempts`; `executeOperation` delega (compatibilidad total con H01/H02/H03.U01/U03).

Guest intent proof: `modules/booking/security/guest-access.ts` (`createIntent`, `intentProofDigest`, alta entropía 32 bytes; solo digest se persiste). Tokens invitado ≥256 bits con digest SHA-256. Envelope AEAD AES-256-GCM con `key_version` y TTL 24h.

Pruebas: `tests/h03/unit/booking-security.spec.ts` — 6/6 PASS; `tests/h03/integration/booking-principals.spec.ts` — 8/8 PASS (retry idéntico, payload distinto, Business distinto, principal distinto, doble clic concurrente, CLIENT mechanics, ledger sin secretos, operación en vuelo CONFLICT).
