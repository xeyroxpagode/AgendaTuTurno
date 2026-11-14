# EGM — Portabilidad de la instalación Owner → H03 (OpenCode V2)

- **Contrato:** `YKZ-EGM-V2-OWNER-TO-H03-PORTABILITY-V1.0`
- **Modo:** READ-ONLY SOURCE → CONTROLLED DESTINATION INSTALLATION → RUNTIME VERIFICATION
- **Origen (solo lectura):** `C:\Users\thega\Desktop\YoungKingZ-Owner-Design`
- **Destino (instalación controlada):** `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation`
- **Fecha de ejecución:** 2026-09-11
- **OpenCode:** v2.1.4 (Windows, win32 x64)
- **Veredicto (G09):** `EGM H03 — PORTED / RUNTIME VERIFIED`
- **Alcance excluido por decisión del usuario:** auditoría semántica H03, drift report, GF-01–GF-08, correctivos U02/U03/U04, rediseño Owner. Este informe **no** emite hallazgos semánticos ni aprueba auditorías de contenido de EGM.

---

## 1. Objeto y alcance

Portar la instalación funcional de Google Elephant-Goldfish Model (EGM) desde el worktree `YoungKingZ-Owner-Design` hacia el worktree `YoungKingZ-U03-Implementation`, preservando íntegramente la implementación y los datos preexistentes del destino, y verificar el comportamiento real con OpenCode V2.

Lo que este lote hace y lo que no:

| Hace | No hace |
|---|---|
| Copia los adaptadores `.opencode/` (11 agentes + 7 skills) y el snapshot canónico `tools/egm/` | No modifica el origen (verificado por hash y por `git status`) |
| Ajusta la raíz absoluta canónica `Owner-Design` → `U03-Implementation` en los 18 adaptadores | No reconstruye skills, no altera personas canónicas ni estándares Google |
| Verifica descubrimiento, permisos y ejecución real Elephant→Goldfish | No ejecuta el instalador V1 (`tools/egm/adapters/opencode/install.py`) |
| Documenta límites reales de aislamiento | No modifica config global de OpenCode, BD, frontends, `.env`, `src/`, `apps/`, `packages/`, `tests/`, `migrations/`, `artifacts/` |

## 2. Contrato, gates y modo de ejecución

| Gate | Resultado | Evidencia |
|---|---|---|
| G00 inspección del origen | PASS | §4 |
| G01 inspección de la instalación origen | PASS | §4, §16 |
| G02 manifiesto previo + colisiones | PASS (sin colisiones) | §6 |
| G03 transferencia de recursos canónicos | PASS | §8 |
| G04 preservación de restricciones (sin rediseño) | PASS | §10, §11, §16 |
| G05 descubrimiento y permisos | PASS | §10, §11, §12 |
| G06 verificación runtime | PASS | §13, §14, §15 |
| G07 integridad final origen/destino | PASS | §17, §18 |
| G08 informe único | PASS (este archivo) | §1–§20 |
| G09 veredicto | `EGM H03 — PORTED / RUNTIME VERIFIED` | §20 |

Modo de escritura: **solo** `.opencode/` y `tools/egm/` en el destino. Origen estrictamente solo lectura (solo lecturas y consultas `git` de contenido).

## 3. Entorno de verificación

- OpenCode CLI `v2.1.4`.
- Config global (solo lectura, no modificada): `C:\Users\thega\.config\opencode\opencode.jsonc` — `shell: powershell`, `default_agent: build`, `share: disabled`, reglas `shell * ask` + `allow` para `git status/diff/log/branch/rev-parse/show/ls-files`, `rg`, `Get-Content`, `Select-String`, `deny` para `git push/reset/clean`.
  - `LastWriteTime` de `opencode.jsonc`: **21/10/2026 16:01:05** (anterior a esta tarea) → sin escrituras de esta tarea.
  - Agentes globales `audit.md` y `docs.md`: `LastWriteTime` 05/08/2026 → sin escrituras de esta tarea.
