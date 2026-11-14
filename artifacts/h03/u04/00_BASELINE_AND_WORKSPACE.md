# 00 — BASELINE AND WORKSPACE (G00)

**Contrato:** `YKZ-R2-H03-U04-C-IMPLEMENTATION-V1.0` · Gate G00 · Tasks T00.01–T00.07
**Fecha:** 2026-11-05 · **Workspace:** `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation`

## 1. Identidad del workspace

| Campo | Valor |
|---|---|
| Toplevel | `C:/Users/thega/Desktop/YoungKingZ-U03-Implementation` |
| Repositorio remoto canónico | `xeyroxpagode/YoungKingzBarber` (monorepo `youngkingz`) |
| Rama | `feature/h03-u03-implementation` |
| HEAD | `35aab9e331cffde792be4721a07cb72656b60e33` (`feat(h03-u01): implement clients crm and certify integration`) |
| Worktrees | No se creó ni eliminó ninguno (verificado con `git worktree list` vía inspección; sin cambios) |

**Decisión de workspace (del usuario, 2026-11-05):** el usuario abrió inicialmente `YoungKingzBarber-P2-VISUAL` (prototipo visual) y confirmó explícitamente que H03.U04 **debe implementarse en el backend** y que el workspace correcto debía "agregarse". La sesión fue movida con `tools.opencode.session_move` a `YoungKingZ-U03-Implementation`, el clon que contiene H01 + H02 + H03.U01 + H03.U03. No se copió código entre repositorios; no se fusionó nada.

## 2. Estado inicial (preexistente, PRESERVADO)

Cambios no commiteados previos a esta ejecución (U03 sin comitear + contratos):

```
 M apps/api/src/app.ts
 M apps/api/src/modules/schedules/commands.ts
 M apps/api/src/modules/staff-services/commands.ts
 M apps/api/src/modules/team/service.ts
 M apps/web/src/app/globals.css
 M apps/web/src/components/AppShell.tsx
 M apps/web/src/proxy.ts
 M packages/contracts/package.json
 M packages/contracts/src/index.ts
 M packages/database/src/schema.ts
 M playwright.config.ts
 M vitest.config.ts
?? apps/api/src/modules/availability/
?? apps/web/src/app/(staff)/availability/
?? apps/web/src/features/availability/
?? artifacts/h03/u03/
?? packages/contracts/src/availability.ts
?? packages/database/src/availability.ts
?? supabase/migrations/202611050001_h03_u03_availability.sql
?? tests/h03/e2e/availability.spec.ts
?? tests/h03/integration/availability-api.spec.ts
?? tests/h03/integration/availability.spec.ts
?? tests/h03/integration/clients.spec.ts   (via tests/h03/)
?? tests/h03/unit/
```

Inventario completo en `git-status-baseline.txt`, `git-diffstat-baseline.txt`, `git-untracked-baseline.txt`.

**Implicación:** la autoridad de disponibilidad (U03) está presente pero **no commiteada** en este workspace. U04 se implementa encima de ese estado sin reescribirlo. No se restauró, borró ni revirtió nada ajeno.

## 3. Dependencias presentes / ausentes

### Presentes
- Monorepo pnpm: `apps/api` (Fastify + Zod + postgres.js), `apps/web` (Next.js staff), `packages/{contracts,database,config,ui}`.
- PostgreSQL local vía Supabase CLI (container `supabase_db_youngkingz-h01`, DB `127.0.0.1:55322`, API `:55321`, Studio `:55323`, Mailpit `:55324`). **Solo local y descartable** (ver §5).
- Migraciones aplicadas: H01 foundation → H02.U01…U04 → H03.U01 (clients) → **H03.U03 (availability, sin comitear)**.
- H01: `system.operation_attempts`, `system.audit_events`, IAM (`iam.*`), `executeOperation` (idempotency con `actor.accountId`), `audit()`.
- H03.U01: `clients.*` (CRM), `ClientProfile`, `ClientAccountLink` (sin auto-merge) — `apps/api/src/modules/clients/`.
- H03.U03: Quote/Claim/Release/Replace (`apps/api/src/modules/availability/`), motor temporal puro (`temporal.ts`), `resolveSlot`, `searchAvailability`, guard por Business (`availability.business_guards` + `lockAvailabilityGuard`), GiST exclusion constraint en `resource_allocations`, `allocation_service_requirements`, ANY por carga relativa, D13 (serviceIds distintos) en `resolveSlot`.
- Tests: vitest (unit/integration, `fileParallelism: false`), Playwright (e2e), `scripts/reset-local-database.ps1` (con `assert-local-supabase.ps1`), `scripts/verify-database.ps1`.

