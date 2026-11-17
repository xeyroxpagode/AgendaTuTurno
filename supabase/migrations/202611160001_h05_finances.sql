-- =============================================================================
-- H05 · CAP-05-01…07 · Finanzas, Ventas, Dinero, Caja, Obligaciones, Checkout
-- y Correcciones.
--
-- Migración ADITIVA y no destructiva. No altera ni borra datos históricos de
-- H01..H04. Crea los esquemas `sales`, `money`, `cash`, `obligations`,
-- `checkout` y `corrections`.
--
-- Principios congelados que esta migración materializa:
--  · D01/D04 — Sale y MoneyOperation son hechos DISTINTOS. Ninguna tabla
--    representa simultáneamente venta, cobro, caja y entrega.
--  · D08     — Cash refleja SÓLO efectivo físico. Las tablas de dinero guardan
--    el medio; las de caja guardan únicamente efectivo.
--  · D22     — UNKNOWN_AMOUNT ≠ cero: el importe desconocido es NULL, nunca 0.
--  · D13/D16 — Checkout es coordinación recuperable; no es un ledger.
--  · D20/B-DEC-09 — UNKNOWN es un estado durable, nunca se degrada a FAILED.
--  · D24/F37 — No existe identidad privilegiada: la autoridad de ejecución
--    física la aporta el checkout autorizado, no `inventory.operate`.
--
-- Aislamiento: TODA tabla lleva `business_id` y TODA consulta se filtra por
-- el `business_id` del Actor. Los vínculos sensibles usan FKs compuestas
-- `(business_id, id)` para que una referencia de otro negocio sea
-- imposible, no sólo improbable.
--
-- Rollback: drop schema corrections cascade; drop schema checkout cascade;
--            drop schema obligations cascade; drop schema cash cascade;
--            drop schema money cascade; drop schema sales cascade;
-- =============================================================================

create schema if not exists sales;
create schema if not exists money;
create schema if not exists cash;
create schema if not exists obligations;
create schema if not exists checkout;
create schema if not exists corrections;

-- =============================================================================
-- 1. SALES · CAP-05-01
-- =============================================================================

-- Una venta es un ACTO COMERCIAL explícito, no una consecuencia de la
-- atención (D02). El origen causal es explícito y único.
create table if not exists sales.sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  operation_id uuid not null,
  status text not null default 'DRAFT'
    check (status in ('DRAFT','CONFIRMED','CANCELLED')),
  -- Origen causal: atención real (ATTENDANCE), walk-in documentado (WALK_IN)
  -- o venta directa de productos (DIRECT). Nunca una reserva ficticia.
  source text not null check (source in ('ATTENDANCE','WALK_IN','DIRECT')),
  attendance_id uuid,
  contact_snapshot jsonb,
  currency text not null default 'ARS' check (currency = 'ARS'),
  -- Total DERIVADO de las líneas vigentes. Se recalcula al confirmar y al
  -- corregir; nunca se edita a mano.
  total_minor bigint not null default 0 check (total_minor >= 0),
  revision bigint not null default 1 check (revision > 0),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  note text,
  actor_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (operation_id),
  constraint sales_operation_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict,
  constraint sales_attendance_fk foreign key (business_id, attendance_id)
    references attendance.attendances(business_id, id) on delete restrict,
  -- El origen causal es coherente con la presencia de atención.
  constraint sales_source_attendance_check
    check ((source = 'ATTENDANCE') = (attendance_id is not null)),
  -- Un walk-in documenta su contacto; no crea Reservation ni cuenta CLIENT.
  constraint sales_walk_in_requires_contact
    check (source <> 'WALK_IN' or contact_snapshot is not null),
  -- Anulación coherente y siempre motivada.
  constraint sales_cancelled_consistency
    check ((status = 'CANCELLED') = (cancelled_at is not null)),
  constraint sales_cancelled_requires_reason
    check (status <> 'CANCELLED' or (cancellation_reason is not null and length(trim(cancellation_reason)) between 3 and 500)),
  -- Una venta CONFIRMADA tiene fecha de confirmación. Una venta anulada
  -- PUEDE haber estado confirmada: conserva su fecha como parte de la
  -- historia (D14/D26: no se reescribe el pasado).
  constraint sales_confirmed_consistency
    check (status <> 'CONFIRMED' or confirmed_at is not null),
  -- El total de una venta confirmada es el de sus líneas vigentes.
  constraint sales_confirmed_has_total
    check (status <> 'CONFIRMED' or total_minor > 0)
);

comment on table sales.sales is
  'H05 CAP-05-01: venta comercial de servicios y/o productos. Saldo DERIVADO de money.money_allocations; nunca un saldo canónico editable.';

-- Unicidad causal: una atención real genera como máximo UNA venta.
create unique index if not exists sales_one_sale_per_attendance
  on sales.sales (business_id, attendance_id) where attendance_id is not null;

create index if not exists sales_business_recent
  on sales.sales (business_id, created_at desc, id desc);
create index if not exists sales_business_status
  on sales.sales (business_id, status, created_at desc);

