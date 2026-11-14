# GF-03R — RESUMEN (complemento al reporte principal)

## RESUMEN
- Total hallazgos: 5
- P0: 2 | P1: 2 | P2: 1 | P3: 0 (sub-observaciones P2 y P3 anotadas dentro de hallazgos)
- FIXED_VERIFIED: 4 | CONFIRMED_DEFECT_PARCIAL: 1 | ...

## ESTADO POR PREGUNTA
- Q1 Recovery AEAD: FIXED_VERIFIED (recovery.ts:64; guest-access.ts:66-75)
- Q2 Drizzle booking.ts consistente con SQL: FIXED_VERIFIED + obs. P2 (booking.ts; guest_delivery_envelopes sin CHECK)
- Q3 STAFF_EXCEPTION_APPLIED se emite: FIXED_VERIFIED (staff-exceptions.ts:26-28, 53-55)
- Q4 Aserciones débiles fortalecidas: FIXED_VERIFIED (confirm L69; principals L96-100; availability L102-110)
- Q5 Códigos de error huérfanos con tests: PARCIAL / CONFIRMED_DEFECT (spec cubre 7 de 12; faltan RATE_LIMITED, GUEST_RECOVERY_NOT_VERIFIED, BOOKING_ALREADY_CANCELLED, BOOKING_OPERATION_NOT_RECOVERABLE, CLIENT_AUTH_INSUFFICIENT)

## LIMITACIÓN
No se encontró `schema.sql` / migración SQL independiente para diff directo contra el esquema Drizzle; la consistencia se verificó intra-schema y contra el uso de columnas en recovery.ts.
