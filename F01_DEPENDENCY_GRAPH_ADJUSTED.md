# F01 — GRAFO DE DEPENDENCIAS AJUSTADO (UX precedence fix)

**Fecha:** 2026-11-19
**Autoridad:** Handoff H06/F01 §5 «Ajuste obligatorio de frontend» (Actor B) + contrato F01 §27 / CORR-03.
**Alcance:** Ajuste **local al grafo**. No modifica Task IDs, decisiones D01–D29, T-01..T-12 ni CF-01..CF-12.

---

## 1. Inconsistencia detectada

`E01 — FINAL DEPENDENCY GRAPH.md` §4 afirma que las aristas `T061 → T070` y `T064 → T070` fueron **eliminadas** y reemplazadas por `T070 → T061` y `T070 → T064`. Esa afirmación contradice:

- `E01 — FINAL TASK REGISTER.csv`: `T070.Dependencias = D01-T061; D01-T064; D01-T071`; `T061.Habilita = D01-T070`; `T064.Habilita = D01-T070`.
- `E01 — CORRECTIVE OVERLAY.md` CORR-03: «`T070` depende de `T061`, `T064`, `T071`; `T070` permanece en nivel 11, aguas abajo de las rutas base que necesita para el wrapper HTTP».
- Contrato F01 §27 tabla de artefactos: componentes compartidos `T070` «sobre el andamiaje anterior; depende de `T061`, `T064`, `T071`».
- La propia tabla de niveles de E01: `T061` nivel 10 → `T070` nivel 11.

Además, el registro no hacía efectiva la precedencia de `T070` sobre los recorridos completos `T065..T069` que consumen los componentes compartidos: `T065..T069` sólo dependían de `T064`/`T054`/`T055`.

## 2. Ajuste aplicado

| Arista | Acción | Motivo |
|---|---|---|
| `T061 → T070` | CONFIRMADA (ya presente en el CSV; se corrige la documentación del grafo) | Andamiaje de rutas precede a componentes compartidos |
| `T064 → T070` | CONFIRMADA (ídem) | Ídem, carril Recepción/Owner |
| `T071 → T061`, `T071 → T064`, `T071 → T070` | CONFIRMADAS | Validación UX gobierna la composición |
| `T070 → T065` | AÑADIDA | Recorrido Recepción S41 consume componentes compartidos |
| `T070 → T066` | AÑADIDA | Recorrido Recepción S42 consume componentes compartidos |
| `T070 → T067` | AÑADIDA | Recorrido Recepción S44/S45 consume componentes compartidos |
| `T070 → T068` | AÑADIDA | Checkout/entrega UI consume componentes compartidos |
| `T070 → T069` | AÑADIDA | Supervisión Owner consume componentes compartidos |

**Nota:** las aristas `T070 → T061` / `T070 → T064` que E01 §4 declara añadidas **no existen** en el registro de 91 tareas; no se eliminó ninguna arista real del registro. La corrección es de documentación + cinco aristas nuevas de precedencia de consumo.

## 3. Métricas recalculadas

| Métrica | E01 (registro) | F01 ajustado |
|---|---:|---:|
| Tareas | 91 | **91** |
| Aristas | 190 (+ 1 valor centinela de `T071` no task) | **195** |
| Raíces | 4 | **4** (`T001`, `T002`, `T005`, `T071`) |
| Terminales | 18 | **18** |
| Niveles | 20 | **20** |
| Ciclos (DFS colores) | 0 | **0** |

Secuencia verificada: `T071 → {T061, T064} → T070 → {T065..T069} → T087`.

### Niveles topológicos (adjusted)

| Nivel | Tareas |
|---:|---|
| 0 | T001; T002; T005; T071 |
| 1 | T003; T004; T057 |
| 2 | T006; T007; T024 |
| 3 | T008; T009; T026; T027; T029 |
| 4 | T010; T011 |
| 5 | T012; T030 |
| 6 | T013; T014; T015; T017; T025; T033; T035; T036; T037; T041; T042; T072 |
| 7 | T016; T018; T020; T021; T022; T028; T032; T043; T053; T059; T077; T079 |
| 8 | T019; T031; T034; T040; T058; T064; T074; T078 |
| 9 | T023; T044; T050; T052; T056; T073; T081; T086 |
| 10 | T045; T051; T061 |
| 11 | T046; T047; T062; T070 |
| 12 | T038; T048; T063; T065; T076; T082 |
| 13 | T039; T049; T054; T066; T083 |
| 14 | T055; T067; T075; T084 |
| 15 | T060; T068; T069 |
| 16 | T080; T085; T087 |
| 17 | T088 |
| 18 | T089; T090 |
| 19 | T091 |

## 4. Verificación ejecutada

Script PowerShell sobre `E01 — FINAL TASK REGISTER.csv` (91 filas):
- Parseo de `Dependencias` con filtro `^T\d{3}$` (excluye el centinela `—` de `T071`).
- Conteo de aristas: 191 → 190 reales → 195 tras añadir las cinco aristas de consumo.
- DFS con colores (0/1/2): **0 ciclos**.
- Cálculo de niveles por relajación hasta punto fijo: **20 niveles**.

Este documento es la referencia de grafo para F01 y sustituye a E01 §4 donde discrepaba.