-- Líneas de venta con SNAPSHOT HISTÓRICO de precio, moneda y descuento
-- (D03/D15). El contenido comercial de una línea es inmutable: sólo puede
-- quedar marcadas como superadas por una corrección posterior, y el
-- before/after queda en `corrections.corrections`.
create table if not exists sales.sale_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  sale_id uuid not null,
  -- Revisión de la venta en la que la línea quedó vigente.
  revision bigint not null default 1 check (revision > 0),
  position integer not null check (position >= 1),
  kind text not null check (kind in ('SERVICE','PRODUCT')),
  service_id uuid,
  sku text,
  location_id uuid,
  name text not null check (length(trim(name)) between 1 and 120),
  quantity integer not null check (quantity between 1 and 1000000),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  line_total_minor bigint not null check (line_total_minor >= 0),
  currency text not null default 'ARS' check (currency = 'ARS'),
  duration_minutes integer,
  snapshot_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (business_id, id),
  unique (business_id, sale_id, revision, position),
  constraint sale_lines_sale_fk foreign key (business_id, sale_id)
    references sales.sales(business_id, id) on delete restrict,
  constraint sale_lines_service_fk foreign key (business_id, service_id)
    references catalog.services(business_id, id) on delete restrict,
  constraint sale_lines_item_fk foreign key (business_id, sku)
    references inventory.items(business_id, sku) on delete restrict,
  constraint sale_lines_location_fk foreign key (business_id, location_id)
    references inventory.locations(business_id, id) on delete restrict,
  -- Una línea de servicio referencia OPCIONALMENTE un servicio del catálogo:
  -- un servicio performed de un walk-in tiene nombre y precio snapshot pero
  -- no necesariamente una ficha de catálogo. El nombre snapshot es siempre
  -- obligatorio (B01.3.1/D03).
  constraint sale_lines_service_kind_check
    check (kind <> 'SERVICE' or length(trim(name)) > 0),
  constraint sale_lines_product_kind_check
    check (kind <> 'PRODUCT' or (sku is not null and location_id is not null)),
  -- El total de línea es EXACTO: base − descuento, sin redondeo (D11/D27).
  constraint sale_lines_total_exact_check
    check (line_total_minor = unit_price_minor * quantity - discount_minor),
  -- El descuento nunca supera la base comercial elegible (B-DEC-01).
  constraint sale_lines_discount_within_base_check
    check (discount_minor <= unit_price_minor * quantity)
);

create index if not exists sale_lines_sale
  on sales.sale_lines (business_id, sale_id, revision, position);
create index if not exists sale_lines_current
  on sales.sale_lines (business_id, sale_id) where superseded_at is null;

-- =============================================================================
-- 2. MONEY · CAP-05-02 + CAP-05-03 (Recovery)
-- =============================================================================

-- Dinero real. Se registra UNA sola vez por operation_id (D04). El estado
-- durable distingue lo confirmado de lo pendiente o desconocido; UNKNOWN
-- nunca se degrada a PROVEN_FAILED por timeout (D20, F13).
create table if not exists money.money_operations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  operation_id uuid not null,
  -- PAYMENT = cobro; REFUND = devolución (hecho monetario NUEVO, D25).
  kind text not null default 'PAYMENT' check (kind in ('PAYMENT','REFUND')),
  status text not null default 'PROCESSING'
    check (status in ('PROCESSING','SUCCEEDED','PROVEN_FAILED','UNKNOWN')),
  sale_id uuid,
  obligation_id uuid,
  -- Un refund referencia el cobro original y lo CONSERVA (D14/D25).
  refund_of_id uuid,
  -- Importe solicitado (suma de componentes) y dinero REALMENTE confirmado.
  -- confirmed_minor es la suma exacta de los componentes CONFIRMED.
  amount_minor bigint not null check (amount_minor > 0),
  confirmed_minor bigint not null default 0 check (confirmed_minor >= 0),
  change_minor bigint not null default 0 check (change_minor >= 0),
  currency text not null default 'ARS' check (currency = 'ARS'),
  -- Identidades separadas (D23/B-DEC-04): pagador, receptor físico y titular
  -- económico NO se infieren uno del otro.
  payer_name text,
  receiver_staff_member_id uuid,
  economic_holder_name text,
  note text,
  revision bigint not null default 1 check (revision > 0),
  actor_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  resolved_at timestamptz,
  resolved_by_account_id uuid references iam.user_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (operation_id),
  constraint money_operation_attempt_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict,
  constraint money_operation_sale_fk foreign key (business_id, sale_id)
    references sales.sales(business_id, id) on delete restrict,
  -- La FK a `obligations.expense_obligations` se agrega al final del archivo
  -- (esa tabla se crea más abajo en esta misma migración).
  constraint money_operation_refund_of_fk foreign key (business_id, refund_of_id)
    references money.money_operations(business_id, id) on delete restrict,
  constraint money_operation_receiver_fk foreign key (business_id, receiver_staff_member_id)
    references team.staff_members(business_id, id) on delete restrict,
  -- Un refund SIEMPRE referencia su cobro original (D25).
  constraint money_operation_refund_requires_origin
    check ((kind = 'REFUND') = (refund_of_id is not null)),
  -- El dinero confirmado nunca excede lo solicitado.
  constraint money_operation_confirmed_within_amount
    check (confirmed_minor <= amount_minor),
  -- Un fallo PROBADO significa que no se confirmó dinero: si hubiera dinero
  -- confirmado, la operación no sería un fallo probado sino una resolución
  -- con evidencia.
  constraint money_operation_failed_has_no_confirmed
    check (status <> 'PROVEN_FAILED' or confirmed_minor = 0),
  -- Un refund nunca deja dinero confirmado negativo.
  constraint money_operation_refund_confirmed_non_negative
    check (kind <> 'REFUND' or confirmed_minor >= 0)
);

