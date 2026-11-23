# F01 — LEDGER DE EJECUCIÓN (H06 integral)

**Baseline:** rama `feature/h05-global-implementation` @ `116148f2279fc092cbec3eede7c66144ee4d730f`
**G0a:** registrado en `F01_GATE0A_ACCEPTANCE.md` (2026-11-19)
**Grafo:** `F01_DEPENDENCY_GRAPH_ADJUSTED.md` (91 tareas, 195 aristas, 0 ciclos)
**Veredicto funcional:** NO se declara `H06 FUNCTIONAL FROZEN/PASS` en F01 (pertenece a G01).

## Estado de work packages

| WP | Nombre | Tareas | Estado | Checkpoint |
|---|---|---|---|---|
| WP-0 | Contratos y tipos canónicos | T001–T006 | COMPLETADO | `pnpm typecheck` PASS; 11 caps en 4 mapas; 10 códigos ORDER_*; helper opaco compartido |
| WP-1 | Modelo de datos y migraciones M1–M3 | T007–T016 | COMPLETADO | `evidence/h06/F01_MIGRATION_EVIDENCE.md`: QA limpia + upgrade + rollback, 0 ciclos de datos |
| WP-2 | H03 Identity / Guest Credential | T017–T023 | COMPLETADO | `order-credential.ts`; Q25/Q26/Q27 PASS |
| WP-3 | H04 Inventory (authority ORDER) | T024–T029 | COMPLETADO | variant ORDER + release + source_reference; H04 33/33 |
| WP-4 | Dominio y comandos H06 | T030–T039 | COMPLETADO | Q13/Q14/Q29/Q30/Q32/Q33/Q42/Q46 PASS |
| WP-5 | H05 Checkout/Money/Delivery | T040–T049 | COMPLETADO | sourceReference interno + reuse; Q36/Q39/Q41 PASS; H05 99/99 |
| WP-6 | API e IAM | T050–T060 | COMPLETADO | 18 endpoints; `api.spec.ts` 3/3 |
| WP-7 | Frontend y UX | T061–T071 | COMPLETADO* | `UX_V3B06_COMPOSITION_BASIS.md`; build PASS; Playwright 3/3 (*G0b pendiente) |
| WP-8 | Auditoría, observabilidad, recuperación | T072–T077 | COMPLETADO | `evidence/h06/F01_AUDIT_RECOVERY.md` |
| WP-9 | QA y evidencia G01 | T078–T091 | PREPARADO_PARA_G01 | 20/20 unit+integration; 3/3 e2e; Q50 NO declarado |

## Regla de avance

Un WP passa a `COMPLETADO` sólo cuando: (a) sus tareas tienen DoD verificable; (b) evidencia reproducibles (comando + fecha + SHA + ambiente); (c) typecheck del alcance; (d) `git diff --check`. Los checkpoints son internos de F01, no aceptaciones parciales.

## Registro de autocorrecciones

| ID | Hallazgo | Corrección | Alcance | Fecha |
|---|---|---|---|---|
| AC-01 | Grafo E01 §4 invierte `T061/T064 → T070` y omite precedencia de `T070` sobre `T065..T069` | Ajuste local del grafo, 5 aristas nuevas, 0 ciclos; `F01_DEPENDENCY_GRAPH_ADJUSTED.md` | Documental / trazabilidad | 2026-11-19 |
| AC-02..05 | Colisión de constraint SQL, índice parcial inválido, tipo de `resource_id`, rollback incompleto | Ver `evidence/h06/F01_MIGRATION_EVIDENCE.md` §5 | Migraciones M1–M3 | 2026-11-19 |
| AC-06..09 | FK de auditoría pre-intento, firma de `settleDurableOperation`, cast uuid/text, DENIED ausente | Ver `F01_FINAL_HANDOFF_TO_G01.md` §5 | Dominio / API | 2026-11-19 |

## Registro de riesgos y limitaciones

- G0b (composición visual V3-B06) pendiente de Actor A; no bloquea backend/migraciones/dominio/QA no visual.
- Q50 se ejecuta sólo en G01; no se declara PASS en F01.
- DB QA debe ser aislada (`youngkingz_h06_*`). Nunca migrar contra BD compartida.