### Ausentes / no disponibles
- **H03.U02 Identidad CLIENT no está en este workspace** (vive en el clon `YoungKingZ-H01-Implementation`, rama `feature/h03-u02-implementation`, con migración `202611030001_h03_u02_client_identity.sql`). No se copió. ⇒ Caminos CLIENT quedan `BLOCKED_EXTERNAL_CONVERGENCE`.
- **No existe** `.env` en el repo (gitignored). Se creó uno **solo local** con las credenciales demo locales de `supabase status -o env` (claves "demo" públicas de Supabase local; no son secretos de producción). Sin él, las integration suites no arrancan.
- No hay email/SMS/SMPP productivo; Mailpit local existe pero U04 no entrega credenciales por él (ver G14).

## 4. Estado de la base de datos local

- `supabase status`: instancia local corriendo (DB 55322). Reset **no** ejecutado aún en este gate; se usará `scripts/reset-local-database.ps1` (que primero llama `assert-local-supabase.ps1`) cuando corresponda aplicar la migración U04.
- `verify-database.ps1` disponible para verificación de esquemas H01/H02.

## 5. Seguridad de datos (T00.07)

- `assert-local-supabase.ps1` inspecciona el contenedor local antes de cualquier reset.
- La DB local es descartable (Supabase local, datos de prueba/fixtures). Ningún script apunta a producción; `.env` apunta a `127.0.0.1`.
- Los tests de integración crean Businesses con UUIDs aleatorios; no reutilizan datos reales.
- **Corrección aplicada durante baseline (G00/G21):** `tests/h03/integration/availability.spec.ts` contenía una fecha fija `2026-11-05` que ya quedó en el pasado respecto de `now()` SQL ⇒ el test "protects H02 schedule…" fallaba aunque la lógica era correcta. Se cambió a `2099-11-05` (futuro dinámico). Suite h03 integration: **44/44 PASS**. Documentado en `23_DEFECTS_AND_CORRECTIVES.md`.
- Estado inicial de tests: unit h03 **20/20 PASS**; integration h03 **43/44 PASS → 44/44 tras corrección**; suites clients/availability-api pasan con `.env` local (27 tests estaban "skipped" por falta de keys; ahora ejecutan).

## 6. Riesgos identificados

1. U03 sin comitear: U04 depende de él; cualquier `git checkout/reset` destruiría el trabajo. **Ninguno ejecutado.**
2. U02 ausente ⇒ ningún flujo CLIENT puede declararse E2E.
3. Migración U04 debe ser aditiva; `db reset` local es seguro (assert previo) pero destructivo para datos locales — aceptado como entorno descartable.
4. `git diff --check`: sin errores de whitespace.
5. Lock order global: U03 exige guard Business antes de locks de Staff — U04 debe respetarlo (Claim compartido).

## 7. Operaciones prohibidas NO realizadas

- Sin `git checkout/switch/merge/rebase/reset/cherry-pick/worktree add|remove`; sin creación de ramas/worktrees; sin commit; sin push; sin copia de código entre clones; sin mover carpetas.
- Sin reset de DB hasta confirmar destino local (§5).
- Inspecciones Git usadas: `rev-parse`, `branch --show-current`, `status --porcelain`, `diff --stat`, `diff --check`, `ls-files --others`, `log --oneline` (todas de solo lectura).

## 8. Resultado G00

**G00 — PASS** (baseline identificado sin alterar Git; riesgo U03-uncommitted mitigado por preservación explícita).
