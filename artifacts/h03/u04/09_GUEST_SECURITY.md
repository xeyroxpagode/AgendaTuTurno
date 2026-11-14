# 09 — GUEST SECURITY (G09)

**Estado:** VERIFIED_PASS

Token ≥256 bits, digest SHA-256, comparación en tiempo constante, revocación/rotación, una Reservation, unique digest. Envelope AEAD AES-256-GCM con `key_version` y TTL 24h; sin plaintext en auditoría/ledger/log/URL. Pruebas: `booking-security.spec.ts` (6/6 PASS) + flujo E2E (token recuperado solo con proof).
