# 22 — SEMANTIC CONCORDANCE (G22)

**Estado:** PARTIAL (bloqueos externos documentados)

Verificación semántica crítica:
- Reservation confirmada existe de verdad: sí (G07/G08, DB real).
- Allocation ocupa correctamente: sí (GiST + tests).
- Guest accede sin cuenta: sí (G09/G10).
- CLIENT accede a su reserva: bloqueado (U02 ausente).
- Idempotencia: sí (G05).
- Historial de reprogramación conserva identidad/snapshots: sí (G13).
- Cutoff 120 min inclusivo: sí (unit `cutoffAllows`).
- Seguridad: sin accesos cruzados (RLS + composite FK + 404 opaco).
- Staff override no debilita ocupación: sí (G15, usa Release/Replace U03).
- U03 única autoridad temporal: sí (sin segundo motor).

CL-01–CL-12: CLOSED (CL-06 recovery fail-closed por canal; CL-07 ANY→concreto; CL-12 sin CRM auto).
CR-01–CR-16: CLOSED excepto CR-08/CR-11 (CLIENT, bloqueados por U02).
R-01–R-30: todos satisfechos salvo R-14/R-15 (CLIENT, U02).
AC-01–AC-50: PASS excepto AC-15/AC-16/AC-39/AC-40 (CLIENT/blocked).