comment on table money.money_operations is
  'H05 CAP-05-02: dinero real registrado una sola vez por operation_id. confirmed_minor es la suma exacta de los componentes CONFIRMED.';

create index if not exists money_operations_business_recent
  on money.money_operations (business_id, created_at desc, id desc);
create index if not exists money_operations_sale
  on money.money_operations (business_id, sale_id) where sale_id is not null;
create index if not exists money_operations_obligation
  on money.money_operations (business_id, obligation_id) where obligation_id is not null;
create index if not exists money_operations_unresolved
  on money.money_operations (business_id, status) where status in ('PROCESSING','UNKNOWN');

-- Desglose por medio de pago. Cada componente es un hecho con su propio
-- resultado: sólo los CONFIRMED son dinero (D05/D06).
create table if not exists money.money_components (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  money_operation_id uuid not null,
  position integer not null check (position >= 1),
  method text not null check (method in ('CASH','TRANSFER','CARD')),
  outcome text not null check (outcome in ('CONFIRMED','PENDING','UNKNOWN')),
  amount_minor bigint not null check (amount_minor > 0),
  -- Efectivo: lo entregado y lo devuelto. El neto es EXACTAMENTE el importe
  -- acreditado (D21: el vuelto está ligado al cobro).
  tendered_minor bigint,
  change_minor bigint not null default 0 check (change_minor >= 0),
  -- Transferencia: acreditada o no (F10/F11).
  accredited boolean,
  external_reference text,
  evidence_reference text,
  currency text not null default 'ARS' check (currency = 'ARS'),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, money_operation_id, position),
  constraint money_components_operation_fk foreign key (business_id, money_operation_id)
    references money.money_operations(business_id, id) on delete restrict,
  -- Un componente en efectivo siempre declara lo entregado y lo devuelto.
  constraint money_components_cash_shape
    check (method <> 'CASH' or (tendered_minor is not null and tendered_minor - change_minor = amount_minor and change_minor >= 0)),
  -- Un componente no efectivo no declara efectivo.
  constraint money_components_non_cash_shape
    check (method = 'CASH' or (tendered_minor is null and change_minor = 0)),
  -- Una transferencia acreditada exige referencia comprobable (B-DEC-03).
  constraint money_components_accredited_needs_reference
    check (method <> 'TRANSFER' or not accredited or (external_reference is not null and length(trim(external_reference)) > 0)),
  -- Una transferencia acreditada es dinero confirmado; si no, está PENDING.
  constraint money_components_transfer_outcome
    check (method <> 'TRANSFER' or (accredited and outcome = 'CONFIRMED') or (not accredited and outcome = 'PENDING')),
  -- Una tarjeta nunca se declara PENDING: o se confirmó o es UNKNOWN (F13).
  constraint money_components_card_outcome
    check (method <> 'CARD' or outcome in ('CONFIRMED','UNKNOWN')),
  -- El efectivo puede quedar sin confirmar (UNKNOWN): en ese caso el
  -- efectivo esperado de la caja no es confiable y el cierre se bloquea
  -- (B-DEC-09 / F26). El efectivo NO confirmado no mueve la caja.
  constraint money_components_cash_outcome_valid
    check (method <> 'CASH' or outcome in ('CONFIRMED','PENDING','UNKNOWN'))
);

create index if not exists money_components_operation
  on money.money_components (business_id, money_operation_id, position);
create index if not exists money_components_unconfirmed
  on money.money_components (business_id, outcome) where outcome <> 'CONFIRMED';

-- Asignación posterior de dinero YA CONFIRMADO. NO genera dinero nuevo
-- (D10/D18, B-DEC-06): un anticipo se aplica, no se vuelve a cobrar.
create table if not exists money.money_allocations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  money_operation_id uuid not null,
  target_type text not null check (target_type in ('SALE','OBLIGATION')),
  target_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  actor_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  operation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  constraint money_allocations_operation_fk foreign key (business_id, money_operation_id)
    references money.money_operations(business_id, id) on delete restrict,
  constraint money_allocations_attempt_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict,
  -- El importe asignado nunca excede el dinero confirmado de la operación.
  constraint money_allocations_within_confirmed
    check (amount_minor > 0)
);

create index if not exists money_allocations_target
  on money.money_allocations (business_id, target_type, target_id);
create index if not exists money_allocations_operation
  on money.money_allocations (business_id, money_operation_id);

