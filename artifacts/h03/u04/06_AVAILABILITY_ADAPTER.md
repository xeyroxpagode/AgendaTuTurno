# 06 — AVAILABILITY ADAPTER (G06)

**Estado:** VERIFIED_PASS

U03 es la única autoridad temporal. Booking consume `resolveSlot`/`claimAllocation`/`releaseAllocation`/`replaceAllocation` pasando su propio `Tx` (sin Tx anidada; verificado en `allocation.ts`). Extensión mínima para términos históricos: `resolveSlot` y `AllocationClaimInput` aceptan `termsOverride?: ServiceRequirement[]`; la validación de publicación/elegibilidad actual se mantiene (`requirePublic`). Guard Business siempre primero (`lockAvailabilityGuard`).

D13 presente y verificado (`resolveSlot`: `new Set(serviceIds).size !== serviceIds.length` → VALIDATION_ERROR; test "rejects duplicate service IDs in Claim per D13").

Pruebas: suites U03 (44/44) + E2E confirm (2/2) + integridad (17/17).
