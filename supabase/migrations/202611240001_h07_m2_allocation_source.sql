-- WP-04 / M2 — Extensión del enum de ocupación canónica.
--
-- PostgreSQL 55P04: ALTER TYPE ... ADD VALUE NO PUEDE usarse en la misma
-- transacción que la primera lectura/escritura del valor nuevo. El runner
-- aplica cada archivo en una transacción propia; por eso ESTE archivo sólo
-- agrega el valor y NO lo utiliza. M2b y M3/M4 lo consumen después.
--
-- El enum es ADITIVO y no se revierte (PostgreSQL no soporta DROP VALUE).
alter type availability.allocation_source add value if not exists 'COURSE_SESSION';
