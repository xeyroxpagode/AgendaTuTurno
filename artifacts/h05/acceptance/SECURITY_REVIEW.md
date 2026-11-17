# SECURITY REVIEW — H05 post-correctivo

## IAM y autoridad efectiva

- `AuthorizationService.authenticate` construye el `Actor` desde bearer + sesión
  operativa real; business scoping, multirol y revocación se revalidan contra
  PostgreSQL. `assertActorStillAuthorized()` se usa dentro de la transacción en
  Money y Checkout (incluido `resumeCheckout`, corrección de ACC-03).
- `inventory.operate` sigue siendo capability base de OWNER/RECEPTIONIST y NO
  está en `grantableCapabilitiesByRole`. No se concedió como grant.
- `f37-authority.spec.ts` ejecuta 1 positivo con operador sin
  `inventory.operate`/`inventory.adjust` y 6 negativas reales: pérdida, ajuste,
  recepción, corrección física, consumo sin causa y autoridad falsificada/ajena/
  reutilizada. Se comprueba error Y ausencia de movimientos indebidos.
- Actor revocado: `roles-and-s33.spec.ts` demuestra que el mismo token deja de
  autorizar escrituras; `f37-authority.spec.ts` demuestra que un resume con
  sesión revocada no escribe ni entrega.

## Money / Recovery

- ACC-01: tarjeta CONFIRMED exige referencia operativa y evidencia; el default
  es UNKNOWN. Transferencia acreditada exige referencia y evidencia. Doble capa
  (Zod + `assertExternalEvidence`). PAN/CVV rechazados por esquema estricto.
- Dinero confirmado = suma exacta de componentes CONFIRMED. No se crea dinero
  al asignar anticipos, ni al resolver un intento (la resolución confirma un
  componente ya declarado y registra auditoría).
- Refund: hecho nuevo, límite de remanente, concurrencia serializada y caja
  histórica inmutable (F18/F19/F46).
- UNKNOWN: persistente, consultable por `operation_id`, resuelto sólo con
  evidencia y `operations.resolve`; NUNCA por timeout. `crash-recovery.spec.ts`
  demuestra supervivencia a `SIGKILL` y reconciliación en proceso nuevo.

## Checkout / H04

- Frontera interna `checkoutAuth` revalidada dentro de la Tx: checkout existente,
  mismo business, misma referencia causal, líneas de venta coincidentes y
  sesión activa. No hay `backendPrincipal`, `systemActor`, `skipAuthorization`
  ni endpoint público de commit/deliver.
- NEW-01: la entrega exige cobertura monetaria confirmada. Un cobro UNKNOWN ya
  no produce `DELIVERED` con `confirmed_minor=0`.
- H04 conserva ownership y validación IAM por defecto: 400/400 regresiones
  H01–H04 pasan con el código modificado.

## Persistencia y secretos

- 13 tablas H05 con `business_id`, FKs compuestas y triggers de inmutabilidad.
- Cross-business: FK compuesta rechaza IDs ajenos (23503) además del filtro por
  `actor.businessId`.
- `app.ts` redacta `authorization`, cookies, `x-guest-token`, contraseñas,
  códigos y tokens en el logger. Los errores de dominio no incluyen secretos
  (F45) y la request con PAN es rechazada antes de persistir.

## Dependencias / Next.js (ACC-07)

- Versión inicial: 16.4.3. `pnpm audit` informó `next` moderate con parche
  ≥16.4.5. Fuentes oficiales consultadas: GitHub Advisory
  GHSA-673q-mjm6-r5xr (octubre, parcheado en 16.4.1) y blog oficial de Next.js
  "November 2026 Security Release" (3 nov, 16.4.5 / 15.5.29). Los siete avisos
  de noviembre cubren hasta 16.4.4, por lo que 16.4.3 estaba dentro del rango
  afectado.
- Acción: upgrade controlado a `next@16.4.5` en `apps/web` y lockfile. No se
  actualizaron otras dependencias de forma indiscriminada.
- Verificación: typecheck, lint, build y 33 E2E en verde tras el upgrade.
- `pnpm audit` ya no reporta avisos para `next`. Quedan avisos `dev-only`
  (vite/glob/minimatch/source-map-js) que no forman parte del runtime de la
  aplicación; se registran como riesgo residual menor, no como BLOCKER.

## Riesgo residual

No hay vulnerabilidad crítica o alta explotable conocida sin mitigar en el
runtime H05. Los avisos dev-only quedan documentados para su tratamiento en el
ciclo normal de mantenimiento de dependencias, fuera del alcance H05.