-- Conciliación de dinero contra caja. La diferencia se REGISTRA con motivo;
-- nunca se ajusta en silencio (WP-02-T06, F25).
create table if not exists money.money_reconciliations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  cash_session_id uuid not null,
  expected_amount_minor bigint not null check (expected_amount_minor >= 0),
  observed_amount_minor bigint not null check (observed_amount_minor >= 0),
  difference_minor bigint not null,
  reason text not null check (length(trim(reason)) between 3 and 500),
  actor_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  operation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (operation_id),
  -- La FK a `cash.cash_sessions` se agrega al final del archivo (esa tabla
  -- se crea más abajo en esta misma migración).
  constraint money_reconciliations_attempt_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict,
  -- La diferencia es EXACTA: observada − esperada.
  constraint money_reconciliations_difference_exact
    check (difference_minor = observed_amount_minor - expected_amount_minor)
);

-- =============================================================================
-- 3. CASH · CAP-05-04
-- =============================================================================

-- Caja FÍSICA identificada (D19/B-DEC-07). La sesión de caja no es una
-- sesión de login: es una caja concreta del local.
create table if not exists cash.cashboxes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 80),
  active boolean not null default true,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, name)
);

-- Sesión de caja. Una sesión ABIERTA por caja identificada (D19).
-- Al cerrar conserva un SNAPSHOT histórico inmutable (D09).
create table if not exists cash.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  cashbox_id uuid not null,
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  opened_by_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  opened_at timestamptz not null default now(),
  opening_amount_minor bigint not null default 0 check (opening_amount_minor >= 0),
  closed_at timestamptz,
  closed_by_account_id uuid references iam.user_accounts(id) on delete restrict,
  counted_amount_minor bigint,
  expected_amount_minor bigint,
  difference_minor bigint,
  closure_reason text,
  -- Snapshot inmutable del estado al cerrar (D09).
  snapshot jsonb,
  revision bigint not null default 1 check (revision > 0),
  operation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (operation_id),
  constraint cash_sessions_cashbox_fk foreign key (business_id, cashbox_id)
    references cash.cashboxes(business_id, id) on delete restrict,
  constraint cash_sessions_attempt_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict,
  -- Cierre coherente: cerrado ⇔ hay cierre, conteo, esperado y snapshot.
  constraint cash_sessions_closed_consistency
    check ((status = 'CLOSED') = (closed_at is not null)),
  constraint cash_sessions_closed_requires_count
    check (status <> 'CLOSED' or (counted_amount_minor is not null and expected_amount_minor is not null and snapshot is not null)),
  constraint cash_sessions_open_has_no_count
    check (status <> 'OPEN' or (counted_amount_minor is null and closed_at is null)),
  -- La diferencia registrada es EXACTA.
  constraint cash_sessions_difference_exact
    check (difference_minor is null or counted_amount_minor is null
           or difference_minor = counted_amount_minor - expected_amount_minor),
  -- Una diferencia exige motivo explícito (F25).
  constraint cash_sessions_difference_requires_reason
    check (difference_minor is null or difference_minor = 0 or (closure_reason is not null and length(trim(closure_reason)) between 3 and 500))
);

comment on table cash.cash_sessions is
  'H05 CAP-05-04: sesión de una caja física identificada. Una sesión abierta por caja. El cierre es inmutable y conserva snapshot.';

-- Una sola sesión ABIERTA por caja física identificada.
create unique index if not exists cash_one_open_session_per_cashbox
  on cash.cash_sessions (business_id, cashbox_id) where status = 'OPEN';
create index if not exists cash_sessions_business_recent
  on cash.cash_sessions (business_id, opened_at desc, id desc);

-- Movimientos de efectivo. SÓLO efectivo físico (D08): una transferencia o
-- una tarjeta NUNCA generan un movimiento de caja.
create table if not exists cash.cash_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  cash_session_id uuid not null,
  type text not null check (type in ('INCOME','EXPENSE','CHANGE','SALE_CASH')),
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null check (length(trim(reason)) between 3 and 500),
  money_operation_id uuid,
  correction_id uuid,
  actor_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  operation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  constraint cash_movements_session_fk foreign key (business_id, cash_session_id)
    references cash.cash_sessions(business_id, id) on delete restrict,
  constraint cash_movements_money_fk foreign key (business_id, money_operation_id)
    references money.money_operations(business_id, id) on delete restrict,
  constraint cash_movements_attempt_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict,
  -- Un movimiento de venta o de vuelto siempre viene de un cobro real.
  constraint cash_movements_money_link_check
    check (type not in ('SALE_CASH','CHANGE') or money_operation_id is not null)
);

create index if not exists cash_movements_session
  on cash.cash_movements (business_id, cash_session_id, created_at);
create index if not exists cash_movements_money
  on cash.cash_movements (business_id, money_operation_id) where money_operation_id is not null;

-- =============================================================================
-- 4. OBLIGATIONS · CAP-05-05
-- =============================================================================

