# BROWSER ACCEPTANCE — recorridos reales

Aplicación Next.js 16.4.5 + API Fastify + PostgreSQL QA aislado. Navegador real
via Playwright. Viewports: 390, 410 y 1440 px. Sin mocks de backend en los
caminos críticos.

## Identidades QA creadas

| Rol | Capacidades relevantes | Uso |
|---|---|---|
| OWNER | Todas (base) | Configuración de caja/stock, resolución, overpay |
| RECEPTIONIST | Ordinarias: `sales.*`, `money.create`, `cash.*`, `checkout.*` | Venta, cobro, checkout, caja; sin refund/descuento/corrección sensible |
| BARBER | Sin capacidades financieras | Verificar denegación de menú y API |
| Sesión revocada | OWNER con `iam.access_sessions.revoked_at` | Verificar bloqueo server-side |

## Recorridos Owner (spec `finance.spec.ts`)

1. Navegación a las seis superficies H05 con enlaces gated por capability.
2. Caja: sesión real con fondo, snapshot y estado OPEN.
3. Axe: 0 violaciones en el workspace financiero.
4. Responsive 390/410/1440 sin desbordamiento horizontal.
5. S33: consulta del intento original sin duplicar MoneyOperation.
6. Interrupción de red simulada en la creación de caja → estado `error`, NUNCA
   "confirmada" (sin éxito ficticio).

## Recorridos Receptionist (spec `roles-and-s33.spec.ts`)

1. Menú: ve Caja/Ventas/Cobro; NO ve Obligaciones/Correcciones.
2. Crea venta desde UI con SKU real y verifica persistencia.
3. Ejecuta checkout con efectivo desde UI, con caja abierta real; verifica
   `DELIVERED` y auditoría del actor real.
4. Intento de refund con token de Receptionist → 403 del backend.
5. Caja visible y operable en la misma sesión.

## S33 real (spec `roles-and-s33.spec.ts`)

1. Se crea una venta real por API y se ejecuta checkout desde la UI con
   tarjeta `UNKNOWN` → estado `unknown` en la barra de estado.
2. El botón "Consultar intento original" navega a `/cobro-incierto` y conserva
   el `operation_id`.
3. Consulta del intento: tarjeta con "Desconocido — revisar";状态 durable
   `UNKNOWN`, `completedAt=null`.
4. `page.reload()`: el intento sigue accesible y la navegación no se pierde.
5. Conteo de `money_operations` antes/después: exactamente +1. Consultar el
   intento NO cobra dos veces.

## Otros recorridos

- Logout real desde la UI: redirección a `/login` y la caja permanece OPEN.
- BARBER: sin enlaces financieros; POST `/v1/cash/sessions` → 403.
- Sesión revocada:同一 token deja de autorizar POST `/v1/sales` (401/403).

## Evidencia visual

Capturas en `artifacts/h05/acceptance/`:
`{mobile-390,small-410,desktop-1440}-caja.png`,
`{...}-s33.png`, `{...}-reception-caja.png`, `{...}-s33-real.png`.

Resultado agregado: **33 ejecuciones Playwright PASS** (11 escenarios × 3
viewports). No se cuentan como 33 recorridos funcionales distintos: son 11
recorridos repetidos en 3 anchos.
