# 20 — AX-01–AX-60 MATRIX (G20)

**Estado:** PARTIAL (trazabilidad composicional; no se ejecutaron los 60 individualmente)

Matriz resumida por familia (evidencia compuesta):

- Identidad (AX-01–08): Guest token por reserva (G09), cross-tenant 403/404 (G16), CLIENT bloqueado por U02 (G11), recovery fail-closed (G14). → VERIFIED (excepto CLIENT AX-03/07 vía U02: NOT_VERIFIED).
- Disponibilidad (AX-09–20): U03 autoridad única; D13 rechazado; buffers exactos; horizonte 30; lead 0; ANY balanceo. → VERIFIED (U03 suites).
- Confirmación/idempotencia (AX-21–30): doble clic, response perdida, retry concurrente, payload distinto, actor distinto, rollback Reservation/Claim, entrega fallida recuperable. → VERIFIED (booking-principals + booking-confirm).
- Cancelación/reprogramación (AX-31–40): cutoff inclusivo (unit `cutoffAllows`), doble cancel, cancel vs reschedule serializado por lock, destino ocupado conserva origen, Replace fallido conserva origen, política nueva preserva derechos. → VERIFIED.
- Reconciliaciones adicionales (AX-41–60): despublicación no destruye derechos anteriores (U03 impact rules), servicio retirado no se reprograma públicamente (reschedule requirePublic), precio posterior a confirmación congelado (snapshot), reprogramaciones sucesivas (mismo ID + eventos), cuenta creada después no auto-link (sin CRM auto), terceros con IDs sin acceso, token válido fuera de cutoff (leer sí, cancelar no), override sin motivo denegado, CANCELLED no reprogramable, hechos posteriores U07 no mutables públicamente, multi-Business titularidad real, notificación externa no afecta reserva. → VERIFIED excepto AX-47/48 (CLIENT association, bloqueado U02) y AX-55 (U07 futuro).

No se inventan 60/60 PASS nominales; se declara trazabilidad composicional con los gates anteriores.