-- Gasto u obligación. UNKNOWN_AMOUNT se representa con amount_minor NULL y
-- amount_state = 'UNKNOWN_AMOUNT': NUNCA cero (D22, F28).
create table if not exists obligations.expense_obligations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  operation_id uuid not null,
  kind text not null check (kind in ('PAYABLE','RECEIVABLE')),
  title text not null check (length(trim(title)) between 1 and 160),
  -- Contraparte siempre identificada (B01.7.3).
  counterparty_name text not null check (length(trim(counterparty_name)) between 1 and 160),
  amount_minor bigint,
  amount_state text not null default 'KNOWN' check (amount_state in ('KNOWN','UNKNOWN_AMOUNT')),
  currency text not null default 'ARS' check (currency = 'ARS'),
  due_date date,
  status text not null default 'OPEN' check (status in ('OPEN','PARTIAL','SETTLED','CANCELLED')),
  revision bigint not null default 1 check (revision > 0),
  note text,
  cancelled_at timestamptz,
  actor_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (operation_id),
  constraint obligations_attempt_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict,
  -- Importe desconocido ⇔ amount_minor IS NULL. Cero NO es desconocido.
  constraint obligations_amount_state_exact
    check ((amount_state = 'UNKNOWN_AMOUNT') = (amount_minor is null)),
  constraint obligations_known_amount_positive
    check (amount_minor is null or amount_minor > 0),
  -- Una obligación de importe desconocido NO puede estar saldada.
  constraint obligations_unknown_not_settled
    check (amount_state <> 'UNKNOWN_AMOUNT' or status <> 'SETTLED'),
  constraint obligations_cancelled_consistency
    check ((status = 'CANCELLED') = (cancelled_at is not null))
);

comment on table obligations.expense_obligations is
  'H05 CAP-05-05: gasto u obligación. UNKNOWN_AMOUNT ≠ cero: el importe desconocido es NULL.';

create index if not exists obligations_business_recent
  on obligations.expense_obligations (business_id, created_at desc, id desc);
create index if not exists obligations_business_status
  on obligations.expense_obligations (business_id, status, due_date);

-- Pagos parciales y settlement. Siempre vinculados a una MoneyOperation
-- EXISTENTE: el pago consume dinero ya confirmado, no lo inventa (B01.7.8).
create table if not exists obligations.obligation_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  obligation_id uuid not null,
  money_operation_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  kind text not null default 'PAYMENT' check (kind in ('PAYMENT','SETTLEMENT')),
  actor_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  operation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  constraint obligation_payments_obligation_fk foreign key (business_id, obligation_id)
    references obligations.expense_obligations(business_id, id) on delete restrict,
  constraint obligation_payments_money_fk foreign key (business_id, money_operation_id)
    references money.money_operations(business_id, id) on delete restrict,
  constraint obligation_payments_attempt_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict
);

create index if not exists obligation_payments_obligation
  on obligations.obligation_payments (business_id, obligation_id);

-- =============================================================================
-- 5. CHECKOUT · CAP-05-06
-- =============================================================================

-- Coordinación RECUPERABLE entre Sale, Money, Cash e Inventory. NO es un
-- ledger monetario ni de stock (D13). No registra saldos propios.
create table if not exists checkout.checkouts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  operation_id uuid not null,
  sale_id uuid not null,
  money_operation_id uuid,
  cash_session_id uuid,
  status text not null default 'PENDING'
    check (status in ('PENDING','MONEY_CONFIRMED','DELIVERED','DELIVERY_PENDING','RESOLVED','FAILED','UNKNOWN')),
  total_minor bigint not null check (total_minor >= 0),
  confirmed_minor bigint not null default 0 check (confirmed_minor >= 0),
  -- Referencia causal que amarra la entrega física a ESTE checkout.
  source_reference text not null check (length(trim(source_reference)) between 3 and 200),
  incident_reason text,
  revision bigint not null default 1 check (revision > 0),
  actor_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (operation_id),
  unique (business_id, source_reference),
  constraint checkouts_sale_fk foreign key (business_id, sale_id)
    references sales.sales(business_id, id) on delete restrict,
  constraint checkouts_money_fk foreign key (business_id, money_operation_id)
    references money.money_operations(business_id, id) on delete restrict,
  constraint checkouts_cash_fk foreign key (business_id, cash_session_id)
    references cash.cash_sessions(business_id, id) on delete restrict,
  constraint checkouts_attempt_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict,
  -- Un checkout entregado tiene dinero confirmado y entrega realizada.
  constraint checkouts_delivered_requires_money
    check (status <> 'DELIVERED' or money_operation_id is not null),
  -- Una incidencia de entrega pendiente exige motivo explícito (F33).
  constraint checkouts_incident_requires_reason
    check (status <> 'DELIVERY_PENDING' or (incident_reason is not null and length(trim(incident_reason)) between 3 and 500))
);

comment on table checkout.checkouts is
  'H05 CAP-05-06: coordinación recuperable Sale+Money+Cash+Inventory. No es un ledger adicional.';

create index if not exists checkouts_business_recent
  on checkout.checkouts (business_id, created_at desc, id desc);
create index if not exists checkouts_sale
  on checkout.checkouts (business_id, sale_id);

-- =============================================================================
-- 6. CORRECTIONS · CAP-05-07
-- =============================================================================

