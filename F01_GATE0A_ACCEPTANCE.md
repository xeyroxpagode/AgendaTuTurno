# F01 — GATE CERO / G0a ACCEPTANCE

**Etapa:** F01 — Implementación integral de H06 (Pedidos de productos para retiro)
**Proyecto:** AgendaTuTurno
**Registro:** Aceptación de autorización expresa de Actor A para iniciar escrituras (G0a)
**Fecha de registro:** 2026-11-19

---

## 1. Autorización literal de Actor A

Extraída del handoff `AGENDATUTURNO — H06 / F01 — HANDOFF GLOBAL DE IMPLEMENTACIÓN`,
sección 1 «AUTORIZACIÓN EXPRESA» y sección 10 «ORDEN FINAL»:

> «Como Actor A, **AUTORIZO EL INICIO DE F01 — IMPLEMENTACIÓN INTEGRAL DE H06**, bajo el contrato maestro producido y reconciliado en E01 y las precisiones de este handoff.»

> «**ACTOR A AUTORIZA F01 BAJO LOS LÍMITES ANTERIORES.**»

> «Leé el contrato maestro F01, el prompt autónomo original y las correcciones de E01. Ejecutá el Gate Cero. Registrá G0a. Si el entorno es seguro, **comenzá la implementación integral de H06**.»

**Validez:** Esta autorización satisface G0a siempre que el Gate Cero técnico confirme entorno seguro (contrato F01 §2).

---

## 2. Gate Cero técnico (read-only, ejecutado antes de cualquier escritura)

Comandos ejecutados en `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation`:

| Verificación | Resultado | Esperado | Estado |
|---|---|---|---|
| `git rev-parse --show-toplevel` | `C:/Users/thega/Desktop/YoungKingZ-U03-Implementation` | workspace indicado | OK |
| `git branch --show-current` | `feature/h05-global-implementation` | `feature/h05-global-implementation` | OK |
| `git rev-parse HEAD` | `116148f2279fc092cbec3eede7c66144ee4d730f` | `116148f...` | OK |
| `git remote -v` | `origin https://github.com/xeyroxpagode/YoungKingzBarber.git` (fetch/push) | URL histórica permitida (CF-10) | OK |
| `git stash list` | `stash@{0}: On feature/h03-u03-implementation: u05-wip-temp` | intacto | OK |

**Conclusión Gate Cero:** entorno seguro. Root, rama, HEAD y remote coinciden con el baseline del contrato F01 §1.

---

## 3. Cambios preexistentes preservados (no restaurar / no eliminar / no stagear masivamente)

Registrados en `git status --short` al inicio:

- `?? CLOUD_A01_CORRECTIVE_REPORT.md`
- `?? CLOUD_CURRENT_AUDIT.md`
- `?? PROMPT_CLOUD_CURRENT_AUDIT.md`
- `?? artifacts/h04.rar`
- `?? artifacts/h04/`
- `?? "tone and final browser acceptance\357\200\242qq"`
- `stash@{0}: On feature/h03-u03-implementation: u05-wip-temp`

Nota: `apps/web/next-env.d.ts` figuraba como `M` en el Gate Cero original de E01, pero al cierre de E01 coincide byte-a-byte con HEAD (contrato F01 §2). En el Gate Cero actual de F01 **no aparece** en `git status --short`; se verifica de nuevo antes de cualquier escritura que lo toque.

**Regla aplicada:** ninguno de estos elementos será restaurado, eliminado ni stageado masivamente. Se trabaja solo sobre archivos propiedad de H06 y las extensiones autorizadas.

---

## 4. Alcance autorizado por G0a

- Crear y modificar código dentro del alcance H06 aprobado.
- Extensiones mínimas autorizadas a H03, H04 y H05 (T-04/T-05/T-07).
- Crear migraciones M1, M2 y M3; aplicarlas solo en QA aislada con identidad y seguridad verificadas.
- Ejecutar tests, builds, comprobaciones de integración y navegador en entornos controlados.
- Corregir autónomamente defectos dentro del contrato.
- Ejecutar los 10 work packages como etapas internas de una única implementación global.

**NO autorizado:** despliegues en producción, migraciones en bases compartidas, pérdida de datos, cambios de Product Freeze, push automático, commit sin autorización específica posterior, cambios destructivos (`git reset`/`git clean`/checkout destructivo), staging masivo, creación de ramas o worktrees.

---

## 5. Puertas relacionadas

- **G0a (escritura):** REGISTRADA — este documento.
- **G0b (composición visual UX V3-B06):** PENDIENTE — `REQUIRED_FOR_G01`, no bloquea backend, migraciones, dominio, API ni QA no visual. Se producirá `UX_V3B06_COMPOSITION_BASIS.md` para escalación a Actor A.
- **`H06 FUNCTIONAL FROZEN/PASS`:** NO se declara en F01. Veredicto exclusivo de G01.

---

## 6. Estado

**G0a = REGISTRADO / ENTREGO SEGURO.**
Se autoriza el inicio de la implementación integral de H06 bajo los límites del contrato F01 y el handoff de Actor A.