- Plataforma: Windows 11 (`10.0.26300`), `win32 x64`, shell `powershell`.
- Servidor de verificación: `opencode serve --port 41778 --hostname 127.0.0.1` lanzado **con cwd en el destino**; autenticación HTTP Basic (`opencode:<password>`). La contraseña se generó al arrancar el servidor y **no** se reproduce aquí ni se almacena en el repositorio.
- Proveedor/modelo efectivo de los smoke tests: `nvidia/minimaxai/minimax-m3.1-flash` (variante `default`), con credenciales ya presentes en el almacén de auth del usuario. No se envió ningún secreto ni dato de proyecto a terceros durante las pruebas: la única petición HTTP externa fue un `GET` a `https://example.com` (§15).

## 4. Estado del origen (Owner) al inicio y a cierre

| Atributo | Valor |
|---|---|
| HEAD | `745169e113eac6c063b5059b502855e3d638e907` (sin cambios al cierre) |
| Rama | `main` (sin cambios al cierre) |
| Contenido | `.opencode/` con **11 agentes EGM** (`egm.md` + 10 Goldfish) y **7 skills** (`<id>/SKILL.md`) |
| Modes | `egm`, `egm-synthesizer`, `egm-bootstrap-orchestrator` = `primary`; los otros 8 agentes = `subagent` |
| Snapshot canónico | `tools/egm/` = repo git propio, upstream `https://github.com/google/elephant-goldfish-model.git`, HEAD `b7d9e2706fb96314a0a3123684f53cedd97e7d79`, rama `main` |
| Config propia | No existe `AGENTS.md` ni `opencode.json(c)` en la raíz de Owner |
| Reporte previo | `EGM_OPENV2_INSTALLATION_REPORT.md` (instalación anterior; ver discrepancia D1 en §16) |
| Log global | `C:\Users\thega\.local\share\opencode\log\opencode.log` sin ejecuciones EGM previas (sin línea base de uso real) |

G01 — Hallazgos de inspección del origen (heredados por el puerto, verificados también en destino):

- Los 10 cuerpos Goldfish son copia canónica de `tools/egm/agents/*.md`; 8/10 coinciden con el canónico (normalización de whitespace). Las 2 excepciones son **D2** y **D3** (§16) y se preservaron tal cual.
- Las skills canónicas referencian `agents/<file>.md` y `resources/document_standards/` relativos al bundle root, por lo que la copia íntegra de `tools/egm/` es condición necesaria para que funcionen.
- El adaptador usa rutas absolutas al bundle canónico (mecanismo probado en Owner). Se conservó ese mecanismo ajustando solo la raíz.

## 5. Estado del destino (H03) al inicio y baseline

| Atributo | Valor (sin cambios al cierre) |
|---|---|
| HEAD | `35aab9e331cffde792be4721a07cb72656b60e33` |
| Rama | `feature/h03-u03-implementation` |
| Natureza | Linked worktree del mismo repo que Owner (`git-common-dir` = `.git` de Owner) |
| Contenido previo | Sin `.opencode/`, sin `tools/`, sin `opencode.json(c)`, sin skills ni agentes EGM previos |
| Cambios preexistentes | Implementación H03 en curso (`apps/`, `packages/`, `tests/`, `migrations/`, `artifacts/`, `docs/`) — **preservados sin tocar** |