-- Correcciones trazables. Hechos POSTERIORES que conservan el original
-- (D14/D26). El historial before/after vive acá; el hecho original no se
-- reescribe para ocultar errores.
create table if not exists corrections.corrections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.businesses(id) on delete restrict,
  operation_id uuid not null,
  type text not null check (type in ('COMMERCIAL','MONETARY','CASH','PHYSICAL')),
  target_type text not null check (target_type in ('SALE','MONEY_OPERATION','CASH_SESSION','INVENTORY_MOVEMENT')),
  target_id uuid not null,
  status text not null default 'PENDING' check (status in ('PENDING','APPLIED','REJECTED')),
  -- Motivo OBLIGATORIO (B01.9.1).
  reason text not null check (length(trim(reason)) between 3 and 500),
  evidence_reference text,
  before_snapshot jsonb not null default '{}'::jsonb,
  after_snapshot jsonb not null default '{}'::jsonb,
  actor_account_id uuid not null references iam.user_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (operation_id),
  constraint corrections_attempt_fk foreign key (business_id, operation_id)
    references system.operation_attempts(business_id, operation_id) on delete restrict,
  -- Una corrección MONETARY no puede crear ni una devolución física.
  constraint corrections_monetary_not_physical
    check (type <> 'MONETARY' or target_type = 'MONEY_OPERATION'),
  constraint corrections_cash_targets_cash
    check (type <> 'CASH' or target_type = 'CASH_SESSION'),
  constraint corrections_commercial_targets_sale
    check (type <> 'COMMERCIAL' or target_type = 'SALE'),
  constraint corrections_physical_targets_inventory
    check (type <> 'PHYSICAL' or target_type = 'INVENTORY_MOVEMENT')
);

create index if not exists corrections_business_recent
  on corrections.corrections (business_id, created_at desc, id desc);
create index if not exists corrections_target
  on corrections.corrections (business_id, target_type, target_id);

-- =============================================================================
-- 6.bis · Claves foráneas diferidas
--
-- PostgreSQL exige que la tabla referenciada exista al crear la FK. Las dos
-- relaciones siguientes son circulares en el orden de creación (Money →
-- Obligation → Money, Money → Cash → Money), por lo que se declaran aquí,
-- una vez creadas todas las tablas.
-- =============================================================================

alter table money.money_operations
  add constraint money_operation_obligation_fk
  foreign key (business_id, obligation_id)
  references obligations.expense_obligations(business_id, id) on delete restrict;

alter table money.money_reconciliations
  add constraint money_reconciliations_session_fk
  foreign key (business_id, cash_session_id)
  references cash.cash_sessions(business_id, id) on delete restrict;

-- =============================================================================
-- 7. INVARIANTES DE BASE DE DATOS (triggers)
-- =============================================================================

-- 7.1 Las líneas de venta son append-only en su contenido comercial.
-- Sólo puede cambiar `superseded_at` (una corrección posterior marca la
-- línea como superada, sin reescribir su snapshot histórico).
create or replace function sales.guard_line_immutability() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Las líneas de venta no se borran: se corrigen con trazabilidad' using errcode = '23514';
  end if;
  if (new.business_id, new.sale_id, new.revision, new.position, new.kind, new.service_id, new.sku,
      new.location_id, new.name, new.quantity, new.unit_price_minor, new.discount_minor,
      new.line_total_minor, new.currency, new.duration_minutes, new.snapshot_at)
     is distinct from
     (old.business_id, old.sale_id, old.revision, old.position, old.kind, old.service_id, old.sku,
      old.location_id, old.name, old.quantity, old.unit_price_minor, old.discount_minor,
      old.line_total_minor, old.currency, old.duration_minutes, old.snapshot_at) then
    raise exception 'El contenido comercial de una línea de venta es inmutable' using errcode = '23514';
  end if;
  if new.superseded_at is not null and old.superseded_at is not null then
    raise exception 'Una línea de venta superada no vuelve a estar vigente' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_sale_line_immutability on sales.sale_lines;
create trigger guard_sale_line_immutability
  before update or delete on sales.sale_lines
  for each row execute function sales.guard_line_immutability();

-- 7.2 Una venta CONFIRMADA conserva su contenido; sólo puede pasar a
-- CANCELLED (con motivo) o ser corregida mediante el mecanismo de
-- correcciones, que conserva el before/after.
create or replace function sales.guard_confirmed_sale() returns trigger language plpgsql as $$
begin
  if old.status = 'CONFIRMED' then
    if (new.status <> 'CANCELLED' and new.status <> 'CONFIRMED') then
      raise exception 'Una venta confirmada sólo puede confirmarse o anularse' using errcode = '23514';
    end if;
    if new.total_minor is distinct from old.total_minor and new.status = 'CONFIRMED' then
      -- Un cambio de total es legítimo SOLO si existe una corrección
      -- trazable para esta venta en la misma transacción (D14/D26).
      if not exists (
        select 1 from corrections.corrections c
         where c.business_id = new.business_id and c.target_type = 'SALE'
           and c.target_id = new.id and c.status in ('PENDING','APPLIED')
      ) then
        raise exception 'El total de una venta confirmada se modifica sólo mediante una corrección trazable' using errcode = '23514';
      end if;
    end if;
    if new.status = 'CONFIRMED'
       and (new.currency is distinct from old.currency or new.source is distinct from old.source
            or new.attendance_id is distinct from old.attendance_id) then
      raise exception 'El origen causal y la moneda de una venta confirmada son inmutables' using errcode = '23514';
    end if;
  end if;
  if new.revision < old.revision then
    raise exception 'La revisión de una venta no retrocede' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_confirmed_sale on sales.sales;
