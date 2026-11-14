# 17 — PUBLIC BOOKING UX (G17)

**Estado:** PARTIAL (UI real contra API real, no mocks; funcional mínimo)

`apps/web/src/app/(public)/reservar/page.tsx`: flujo continuo en cuatro regiones (Servicios, Profesional ANY/SPECIFIC, Fecha y horario con disponibilidad U03, Datos y confirmación). Invalida slot/cotización al cambiar selección; estados loading/error/success; confirmación respaldada por COMMIT; reconcile para recuperar token. Responsive básico (mobile-first, flex). Accesibilidad parcial (labels, teclado nativo).

Limitación: catálogo de servicios se carga desde endpoint público inexistente (placeholder); el usuario debe proveer service UUIDs o integrar catálogo público. Sin wizard de 5 páginas. No se declaran capturas inventadas.