Baseline capturado antes de escribir (en `C:\Users\thega\AppData\Local\Temp\opencode\egm-port\`): `owner-status-before.txt`, `owner-head-before.txt`, `owner-branch-before.txt`, `owner-opencode-hashes-before.txt` (18 archivos), `owner-egm-hashes-before.txt` (301 archivos), `dest-status-before.txt`, `dest-head-before.txt`, `dest-branch-before.txt`.

## 6. Manifiesto de paths (G02) y resultado de colisiones

Manifiesto presentado en conversación **antes** de escribir:

| # | Path de destino | Tipo | Colisión |
|---|---|---|---|
| 1–11 | `.opencode/agents/egm.md`, `egm-bootstrap-orchestrator.md`, `egm-codebase-details.md`, `egm-comprehension.md`, `egm-design.md`, `egm-implementation-readiness.md`, `egm-inventive-catalyst.md`, `egm-structural.md`, `egm-style.md`, `egm-synthesizer.md`, `egm-zoom-out.md` | adaptador de agente | ninguna |
| 12–18 | `.opencode/skills/{egm-bootstrap,egm-brainstorm,egm-draft,egm-drift-report,egm-resolve,egm-review,egm-review-loop}/SKILL.md` | adaptador de skill | ninguna |
| 19 | `tools/egm/**` (301 archivos, snapshot canónico upstream) | árbol canónico | ninguna |
| — | `.opencode/EGM_OWNER_TO_H03_PORTABILITY_REPORT.md` | informe G08 | ninguna |

**Resultado:** 0 colisiones (el destino no tenía `.opencode/`, `tools/`, `opencode.json(c)`, ni skills/agentes previos). No se requirió aprobación de colisiones y la transferencia continuó automáticamente.

## 7. Procedencia canónica de `tools/egm`

- Upstream: `https://github.com/google/elephant-goldfish-model.git`, rama `main`, commit `b7d9e2706fb96314a0a3123684f53cedd97e7d79`.
- El destino **no** incluye `.git` de ese submódulo (`tools/egm/.git` ausente): es una copia de contenido, no un clon, y no puede mutar por sí sola.
- Contenido copiado: 301 archivos = raíz (`.gitattributes`, `.gitignore`, `ACCESSIBILITY.md`, `AGENTS.md`, `AI_POLICY.md`, `CONTRIBUTING.md`, `LICENSE`, `plugin.json`, `pyproject.toml`, `README.md`, `TESTING.md`) + 18 directorios (`.agents` 1, `.claude-plugin` 13, `.codex-plugin` 1, `.cursor-plugin` 11, `.gemini` 2, `.github` 14, `.plugin` 1, `adapters` 1, `agents` 10, `assets` 1, `com.github.copilot` 9, `distributions` 66, `docs` 33, `resources` 7, `scripts` 2, `site` 51, `skills` 38, `tests` 29).
- `site/`, `tests/` y `distributions/` se incluyen por ser parte del snapshot upstream íntegro (no se podaron).
- `tools/egm/adapters/opencode/install.py` (instalador V1) está presente **solo como recurso canónico**; **no se ejecutó**.

## 8. Mecanismo de copia e integridad de archivos

- Copia: `robocopy /E /XD .git` desde el origen hacia `tools/egm/`.
- Verificación posterior (SHA-256, archivo por archivo, origen vs. destino): `SRC_COUNT=301`, `DST_COUNT=301`, `MISSING=0`, `EXTRA=0`, `MISMATCH=0`; `tools/egm/.git` ausente en destino.
- Verificación de los 18 adaptadores: el contenido de destino es **byte-idéntico** al de origen tras sustituir exclusivamente la raíz absoluta; `MISSING=0`, `EXTRA=0`, `MISMATCH=0`.
- Referencias residuales a `Owner-Design` en destino: **0** (barrido sobre `.opencode/**` y `tools/egm/**`).
- Todas las referencias `canonical:` de los adaptadores resuelven dentro del destino: `AGENT_CANONICAL_MISSING=0`, `SKILL_CANONICAL_MISSING=0` (11 agentes + 7 skills).

## 9. Adaptadores `.opencode/`: transformación aplicada

Única transformación: reemplazo literal de la raíz absoluta canónica.

```
C:/Users/thega/Desktop/YoungKingZ-Owner-Design  →  C:/Users/thega/Desktop/YoungKingZ-U03-Implementation
```

- Sustituciones: 2 ocurrencias por adapter de agente y por adapter de skill; 5 en `egm.md` (frontmatter `source` + cuerpo).
- Frontmatter V1 (`permission`, `task`, `bash`) preservado tal cual: OpenCode V2.1.4 lo migra a `permissions`/`subagent`/`shell` (compatibilidad V1→V2 soportada). No se migró a JSON nativo V2 para no alterar un mecanismo ya probado.
- **No** se creó `opencode.json(c)` en el destino: `opencode debug config` muestra los documentos de configuración efectivos como `global opencode.jsonc` + `~/.config/opencode` (directorio) + `<destino>/.opencode` (directorio), idéntico al patrón de Owner. El descubrimiento de agentes y skills funciona por convención de directorio.

## 10. Descubrimiento de agentes (G05)

`opencode debug agents` con cwd en el destino → **20 agentes**: `audit`, `build`, `compaction`, `docs`, `explore`, `general`, `plan`, `summary`, `title` (base OpenCode/global) + **11 agentes EGM**.

Comparación estática Owner vs. destino sobre los 11 agentes EGM: `OWNER_EGM=11`, `DEST_EGM=11`, `EGM_MODE_PERM_DIFFS=0` → modos y listas de permisos efectivos **idénticos**.

| Agente | Mode | Rol |
|---|---|---|
| `egm` | primary | Elefante (orquestador) |
| `egm-synthesizer` | primary | Goldfish sintetizador (heredado de Owner) |
| `egm-bootstrap-orchestrator` | primary | Goldfish orquestador (heredado de Owner) |
| `egm-zoom-out`, `egm-comprehension`, `egm-design`, `egm-structural`, `egm-style`, `egm-codebase-details`, `egm-implementation-readiness`, `egm-inventive-catalyst` | subagent | Goldfish revisores delegables |

## 11. Permisos efectivos (G05)

Permisos efectivos observados en destino (idénticos a Owner):

**Elefante (`egm`)** — `read * allow`, `glob * allow`, `list * allow`, `edit * allow`, `subagent * allow`, `external_directory * ask`, `shell * ask` (+ `allow` para `git status/diff/log/branch/rev-parse`, `rg`, `Get-Content`, `Select-String`; `deny` para `git push/reset/clean`), `webfetch/websearch * ask`, `browser * deny`.

**Goldfish (los 10)** — `read * allow`, `glob * allow`, `list * allow`, `edit * deny`, `shell * deny`, `subagent * deny`, `external_directory * deny`, `webfetch * deny`, `websearch * deny`, `browser * deny`.

Heredadas de la config global y aplicadas **antes** de las reglas de agente: `read *.env ask`, `read *.env.* ask`, `read *.env.example allow`, `external_directory * ask`, `shell * ask` (+ allow-list de comandos de solo lectura), `deny` de `git push/reset/clean`.

Restricciones EGM preservadas sin rediseño: revisores sin escritura, sin shell, sin subagentes, sin red declarada, sin directorio externo; Elefante con escritura y delegación habilitadas; cada revisión debe usar sesión fresca de subagente (protocolo textual en `egm.md`, punto 3: “no parent history, private reasoning, or memory is passed to reviewers”).

## 12. Descubrimiento de skills (G05)

Consulta al API del servidor con `directory` = destino → 10 skills: `opencode` y `report` (builtin), `find-skills` (global del usuario) + **7 skills EGM**:

| ID | Path descubierto |
|---|---|
| `egm-bootstrap` | `<destino>\.opencode\skills\egm-bootstrap\SKILL.md` |
| `egm-brainstorm` | `<destino>\.opencode\skills\egm-brainstorm\SKILL.md` |
| `egm-draft` | `<destino>\.opencode\skills\egm-draft\SKILL.md` |
| `egm-drift-report` | `<destino>\.opencode\skills\egm-drift-report\SKILL.md` |
| `egm-resolve` | `<destino>\.opencode\skills\egm-resolve\SKILL.md` |
| `egm-review` | `<destino>\.opencode\skills\egm-review\SKILL.md` |
| `egm-review-loop` | `<destino>\.opencode\skills\egm-review-loop\SKILL.md` |

Los 7 adapters resuelven su `canonical:` al `tools/egm/skills/<id>/SKILL.md` **del destino** (verificado en el contenido servido). OpenCode V2 deriva el ID del directorio `<id>/SKILL.md`; los 7 IDs coinciden con los canónicos.

## 13. Runtime — Smoke test 1: delegación real, lectura y escritura denegada

Comando (cwd = destino):

```
opencode run --server http://127.0.0.1:41778 --agent egm \
  --model nvidia/minimaxai/minimax-m3.1-flash --format json \
  --title "EGM H03 portability runtime smoke test" "<prompt sintético>"
```

Datos de sesión (API `/api/session`):

| | Sesión padre | Sesión hija |
|---|---|---|
| ID | `ses_e3cfd7772ffeLqOxDl8hWcMgcf` | `ses_e3cfcb6a8ffe5UubOsBuQ2vjFo` |
| `parentID` | — | `ses_e3cfd7772ffeLqOxDl8hWcMgcf` |
| `agent` | `egm` | `egm-comprehension` |
| `model` | `nvidia/minimaxai/minimax-m3.1-flash#default` | `nvidia/minimaxai/minimax-m3.1-flash#default` |
| `location.directory` | `<destino>` | `<destino>` |

Evidencia:

1. **Delegación real (no simulación):** el Elefante invocó la herramienta `subagent` con `agent: "egm-comprehension"`, `description: "EGM runtime smoke probe"`; el subagente se ejecutó en una **sesión fresca** (ID nuevo, `parentID` apuntando a la sesión del Elefante), conforme al protocolo "fresh session each / no `task_id`".
2. **Lectura permitida:** tool call `read` con `input {"path":".opencode/agents/egm-comprehension.md"}` → `status: completed`, contenido real (85 líneas) incluyendo `name: egm-comprehension` y `edit: deny`.
3. **Escritura denegada:** el subagente intentó exactamente una escritura vía Code Mode (`tools["write"] ?? tools["edit"]`) sobre `.opencode/EGM_RUNTIME_PROBE_DO_NOT_CREATE.md` → error verbatim **`Unknown tool 'write'.`** (la herramienta de escritura/edición no está expuesta al revisor); sin reintento.
4. **Ausencia de efecto en disco:** `Test-Path .opencode\EGM_RUNTIME_PROBE_DO_NOT_CREATE.md` = **False** tras el intento. El directorio `.opencode/` del destino contiene exactamente los 18 adapters (11 agentes + 7 skills).
5. **Recepción por el Elefante:** el Elefante recibió el informe del subagente y devolvió `SUBAGENT: egm-comprehension`, `SUBAGENT_SESSION: ses_e3cfcb6a8ffe5UubOsBuQ2vjFo`, `READ_RESULT: name: egm-comprehension`, `WRITE_ATTEMPT_OUTCOME: Unknown tool 'write'.` y un resumen de hallazgos (3 bloqueantes, 4 mayores, 2 nits sobre el documento sintético).

## 14. Runtime — Smoke test 2: aislamiento de lectura

Mismo mecanismo (`opencode run --agent egm`, modelo `nvidia/minimaxai/minimax-m3.1-flash`), delegando a `egm-zoom-out`.

| | Sesión padre | Sesión hija |
|---|---|---|
| ID | `ses_e3cf51521ffeUKKTjIZSLPp80p` | `ses_e3cf4ccabffe2wvjC27WHq0Bln` |
| `parentID` | — | `ses_e3cf51521ffeUKKTjIZSLPp80p` |
| `agent` | `egm` | `egm-zoom-out` |

Evidencia:

1. **Lectura fuera del proyecto → denegada:** tool call `read` sobre ruta absoluta `C:\Users\thega\AppData\Local\Temp\opencode\egm-port\smoke-prompt.txt` (fuera del directorio del proyecto) → `{"error":{"type":"permission.rejected","message":"Permission denied: external_directory"},"content":[]}`. Sin reintento por otra herramienta.
2. **Control interno → permitida:** `read` de `.opencode/agents/egm-zoom-out.md` (relativa al proyecto) → `status: completed`, `name: egm-zoom-out`.
3. **Conclusión:** para los revisores Goldfish, `external_directory: deny` **sí** se aplica en runtime. El límite es el directorio del proyecto: dentro de él, la lectura no está restringida por ruta (§16, L3).

## 15. Runtime — Smoke test 3: catálogo de capacidades y egreso de red

| | Sesión padre | Sesión hija |
|---|---|---|
| ID | `ses_e3cf12306ffeuOIq3FUqEX4qvl` | `ses_e3cf0f3b7ffeKzp0YfE82e6JGR` |
| `parentID` | — | `ses_e3cf12306ffeuOIq3FUqEX4qvl` |
| `agent` | `egm` | `egm-style` |

Evidencia:

1. **Code Mode disponible para el revisor:** el subagente ejecutó JavaScript en el runtime `execute`.
2. **Catálogo enumerable:** `Object.keys(tools).sort()` → `["browser", "opencode"]`. No aparecen `write`, `edit`, `bash`/`shell` ni `read`/`glob` (los de archivo se invocan como tools directas de la sesión).
3. **Sonda de capacidad no concluyente por diseño del proxy:** `typeof tools.bash !== "undefined"` (y equivalentes) devuelve `true` para **cualquier** nombre; `Object.getOwnPropertyDescriptor` no existe en ese runtime (`TypeError`). La forma fiable de comprobar capacidad es la invocación, y la invocación falla cerrada: `Unknown tool 'write'.` (§13).
4. **Egreso de red disponible dentro del Code Mode:** `fetch("https://example.com")` → `{"status": 200, "bodyFirst80": "<!doctype html><html lang=en>...", "error": null}` — **una sola** petición, sin datos de proyecto, sin cabeceras, sin credenciales.
5. **Control interno:** `read` de `.opencode/agents/egm-style.md` → `name: egm-style`.

## 16. Límites reales, discrepancias heredadas y no-verificaciones

Distinción explícita: **evidencia confirmada** (runtime o hash) vs. **inferencia** (derivada de configuración, sin prueba de ejecución).

| ID | Tipo | Enunciado | Evidencia |
|---|---|---|---|
| L1 | Evidencia | El runtime Code Mode (`execute`) queda expuesto a las sesiones Goldfish y permite **egreso HTTP saliente** (`fetch`, HTTP 200 a `https://example.com`), pese a `webfetch: deny` / `websearch: deny` en el frontmatter del agente. La denegación de red del adaptador **no** cubre el Code Mode. | §15 (runtime) |
| L2 | Evidencia | La capacidad real se decide en la invocación, no en `typeof`/`in`: las tools no expuestas fallan cerradas (`Unknown tool 'write'.`) y no producen efectos en disco. | §13, §15 |
| L3 | Inferencia | Dentro del directorio del proyecto un Goldfish puede leer cualquier archivo; el destino contiene `.env` (949 B, gitignored). El orden de reglas (global `read *.env ask` → agente `read * allow`, última coincidencia gana) sugiere que la lectura de `.env` **no** queda bloqueada. No se probó en runtime para no exponer secretos en la transcripción. | `opencode debug agents` (orden de permisos) + `.env` presente |
| L4 | No verificado | `shell: deny` no se ejercitó en runtime (no se ejecutó shell desde un revisor por seguridad); queda como evidencia estática de permisos + ausencia de shell en el catálogo enumerable. | §11, §15 |
| L5 | Evidencia | `egm-synthesizer` y `egm-bootstrap-orchestrator` son `mode: primary`; el protocolo del Elefante lista 10 revisores, pero solo 8 son delegables como subagente. Característica **heredada de Owner** (idéntica en ambos), no introducida por el puerto. | `opencode debug agents` en Owner y destino |
| L6 | Evidencia | `tools/egm` del destino no es un clon: sin `.git`, inmutable por diseño pero tampoco actualizable con `git pull`. La actualización futuras exige recopia manual. | §7, §8 |
| D1 | Evidencia | Discrepancia documental heredada: `EGM_OPENV2_INSTALLATION_REPORT.md` (Owner), línea 35, describe `.opencode/skills/<nombre>/skill.md` en minúscula; en disco el archivo es `SKILL.md` (mayúscula), que es la forma que OpenCode V2 usa para derivar el ID. La discovery (§12) confirma que la forma en disco funciona. No se corrigió (el puerto preserva Owner byte a byte salvo la raíz). | §12 + lectura del reporte de Owner |
| D2 | Evidencia | Delta heredado: `.opencode/agents/egm-inventive-catalyst.md` usa `### Audit Vectors:` (L88) frente al canónico `## Audit Vectors:` (L73). | comparación canónico/adapter |
| D3 | Evidencia | Delta heredado: `.opencode/agents/egm-synthesizer.md` omite 3 frases del canónico que contienen “using your file-writing tool” (L13 *Artifact-First Delivery*, L33 *Write Deliverable*, L65 *Write Artifact*). Verificado en destino (0 coincidencias en el adapter vs. 3 en el canónico). | comparación canónico/adapter |
| — | No verificado | No se ejercitaron en runtime: carga de skills por ID (los bodies canónicos de `tools/egm/skills/*` no se ejecutaron), el loop multi-revisor (`egm-review` / `egm-review-loop`), la estabilidad en sesiones largas, ni otros proveedores/modelos. Fuera del alcance de portabilidad (corresponde a auditoría semántica H03, no iniciada). | — |
| — | Decisión | No se corrigieron L1, L3, L5 ni D1–D3: son propiedades del diseño de Owner y del runtime de OpenCode V2, y el contrato prohíbe simplificar/rediseñar el adaptador en este lote. Quedan como candidatas priorizadas para la auditoría H03. | — |

## 17. Integridad final del origen (G07)

| Verificación | Resultado |
|---|---|
| `git rev-parse HEAD` | `745169e113eac6c063b5059b502855e3d638e907` — idéntico al baseline |
| `git branch --show-current` | `main` — idéntico al baseline |
| `git status --short` | Diff contra `owner-status-before.txt` = **0 líneas** (sin cambios atribuibles a este lote) |
| Hashes `.opencode/**` (18 archivos) | `OWNER_HASHES_OPENCODE_DIFF = 0` |
| Hashes `tools/egm/**` (301 archivos) | `OWNER_HASHES_EGM_DIFF = 0` |
| Escrituras en origen | Ninguna (solo lecturas, `git rev-parse`/`git config --get` de contenido y `opencode debug agents/config`) |

## 18. Integridad final del destino y actividad concurrente (G07)

| Verificación | Resultado |
|---|---|
| `git rev-parse HEAD` | `35aab9e331cffde792be4721a07cb72656b60e33` — sin cambios |
| `git branch --show-current` | `feature/h03-u03-implementation` — sin cambios |
| `git diff --check` | exit `0` (solo avisos LF/CRLF preexistentes de archivos ajenos) |
| Archivos stageados | `git diff --cached --name-only` → **vacío** (nada stageado; `git add` no usado) |
| Rutas atribuibles a este lote | `?? .opencode/` y `?? tools/` (18 adapters + 301 archivos canónicos + este informe) |
| Implementación preexistente | Preservada: `apps/`, `packages/`, `tests/`, `migrations/`, `docs/`, `artifacts/`, `supabase/`, `playwright.config.ts`, `vitest.config.ts` sin modificar por este lote |

**Actividad concurrente no atribuible a esta tarea** (detectada durante el lote, no tocada): en la raíz del destino aparecieron `GF-01_FINDINGS_REPORT.md` … `GF-08_TEST_CREDIBILITY_AUDIT_WRONG_WORKSPACE.md` y el árbol `artifacts/h03/egm-audit/`; además varies rebuilds (`apps/*/dist`, `tsconfig.tsbuildinfo`, `next-env.d.ts`). Estos artefactos son de otra línea de trabajo concurrente y quedan fuera del alcance de portabilidad. Se registran aquí solo para trazabilidad, sin atribución ni modificación.

## 19. Comandos reproducibles y artefactos de evidencia

Comandos ejecutados (cwd = destino salvo indicación):

```powershell
# Entorno y descubrimiento
opencode --version                                   # v2.1.4
opencode debug agents                                # 20 agentes (11 EGM)
opencode debug config                                # global doc + ~/.config/opencode + <destino>/.opencode

# Skills por API (servidor con cwd en el destino)
opencode serve --port 41778 --hostname 127.0.0.1     # password por stdout; NO documentada aquí
$env:OPENCODE_SERVER_PASSWORD = "<password>"
opencode api get /api/skill --server http://127.0.0.1:41778

# Smoke tests runtime (prompts sintéticos, sin datos de proyecto)
opencode run --server http://127.0.0.1:41778 --agent egm `
  --model nvidia/minimaxai/minimax-m3.1-flash --format json `
  --title "<título>" "<prompt>"

# Integridad origen/destino
git -C <origen> rev-parse HEAD; git -C <origen> status --short
git rev-parse HEAD; git branch --show-current; git status --short; git diff --check
git diff --cached --name-only
```

Artefactos de evidencia (fuera del repositorio, en `C:\Users\thega\AppData\Local\Temp\opencode\egm-port\`):

| Archivo | Contenido |
|---|---|
| `owner-status-before.txt`, `owner-head-before.txt`, `owner-branch-before.txt` | Baseline del origen |
| `owner-opencode-hashes-before.txt`, `owner-egm-hashes-before.txt` | Baseline de hashes (18 + 301 archivos) |
| `owner-opencode-hashes-after.txt`, `owner-egm-hashes-after.txt` | Hashes de cierre del origen (diff = 0) |
| `dest-status-before.txt`, `dest-head-before.txt`, `dest-branch-before.txt` | Baseline del destino |
| `dest-agents.json`, `owner-agents.json` | `opencode debug agents` en destino y origen |
| `dest-config.json` | `opencode debug config` en destino |
| `dest-skills.json` | `/api/skill` en destino |
| `sessions-after-smoke.json`, `child-messages.json` | Árbol de sesiones y tool calls del smoke test 1 |
| `smoke-run.jsonl`, `smoke-run-2.jsonl`, `smoke-run-3.jsonl` | Trazas JSON de los 3 smoke tests |
| `smoke-prompt.txt`, `smoke-prompt-2.txt`, `smoke-prompt-3.txt` | Prompts sintéticos usados |

## 20. Veredicto (G09) y alcance de lo no ejecutado

**`EGM H03 — PORTED / RUNTIME VERIFIED`**

Base del veredicto (evidencia confirmada):

- Los 11 agentes EGM y las 7 skills EGM se descubren en el destino con modos y permisos efectivos **idénticos** a Owner (`EGM_MODE_PERM_DIFFS=0`).
- Los 301 archivos canónicos son **idénticos bit a bit** (SHA-256) al snapshot upstream `b7d9e27`; los 18 adapters difieren del origen **solo** en la raíz absoluta; 0 referencias residuales a `Owner-Design`; 0 referencias canónicas rotas.
- Runtime real: el Elefante `egm` (modelo `nvidia/minimaxai/minimax-m3.1-flash`) delegó a **dos** revisores Goldfish en sesiones frescas y enlazadas (`parentID`), con lectura dentro del proyecto permitida, lectura externa denegada (`Permission denied: external_directory`) y escritura imposible (`Unknown tool 'write'.`, archivo sonda **ausente** en disco), y los resultados volvieron al Elefante.
- El origen quedó **intacto** (HEAD, rama, `git status` y 319 hashes sin diferencias); el destino conservó implementación y datos preexistentes, sin stagear, sin commit y sin push.

Reservas honestas que **no** invalidan el veredicto de portabilidad (quedan para la auditoría semántica H03, no iniciada):

- L1 (egreso HTTP vía Code Mode pese a `webfetch: deny`) y L3 (lectura de `.env` no bloqueada dentro del proyecto, inferido) son límites reales del diseño heredado, no defectos de copia.
- L4 (`shell: deny` no ejercitado en runtime), L5 (`mode: primary` en 2 Goldfish) y D1–D3 (discrepancias heredadas) quedan documentados sin corregir, conforme al contrato.
- No se ejercitaron los skills de EGM en runtime ni el loop multi-revisor; la verificación cubre instalación, descubrimiento, permisos, delegación real y aislamiento de lectura/escritura.

Fuera de alcance y **no** ejecutado: auditoría semántica H03, drift report, GF-01–GF-08, correctivos U02/U03/U04, rediseño de Owner, commit y push.