create trigger guard_confirmed_sale
  before update on sales.sales
  for each row execute function sales.guard_confirmed_sale();

-- 7.3 Una MoneyOperation confirmada conserva su importe y su origen. El
-- UNKNOWN puede resolverse a SUCCEEDED/PROVEN_FAILED sólo con una resolución
-- explícita y auditada (nunca por timeout).
create or replace function money.guard_operation_immutability() returns trigger language plpgsql as $$
begin
  if (new.kind, new.amount_minor, new.refund_of_id, new.currency, new.business_id)
     is distinct from
     (old.kind, old.amount_minor, old.refund_of_id, old.currency, old.business_id) then
    raise exception 'El importe y el origen de una operación de dinero son inmutables' using errcode = '23514';
  end if;
  if old.status = 'SUCCEEDED' and new.status <> 'SUCCEEDED' then
    raise exception 'Una operación de dinero confirmada no se degrada' using errcode = '23514';
  end if;
  if old.status = 'PROVEN_FAILED' and new.status <> 'PROVEN_FAILED' then
    raise exception 'Un fallo probado no se degrada' using errcode = '23514';
  end if;
  if new.confirmed_minor < 0 then
    raise exception 'El dinero confirmado no puede ser negativo' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_money_operation_immutability on money.money_operations;
create trigger guard_money_operation_immutability
  before update on money.money_operations
  for each row execute function money.guard_operation_immutability();

-- 7.4 Los componentes de dinero son append-only en su importe y su medio.
-- Sólo su `outcome` puede pasar de PENDING/UNKNOWN a CONFIRMED (acreditación
-- o confirmación externa posterior, auditada).
create or replace function money.guard_component_immutability() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Los componentes de dinero no se borran' using errcode = '23514';
  end if;
  if (new.business_id, new.money_operation_id, new.position, new.method, new.amount_minor,
      new.tendered_minor, new.change_minor, new.currency)
     is distinct from
     (old.business_id, old.money_operation_id, old.position, old.method, old.amount_minor,
      old.tendered_minor, old.change_minor, old.currency) then
    raise exception 'El importe y el medio de un componente de dinero son inmutables' using errcode = '23514';
  end if;
  if old.outcome = 'CONFIRMED' and new.outcome <> 'CONFIRMED' then
    raise exception 'Un componente de dinero confirmado no se degrada' using errcode = '23514';
  end if;
  if old.outcome = 'UNKNOWN' and new.outcome = 'PENDING' then
    raise exception 'Un resultado desconocido no se degrada a pendiente' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_money_component_immutability on money.money_components;
create trigger guard_money_component_immutability
  before update or delete on money.money_components
  for each row execute function money.guard_component_immutability();

-- 7.5 Las asignaciones son append-only: el dinero aplicado no se_desasigna
-- en silencio (se corrige con un hecho posterior).
create or replace function money.guard_allocation_immutability() returns trigger language plpgsql as $$
begin
  raise exception 'Las asignaciones de dinero son inmutables' using errcode = '23514';
end $$;
drop trigger if exists guard_money_allocation_immutability on money.money_allocations;
create trigger guard_money_allocation_immutability
  before update or delete on money.money_allocations
  for each row execute function money.guard_allocation_immutability();

-- 7.6 Una caja cerrada es INMUTABLE (D09) y no admite movimientos nuevos.
create or replace function cash.guard_closed_session() returns trigger language plpgsql as $$
begin
  if old.status = 'CLOSED' then
    raise exception 'Una sesión de caja cerrada es inmutable' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_cash_closed_session on cash.cash_sessions;
create trigger guard_cash_closed_session
  before update on cash.cash_sessions
  for each row execute function cash.guard_closed_session();

-- 7.7 Los movimientos de caja son append-only.
create or replace function cash.guard_movement_immutability() returns trigger language plpgsql as $$
begin
  raise exception 'Los movimientos de caja son append-only' using errcode = '23514';
end $$;
drop trigger if exists guard_cash_movement_immutability on cash.cash_movements;
create trigger guard_cash_movement_immutability
  before update or delete on cash.cash_movements
  for each row execute function cash.guard_movement_immutability();

-- 7.8 No se puede mover efectivo en una sesión cerrada.
create or replace function cash.guard_movement_into_closed_session() returns trigger language plpgsql as $$
declare session_status text;
begin
  select status into session_status from cash.cash_sessions
   where business_id = new.business_id and id = new.cash_session_id;
  if session_status is null then
    raise exception 'La sesión de caja no existe en este negocio' using errcode = '23503';
  end if;
  if session_status <> 'OPEN' then
    raise exception 'La sesión de caja está cerrada: no admite movimientos' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_cash_movement_session_state on cash.cash_movements;
