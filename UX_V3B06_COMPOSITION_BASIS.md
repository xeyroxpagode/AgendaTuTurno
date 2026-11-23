# UX V3-B06 — BASE DE COMPOSICIÓN (NO ES UN FREEZE)

**Etapa:** F01 / WP-7 / D01-T071 (raíz del grafo UX ajustado)
**Fecha:** 2026-11-19
**Estado:** BASE DE IMPLEMENTACIÓN — **PENDIENTE DE APROBACIÓN DE ACTOR A EN G0b**

> Este documento **no** declara `UX_FAMILY_FREEZE_PASS`. Es la base normativa
> de implementación y la escalación concreta para G0b (`REQUIRED_FOR_G01`).
> G0b **no bloquea** backend, migraciones, dominio, API ni QA no visual.

---

## 1. Fuentes aprobadas y brecha detectada

| Fuente | Uso |
|---|---|
| `artifacts/h04/sources/product/05_FUENTES/UX/00_CLIENT_EXPERIENCE_MASTER_V1_0.md` (§V3-B06, líneas ~351 y ~363) | Composición normativa B01-03. Establece «no crear un wizard nuevo ni una pestaña extra». |
| `YOUNGKINGZ_GLOBAL_PRODUCT_FREEZE V1.0.md` (B06, C08, D07) | Matriz de autoridad, estados y reglas de retiro. |
| Contrato F01 §27 y C01 §17 | Secuencia `T071 → {T061,T064} → T070 → {T065..T069} → T087`. |

**Brecha V3-B06:** la demo histórica cubre sólo `REQUESTED / READY / CANCELLED`.
El comportamiento congelado exige siete estados: faltan `CONFIRMED`,
`PREPARING`, `DELIVERED` y `REJECTED`. Se documenta además
`SHARED_DESIGN_SYSTEM_NOT_FROZEN` y `DESIGN_TARGET_NOT_SELECTED` como deuda
consciente, sin inventar una aprobación inexistente.

## 2. Composición normativa de implementación

- Pedidos **bajo Inventario** en superficie Staff: una opción `PEDIDOS` dentro
  del Workspace existente, **sin sexta pestaña, sin root nuevo y sin centro
  de avisos**. El catálogo público permanece en el sitio público.
- Una **CTA principal por estado**, derivada de `(status, role, capabilities)`
  en el componente compartido `OrderPrimaryAction`.
- El `status` comercial y el **estado de operación UX** son conceptos
  separados: loading / empty / error / UNKNOWN / recuperación por
  `operationId` se representan como estados de interfaz, nunca como
  `order.status`. `orderStatusSchema` no incluye `UNKNOWN`.
- Sin exposición de capacidades H05 al cliente: el frontend no conoce
  `reuseCommitments` ni `sourceReference`; envía sólo `operationId` y datos
  permitidos por el contrato Zod.
- Accesibilidad y responsive: 390 / 410 / 1440 (y 320 / 430), teclado, foco
  visible, `aria-live`, `tabular-nums` para importes y `reduced-motion`.

## 3. Los siete estados y su CTA

| Estado | Significado real | CTA principal | Restricción |
|---|---|---|---|
| `REQUESTED` | Resultado de `order.create` (no «pendiente de pago», no confirmación parcial) | Staff: **Confirmar** · Cliente: **Ver solicitud** | Sin stock comprometido; sin Sale |
| `CONFIRMED` | Resultado atómico de Q13 en `order.confirm` | **Iniciar preparación** | Conjunto completo de compromisos ACTIVOS |
| `PREPARING` | Checklist interno, sin movimiento físico | **Marcar listo** | 0 movimientos de inventario |
| `READY` | Conjunto verificado, listo para retiro | **Registrar retiro** | Sin TTL; sin entrega parcial |
| `DELIVERED` | Sale + Money + ENTREGA_FISICA + receptor acreditado | **Ver comprobante** | Terminal e inmutable |
| `REJECTED` | Sólo Staff con `orders.reject` y motivo desde `REQUESTED` | **Ver motivo** | Nunca automático por fallo de línea N |
| `CANCELLED` | Cancelación atómica por fase | **Ver detalle** | Terminal; sin parcial |

## 4. Puntos exactos para revisión de Actor A en G0b

1. Composición visual de `CONFIRMED`, `PREPARING`, `DELIVERED` y `REJECTED`
   (los cuatro estados que faltaban en la demo V3-B06).
2. Confirmación de **ausencia de sexta pestaña** y de root nuevo para pedidos.
3. Confirmación de **no exposición de capacidades H05** al cliente.
4. Confirmación de que `REQUESTED` se presenta como solicitud confirmada y
   `CONFIRMED` como resultado atómico de Q13 (no como «pendiente de pago»).

## 5. Trazación de secuencia (grafo ajustado)

`T071` (este artefacto) → `T061` (catálogo público) y `T064` (anclaje bajo
Inventario) → `T070` (componentes compartidos) → `T065..T069` (recorridos
completos Cliente, Recepción y Owner) → `T087` (QA visual con Playwright).

Véase `F01_DEPENDENCY_GRAPH_ADJUSTED.md`: 91 tareas, 195 aristas, 0 ciclos.

---

**Veredicto:** `PENDING_G0b`. No se declara aceptación visual definitiva en F01.
