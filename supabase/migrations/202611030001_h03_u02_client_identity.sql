-- H03.U02 Identidad global Cliente. Seguridad backend-only, sin Business ficticio.

create type iam.client_identity_status as enum (
  'PENDING_MFA','RECOVERY_SETUP_REQUIRED','ACTIVE','RECOVERY_REQUIRED','RESTRICTED'
);
create type iam.client_recovery_operation_status as enum (
  'PENDING','RUNNING','SUCCESS','FAILED','UNKNOWN_RECONCILIATION_REQUIRED'
);

create table iam.client_identity_states (
  account_id uuid primary key references iam.user_accounts(id) on delete restrict,
  status iam.client_identity_status not null default 'PENDING_MFA',
  verified_phone_e164 text,
  phone_verified_at timestamptz,
  mfa_required boolean not null default true check (mfa_required),
  mfa_enrolled_at timestamptz,
  recovery_codes_version bigint not null default 0 check (recovery_codes_version >= 0),
  recovery_codes_acknowledged_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_identity_phone_shape check (
    verified_phone_e164 is null or verified_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
  ),
  constraint client_identity_phone_timestamp check (
    (verified_phone_e164 is null) = (phone_verified_at is null)
  )
);

create table iam.client_access_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references iam.user_accounts(id) on delete restrict,
  provider_session_id text not null check (length(provider_session_id) > 0),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  security_revision_at_creation bigint not null check (security_revision_at_creation > 0),
  constraint client_access_sessions_account_provider_key unique (account_id, provider_session_id),
  constraint client_access_sessions_expiry_check check (expires_at > created_at),
  constraint client_access_sessions_revocation_check check (
    (revoked_at is null and revoked_reason is null) or
    (revoked_at is not null and revoked_reason is not null)
  )
);
create index client_access_sessions_account_active_idx
  on iam.client_access_sessions(account_id, last_seen_at desc)
  where revoked_at is null;

create table iam.client_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references iam.user_accounts(id) on delete restrict,
  code_hash text not null,
  salt text not null,
  batch_version bigint not null check (batch_version > 0),
  issued_at timestamptz not null default now(),
  used_at timestamptz,
  revoked_at timestamptz,
  constraint client_recovery_codes_hash_key unique (account_id, code_hash),
  constraint client_recovery_codes_terminal_check check (used_at is null or revoked_at is null)
);
create index client_recovery_codes_active_batch_idx
  on iam.client_recovery_codes(account_id, batch_version)
  where used_at is null and revoked_at is null;

create table iam.client_recovery_operations (
  id uuid primary key,
  account_id uuid not null references iam.user_accounts(id) on delete restrict,
  provider_session_id text not null check (length(provider_session_id) > 0),
  status iam.client_recovery_operation_status not null default 'PENDING',
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  safe_result_code text,
  audit_reference uuid,
  constraint client_recovery_operations_expiry_check check (expires_at > started_at),
  constraint client_recovery_operations_resolution_check check (
    (status in ('PENDING','RUNNING') and resolved_at is null) or
    (status in ('SUCCESS','FAILED','UNKNOWN_RECONCILIATION_REQUIRED') and resolved_at is not null)
  )
);
create index client_recovery_operations_account_idx
  on iam.client_recovery_operations(account_id, started_at desc);

create table iam.client_security_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references iam.user_accounts(id) on delete restrict,
  auth_user_id uuid,
  event_type text not null check (length(trim(event_type)) > 0),
  outcome text not null check (outcome in ('SUCCEEDED','DENIED','FAILED','UNKNOWN')),
  occurred_at timestamptz not null default now(),
  operation_reference uuid,
  metadata jsonb not null default '{}'::jsonb,
  constraint client_security_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);
create index client_security_events_account_time_idx
  on iam.client_security_events(account_id, occurred_at desc);

-- Idempotencia global. response_body sólo admite resultados no secretos.
create table iam.client_operations (
  operation_id uuid primary key,
  auth_user_id uuid not null,
  account_id uuid references iam.user_accounts(id) on delete restrict,
  provider_session_id text,
  command_name text not null,
  request_fingerprint text not null,
  status text not null check (status in ('STARTED','SUCCEEDED','FAILED','UNKNOWN')),
  response_status integer,
  safe_response jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint client_operations_terminal_check check (
    (status = 'STARTED' and completed_at is null) or
    (status <> 'STARTED' and completed_at is not null)
  )
);
create index client_operations_identity_idx
  on iam.client_operations(auth_user_id, created_at desc);

-- Evita confirmar dos cambios concurrentes contra una revisión obsoleta.
create table iam.client_phone_change_states (
  account_id uuid primary key references iam.user_accounts(id) on delete restrict,
  expected_identity_revision bigint not null check (expected_identity_revision > 0),
  requested_phone_hash text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  constraint client_phone_change_expiry_check check (expires_at > started_at)
);

alter table iam.client_identity_states enable row level security;
alter table iam.client_access_sessions enable row level security;
alter table iam.client_recovery_codes enable row level security;
alter table iam.client_recovery_operations enable row level security;
alter table iam.client_security_events enable row level security;
alter table iam.client_operations enable row level security;
alter table iam.client_phone_change_states enable row level security;

revoke all on iam.client_identity_states, iam.client_access_sessions,
  iam.client_recovery_codes, iam.client_recovery_operations,
  iam.client_security_events, iam.client_operations,
  iam.client_phone_change_states from anon, authenticated;
grant all on iam.client_identity_states, iam.client_access_sessions,
  iam.client_recovery_codes, iam.client_recovery_operations,
  iam.client_security_events, iam.client_operations,
  iam.client_phone_change_states to service_role;