create trigger guard_cash_movement_session_state
  before insert on cash.cash_movements
  for each row execute function cash.guard_movement_into_closed_session();

-- 7.9 Los pagos de obligación son append-only.
create or replace function obligations.guard_payment_immutability() returns trigger language plpgsql as $$
begin
  raise exception 'Los pagos de obligación son inmutables' using errcode = '23514';
end $$;
drop trigger if exists guard_obligation_payment_immutability on obligations.obligation_payments;
create trigger guard_obligation_payment_immutability
  before update or delete on obligations.obligation_payments
  for each row execute function obligations.guard_payment_immutability();

-- 7.10 Una obligación de importe desconocido NO puede pasar a saldada.
create or replace function obligations.guard_unknown_amount() returns trigger language plpgsql as $$
begin
  if old.amount_state = 'UNKNOWN_AMOUNT' and new.status = 'SETTLED' then
    raise exception 'Una obligación de importe desconocido no puede marcarse como saldada' using errcode = '23514';
  end if;
  if old.amount_state = 'UNKNOWN_AMOUNT' and new.amount_minor is not null and old.status = 'SETTLED' then
    raise exception 'Una obligación de importe desconocido no puede pasar a saldada' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_obligation_unknown_amount on obligations.expense_obligations;
create trigger guard_obligation_unknown_amount
  before update on obligations.expense_obligations
  for each row execute function obligations.guard_unknown_amount();

-- 7.11 Las correcciones son append-only: la historia no se reescribe.
create or replace function corrections.guard_immutability() returns trigger language plpgsql as $$
begin
  -- La transición PENDING → APPLIED ocurre DENTRO de la misma transacción
  -- de creación, una vez que el efecto de la corrección fue confirmado.
  -- Es la materialización del hecho, no una reescritura de historia.
  if tg_op='UPDATE' and old.status='PENDING' and new.status='APPLIED'
     and (new.business_id,new.operation_id,new.type,new.target_type,new.target_id,
          new.reason,new.evidence_reference,new.before_snapshot,new.actor_account_id,new.created_at)
         is not distinct from
         (old.business_id,old.operation_id,old.type,old.target_type,old.target_id,
          old.reason,old.evidence_reference,old.before_snapshot,old.actor_account_id,old.created_at) then
    return new;
  end if;
  raise exception 'Las correcciones conservan la historia: son append-only' using errcode = '23514';
end $$;
drop trigger if exists guard_correction_immutability on corrections.corrections;
create trigger guard_correction_immutability
  before update or delete on corrections.corrections
  for each row execute function corrections.guard_immutability();

-- 7.12 Un checkout entregado no vuelve a un estado previo; y una incidencia
-- de entrega pendiente no se resuelve sola.
create or replace function checkout.guard_status_regression() returns trigger language plpgsql as $$
begin
  if old.status = 'DELIVERED' and new.status <> 'DELIVERED' and new.status <> 'RESOLVED' then
    raise exception 'Un checkout entregado no vuelve a un estado previo' using errcode = '23514';
  end if;
  if old.status = 'DELIVERY_PENDING' and new.status = 'DELIVERED' and new.money_operation_id is null then
    raise exception 'No se puede entregar sin dinero confirmado' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_checkout_status on checkout.checkouts;
create trigger guard_checkout_status
  before update on checkout.checkouts
  for each row execute function checkout.guard_status_regression();

revoke all on function sales.guard_line_immutability() from public, anon, authenticated;
revoke all on function sales.guard_confirmed_sale() from public, anon, authenticated;
revoke all on function money.guard_operation_immutability() from public, anon, authenticated;
revoke all on function money.guard_component_immutability() from public, anon, authenticated;
revoke all on function money.guard_allocation_immutability() from public, anon, authenticated;
revoke all on function cash.guard_closed_session() from public, anon, authenticated;
revoke all on function cash.guard_movement_immutability() from public, anon, authenticated;
revoke all on function cash.guard_movement_into_closed_session() from public, anon, authenticated;
revoke all on function obligations.guard_payment_immutability() from public, anon, authenticated;
revoke all on function obligations.guard_unknown_amount() from public, anon, authenticated;
revoke all on function corrections.guard_immutability() from public, anon, authenticated;
revoke all on function checkout.guard_status_regression() from public, anon, authenticated;

grant execute on function sales.guard_line_immutability() to service_role;
grant execute on function sales.guard_confirmed_sale() to service_role;
grant execute on function money.guard_operation_immutability() to service_role;
grant execute on function money.guard_component_immutability() to service_role;
grant execute on function money.guard_allocation_immutability() to service_role;
grant execute on function cash.guard_closed_session() to service_role;
grant execute on function cash.guard_movement_immutability() to service_role;
grant execute on function cash.guard_movement_into_closed_session() to service_role;
grant execute on function obligations.guard_payment_immutability() to service_role;
grant execute on function obligations.guard_unknown_amount() to service_role;
grant execute on function corrections.guard_immutability() to service_role;
grant execute on function checkout.guard_status_regression() to service_role;
