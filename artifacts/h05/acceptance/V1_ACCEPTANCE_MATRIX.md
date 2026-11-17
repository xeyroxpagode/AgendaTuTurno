# V1 — Matriz de aceptación F01–F46 (evaluación inicial honesta)

Fuente: `H05_ADVERSARIAL_QA_MATRIX.md` extraído del ZIP normativo. Las garantías
son resúmenes fieles del texto original. El estado inicial es **provisional**:
se actualizará con la ejecución real de V3–V5.

Estados: `PASS_VERIFIED`, `FAIL_CONFIRMED`, `PARTIAL_COVERAGE`, `NOT_EXECUTED`,
`BLOCKED_ENVIRONMENT`, `INVALID_TEST`.

| F-ID | Garantía original | Test F01 existente | Estado inicial | Brecha detectada |
|---|---|---|---|---|
| F01 | Sólo servicios realizados; precio snapshot | `sales.spec.ts` | PARTIAL_COVERAGE | Reejecutar y verificar snapshot contra attended services |
| F02 | No cobrar servicios reservados no realizados | `sales.spec.ts` | PARTIAL_COVERAGE | El test verifica total pero no la exclusión explícita de servicios no performed |
| F03 | Walk-in legítima sin reserva ficticia | `sales.spec.ts` | PARTIAL_COVERAGE | Verifica conteo global de reservations/clients, no ausencia de vínculo de esa venta |
| F04 | Una Sale causal por intento válido | `sales.spec.ts` | PARTIAL_COVERAGE | Verifica replay; agregar contenido distinto → IDEMPOTENCY_CONFLICT |
| F05 | Sin Order ficticio, salida física H04 | `sales.spec.ts` | PARTIAL_COVERAGE | No comprueba InventoryMovement; la salida se demuestra en `checkout.spec.ts` |
| F06 | Total y efectos físicos correctos | `sales.spec.ts` | PARTIAL_COVERAGE | Verifica total; no verifica efectos físicos en el mismo test |
| F07 | Rechazo de descuento no autorizado | `sales.spec.ts` | PARTIAL_COVERAGE | Cubre capability y excedente; reforzar aserción de ausencia de venta |
| F08 | CashMovement correcto, sin duplicados | `money.spec.ts` | PARTIAL_COVERAGE | Agregar doble replay y conteo exacto de movimientos |
| F09 | Neto coincide con aplicado, no Refund | `money.spec.ts` | PARTIAL_COVERAGE | Verifica neto; no verifica ausencia de refund |
| F10 | Transferencia acreditada sin caja física | `money.spec.ts` | FAIL_CONFIRMED (ACC-01) | Falta evidencia obligatoria de acreditación |
| F11 | Transferencia no acreditada: sin falso cobro | `money.spec.ts` | PARTIAL_COVERAGE | Cubierto; reforzar con doble consulta y sin allocation |
| F12 | Referencia y evidencia, sin almacenar tarjetas | `money.spec.ts` | FAIL_CONFIRMED (ACC-01) | Tarjeta CONFIRMED por defecto, reference/evidence opcionales |
| F13 | Recuperación por mismo intento, sin doble ingreso | `money.spec.ts` | PARTIAL_COVERAGE | Resolución manual probada; falta caída real de proceso |
| F14 | Dos+ componentes, saldo exacto, sólo efectivo a caja | `money.spec.ts` | PARTIAL_COVERAGE | Verifica desglose; no comprueba tipos de CashMovement por medio |
| F15 | Abierto en resolución, no checkout fiado | `money.spec.ts` | PARTIAL_COVERAGE | Verifica PARTIAL; no verifica ausencia de crédito/fiado |
| F16 | Una recepción, dos momentos trazables | `money.spec.ts` | PARTIAL_COVERAGE | Verifica que no se crea money extra; reforzar trazabilidad |
| F17 | Idempotencia y serialization | `money.spec.ts` | PARTIAL_COVERAGE | `Promise.allSettled` sin barrera de sincronización |
| F18 | Hecho nuevo, límite y autorización | `money.spec.ts` | PARTIAL_COVERAGE | Cubierto; agregar refunds concurrentes sobre remanente |
| F19 | Egreso actual, snapshot anterior intacto | `money.spec.ts` | PARTIAL_COVERAGE | Verifica caja cerrada; reforzar inmutabilidad del snapshot exacto |
| F20 | Una sesión ordinaria por caja | `cash.spec.ts` | PARTIAL_COVERAGE | Cubierto; verificar cashbox identity persistida |
| F21 | Actor correcto y expected consistente | `cash.spec.ts` | PARTIAL_COVERAGE | Cubierto; verificar expected tras ambos movimientos |
| F22 | Conteo cero válido | `cash.spec.ts` | PARTIAL_COVERAGE | Revisar versión final del test y snapshot/diferencia |
| F23 | Detecta stale; exige revalidar | `cash.spec.ts` | PARTIAL_COVERAGE | Cubierto con revision 999; verificar dato real modificado |
| F24 | Un cierre | `cash.spec.ts` | PARTIAL_COVERAGE | Verificar un solo snapshot y un solo ganador |
| F25 | Snapshot esperado/contado/diferencia/actor | `cash.spec.ts` | PARTIAL_COVERAGE | Verificar contenido del snapshot JSONB |
| F26 | Bloqueado o protocolo seguro fundamentado | `cash.spec.ts` | PARTIAL_COVERAGE | Cubierto; verificar que no se degradó a FAILED |
| F27 | Caja sigue abierta tras logout | `cash.spec.ts` | PARTIAL_COVERAGE | Se revocó sesión por SQL, no logout real de la app |
| F28 | Unknown != 0 ni settled | `obligations.spec.ts` | PARTIAL_COVERAGE | Cubierto; verificar trigger与 amount NULL |
| F29 | Saldo residual; sin doble aplicación | `obligations.spec.ts` | PARTIAL_COVERAGE | Cubierto; agregar dos pagos concurrentes |
| F30 | Hecho físico separado del pago | `obligations.spec.ts` | PARTIAL_COVERAGE | Cubierto; reforzar ausencia de payment link |
| F31 | No entrega falsa ni venta obligatoriamente settled | `checkout.spec.ts` | PARTIAL_COVERAGE | Verifica rechazo sin cobrar; agregar aserción de saldo no SETTLED |
| F32 | Sin doble entrega y recuperación | `checkout.spec.ts` | PARTIAL_COVERAGE | Concurrencia sin barrera; agregar sincronización |
| F33 | Incidencia sin borrar dinero | `checkout.spec.ts` | PARTIAL_COVERAGE | Cubierto; verificar auditoría de incidencia |
| F34 | Server side bloquea revocación | `checkout.spec.ts` | PARTIAL_COVERAGE | Cubierto; verificar ausencia de efectos |
| F35 | BARBER rechazo inequívoco | `cash.spec.ts` | PARTIAL_COVERAGE | Cubierto; verificar ausencia de movimientos |
| F36 | RECEPTIONIST refund sin grant rechazado | `money.spec.ts` | PARTIAL_COVERAGE | Cubierto; verificar ausencia de refund |
| F37 | Venta legítima sí, pérdida arbitraria no | `checkout.spec.ts` | PARTIAL_COVERAGE | Faltan intentos explícitos de ajuste/pérdida/consumo arbitrario |
| F38 | Aislamiento total | `checkout.spec.ts` + `qa.spec.ts` | PARTIAL_COVERAGE | Cubierto; ampliar a todas las tablas H05 |
| F39 | Histórico se conserva | `sales.spec.ts` | PARTIAL_COVERAGE | Cubierto; verificar líneas superadas y before/after |
| F40 | Estado recuperable tras reinicio | `money.spec.ts` + `qa.spec.ts` | NOT_EXECUTED | No hay interrupción real de proceso |
| F41 | No exceder aplicación ni crear propina | `money.spec.ts` | PARTIAL_COVERAGE | Verifica excedente; no verifica ausencia de tip |
| F42 | Recorridos accionables, accesibilidad, sin éxito ficticio | `finance.spec.ts` | PARTIAL_COVERAGE | 18 ejecuciones = 6 escenarios × 3 viewports, todos Owner |
| F43 | Base QA aislada íntegra | `qa.spec.ts` | PARTIAL_COVERAGE | Verificar constraints e integridad referencial完 |
| F44 | Sin roturas H01–H04 | suites H01–H04 | PARTIAL_COVERAGE | Reejecutar sobre código final |
| F45 | No logs de tokens/PAN/secrets | `qa.spec.ts` | PARTIAL_COVERAGE | No hay escaneo de logs/config de redacción |
| F46 | Atomicidad DB y reconciliación externa | `checkout.spec.ts` | PARTIAL_COVERAGE | Sólo concurrencia de stock; falta fault injection |

## Hallazgos P0 confirmados por inspección de código

- **ACC-01**: `cardComponentSchema.outcome` tiene default `CONFIRMED` y no exige
  `reference` ni `evidenceReference`. Una solicitud sin evidencia produce dinero
  confirmado, allocation y, si aplica, CashMovement. Contradice B-DEC-03 y F12.
- **ACC-01b**: `transferComponentSchema.accredited=true` exige `reference` pero
  no `evidenceReference`; una declaración del cliente podría acreditar fondos.

## Hallazgos P1 (cobertura no demostrada)

- ACC-02 (F40 sin reinicio real), ACC-03 (F37 negativos incompletos),
  ACC-04 (F46 sin fault injection), ACC-05 (E2E sin Receptionist),
  ACC-09 (S33 con sessionStorage en lugar de incertidumbre real),
  ACC-07 (aviso Next.js sin investigación).

La matriz se actualizará con resultados reales en V3–V5.
