import type Database from 'better-sqlite3';

const MIGRATIONS = [
  `
    CREATE TABLE agent_run_sequences (
      run_id TEXT PRIMARY KEY,
      current_sequence INTEGER NOT NULL CHECK (current_sequence >= 0)
    );
    CREATE TABLE agent_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_json TEXT NOT NULL,
      UNIQUE (run_id, sequence)
    );
    CREATE INDEX agent_events_run_sequence ON agent_events(run_id, sequence);
    CREATE INDEX agent_events_type_timestamp ON agent_events(type, timestamp);
    CREATE TABLE agent_messages (
      message_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      message_json TEXT NOT NULL
    );
    CREATE INDEX agent_messages_run ON agent_messages(run_id, message_id);
    CREATE TABLE projection_checkpoints (
      projector TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      PRIMARY KEY (projector, run_id)
    );
    CREATE TABLE projection_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      projector TEXT NOT NULL,
      error_code TEXT NOT NULL,
      message TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE agent_checkpoints (
      run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision > 0),
      context_version INTEGER NOT NULL CHECK (context_version > 0),
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      checkpoint_schema_version INTEGER NOT NULL CHECK (checkpoint_schema_version > 0),
      checkpoint_json TEXT NOT NULL,
      checksum TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX agent_checkpoints_status_updated ON agent_checkpoints(status, updated_at);

    CREATE TABLE evidence_records (
      evidence_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      tool_call_id TEXT,
      capture_key TEXT UNIQUE,
      source TEXT NOT NULL CHECK (source IN ('metric', 'log', 'trace', 'change')),
      captured_at TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      raw_sha256 TEXT NOT NULL,
      business_trace_ids_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0)
    );
    CREATE INDEX evidence_records_run_captured ON evidence_records(run_id, captured_at, evidence_id);
    CREATE INDEX evidence_records_source_captured ON evidence_records(source, captured_at, evidence_id);

    CREATE TABLE tool_executions (
      tool_call_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_kind TEXT NOT NULL CHECK (tool_kind IN ('evidence', 'action', 'utility')),
      input_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'succeeded', 'failed', 'uncertain')),
      result_json TEXT,
      reason_code TEXT,
      prepared_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX tool_executions_run_state ON tool_executions(run_id, state, tool_call_id);
  `,
  `
    CREATE TABLE durable_event_outbox (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'published')),
      created_at TEXT NOT NULL,
      published_at TEXT
    );
    CREATE INDEX durable_event_outbox_pending_run
      ON durable_event_outbox(state, run_id, event_id);
  `,
  [
    'CREATE TABLE evidence_blob_manifests (',
    '  manifest_id TEXT PRIMARY KEY,',
    '  evidence_id TEXT NOT NULL UNIQUE,',
    '  run_id TEXT NOT NULL,',
    '  step_id TEXT NOT NULL,',
    '  tool_call_id TEXT NOT NULL,',
    '  capture_key TEXT NOT NULL UNIQUE,',
    "  source TEXT NOT NULL CHECK (source IN ('log', 'trace')),",
    '  query_digest TEXT NOT NULL,',
    '  source_snapshot_id TEXT,',
    '  range_start TEXT NOT NULL,',
    '  range_end TEXT NOT NULL,',
    "  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'partial', 'failed', 'deleting')),",
    '  record_count INTEGER NOT NULL DEFAULT 0,',
    '  source_bytes INTEGER NOT NULL DEFAULT 0,',
    '  stored_bytes INTEGER NOT NULL DEFAULT 0,',
    "  compression TEXT NOT NULL CHECK (compression = 'gzip_ndjson'),",
    '  next_cursor TEXT,',
    '  truncated INTEGER NOT NULL DEFAULT 0,',
    '  coverage REAL NOT NULL DEFAULT 0,',
    "  raw_sha256 TEXT NOT NULL DEFAULT '',",
    '  summary_json TEXT,',
    "  missing_evidence_json TEXT NOT NULL DEFAULT '[]',",
    '  failure_reason_code TEXT,',
    '  redaction_policy_version TEXT NOT NULL,',
    '  retention_until TEXT,',
    '  created_at TEXT NOT NULL,',
    '  updated_at TEXT NOT NULL,',
    '  committed_at TEXT',
    ');',
    'CREATE TABLE evidence_blob_chunks (',
    '  manifest_id TEXT NOT NULL,',
    '  chunk_index INTEGER NOT NULL,',
    '  storage_key TEXT NOT NULL UNIQUE,',
    '  record_count INTEGER NOT NULL,',
    '  source_bytes INTEGER NOT NULL,',
    '  stored_bytes INTEGER NOT NULL,',
    '  sha256 TEXT NOT NULL,',
    '  first_captured_at TEXT,',
    '  last_captured_at TEXT,',
    '  committed_at TEXT NOT NULL,',
    '  PRIMARY KEY (manifest_id, chunk_index),',
    '  FOREIGN KEY (manifest_id) REFERENCES evidence_blob_manifests(manifest_id) ON DELETE RESTRICT',
    ');',
    'CREATE INDEX evidence_blob_manifests_run_time ON evidence_blob_manifests(run_id, range_start, range_end);',
    'CREATE INDEX evidence_blob_manifests_state_updated ON evidence_blob_manifests(state, updated_at);',
  ].join('\n'),
  `
    CREATE TABLE diagnostic_memory_cases (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      profile_id TEXT NOT NULL, profile_revision TEXT NOT NULL,
      service_id TEXT NOT NULL, fault_type TEXT NOT NULL, target_fingerprint TEXT NOT NULL,
      environment TEXT NOT NULL, data_class TEXT NOT NULL, dataset_id TEXT,
      source_run_id TEXT NOT NULL, extractor_version TEXT NOT NULL,
      source_run_status TEXT NOT NULL CHECK (source_run_status IN ('completed', 'failed', 'cancelled')),
      captured_at TEXT NOT NULL, valid_until TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL CHECK (status IN ('observation', 'approved', 'rejected')),
      quality TEXT NOT NULL CHECK (quality IN ('sufficient', 'insufficient', 'failed')),
      case_json TEXT NOT NULL CHECK (length(CAST(case_json AS BLOB)) <= 16384),
      case_checksum TEXT NOT NULL,
      index_version TEXT NOT NULL,
      UNIQUE(source_run_id, extractor_version)
    );
    CREATE INDEX diagnostic_memory_cases_scope_status
      ON diagnostic_memory_cases(scope_key, status, id);
    CREATE INDEX diagnostic_memory_cases_expiry ON diagnostic_memory_cases(status, valid_until, id);
    CREATE VIRTUAL TABLE diagnostic_memory_case_fts USING fts5(tokens, memory_id UNINDEXED, tokenize='unicode61');
    CREATE TABLE diagnostic_memory_reviews (
      request_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES diagnostic_memory_cases(id) ON DELETE RESTRICT,
      scope_key TEXT NOT NULL, actor_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
      claim_check TEXT NOT NULL CHECK (claim_check IN ('supported', 'unsupported')),
      expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
      command_digest TEXT NOT NULL,
      command_json TEXT NOT NULL CHECK (length(CAST(command_json AS BLOB)) <= 16384),
      command_checksum TEXT NOT NULL,
      original_result_json TEXT NOT NULL CHECK (length(CAST(original_result_json AS BLOB)) <= 16384),
      result_checksum TEXT NOT NULL, result_revision INTEGER NOT NULL,
      reviewed_at TEXT NOT NULL
    );
    CREATE INDEX diagnostic_memory_reviews_case ON diagnostic_memory_reviews(memory_id, result_revision);
    CREATE TABLE diagnostic_memory_capture_jobs (
      candidate_id TEXT PRIMARY KEY, source_run_id TEXT NOT NULL,
      extractor_version TEXT NOT NULL, scope_key TEXT NOT NULL,
      source_checkpoint_revision INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed', 'skipped')),
      attempt INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 2), owner_id TEXT, lease_until TEXT,
      request_json TEXT NOT NULL CHECK (length(CAST(request_json AS BLOB)) <= 16384),
      request_checksum TEXT NOT NULL,
      terminal_failure_event_json TEXT NOT NULL CHECK (length(CAST(terminal_failure_event_json AS BLOB)) <= 16384),
      failure_event_checksum TEXT NOT NULL,
      memory_id TEXT, reason_code TEXT,
      index_version TEXT NOT NULL,
      UNIQUE(source_run_id, extractor_version)
    );
    CREATE INDEX diagnostic_memory_jobs_queue ON diagnostic_memory_capture_jobs(state, lease_until, candidate_id);
    CREATE TABLE diagnostic_memory_capture_commands (
      request_id TEXT PRIMARY KEY, source_run_id TEXT NOT NULL, scope_key TEXT NOT NULL,
      actor_id TEXT NOT NULL, expected_checkpoint_revision INTEGER NOT NULL,
      command_digest TEXT NOT NULL,
      command_json TEXT NOT NULL CHECK (length(CAST(command_json AS BLOB)) <= 16384),
      command_checksum TEXT NOT NULL,
      original_ticket_json TEXT NOT NULL CHECK (length(CAST(original_ticket_json AS BLOB)) <= 16384),
      ticket_checksum TEXT NOT NULL
    );
    CREATE TABLE diagnostic_memory_signals (
      signal_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      phase TEXT NOT NULL, observed_at TEXT NOT NULL,
      signal_json TEXT NOT NULL CHECK (length(CAST(signal_json AS BLOB)) <= 16384),
      signal_checksum TEXT NOT NULL, index_version TEXT NOT NULL
    );
    CREATE INDEX diagnostic_memory_signals_run ON diagnostic_memory_signals(run_id, observed_at, signal_key);
    CREATE INDEX diagnostic_memory_signals_expiry ON diagnostic_memory_signals(observed_at, signal_key);
  `,
  `
    CREATE TABLE target_run_requests (
      request_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX target_run_requests_target_created ON target_run_requests(target_id, created_at, request_id);

    CREATE TABLE target_snapshots (
      binding_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE run_target_bindings (
      run_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      root_run_id TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      request_id TEXT,
      request_digest TEXT,
      CHECK ((request_id IS NULL) = (request_digest IS NULL)),
      FOREIGN KEY (binding_id) REFERENCES target_snapshots(binding_id) ON DELETE RESTRICT,
      FOREIGN KEY (request_id) REFERENCES target_run_requests(request_id) ON DELETE RESTRICT
    );
    CREATE INDEX run_target_bindings_target_run ON run_target_bindings(target_id, run_id);
    CREATE INDEX run_target_bindings_root ON run_target_bindings(root_run_id, run_id);
  `,
  `
    CREATE TABLE target_identity_registry_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      registry_version INTEGER NOT NULL CHECK (registry_version >= 0),
      snapshot_json TEXT NOT NULL CHECK (length(CAST(snapshot_json AS BLOB)) <= 16777216),
      snapshot_checksum TEXT NOT NULL CHECK (length(snapshot_checksum) = 64)
    );

    CREATE TABLE target_identity_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('registered', 'updated', 'tombstoned')),
      registry_version INTEGER NOT NULL CHECK (registry_version > 0),
      identity_digest TEXT NOT NULL CHECK (length(identity_digest) = 64),
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX target_identity_audit_target_sequence
      ON target_identity_audit(target_id, sequence);
    CREATE TRIGGER target_identity_audit_no_update
      BEFORE UPDATE ON target_identity_audit
      BEGIN SELECT RAISE(ABORT, 'target identity audit is append-only'); END;
    CREATE TRIGGER target_identity_audit_no_delete
      BEFORE DELETE ON target_identity_audit
      BEGIN SELECT RAISE(ABORT, 'target identity audit is append-only'); END;

    CREATE TABLE target_knowledge_policies (
      target_id TEXT PRIMARY KEY,
      policy_epoch INTEGER NOT NULL CHECK (policy_epoch > 0),
      policy_version TEXT NOT NULL,
      policy_json TEXT NOT NULL CHECK (length(CAST(policy_json AS BLOB)) <= 32768),
      policy_checksum TEXT NOT NULL CHECK (length(policy_checksum) = 64),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE target_run_start_claims (
      request_id TEXT PRIMARY KEY REFERENCES target_run_requests(request_id) ON DELETE RESTRICT,
      run_id TEXT NOT NULL UNIQUE,
      target_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      owner_id TEXT,
      claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 0),
      lease_until TEXT,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'claimed', 'started')),
      CHECK (
        (state IN ('reserved', 'started') AND owner_id IS NULL AND lease_until IS NULL)
        OR (state = 'claimed' AND owner_id IS NOT NULL AND lease_until IS NOT NULL AND claim_epoch > 0)
      )
    );
    CREATE INDEX target_run_start_claims_lease ON target_run_start_claims(state, lease_until);
    INSERT INTO target_run_start_claims(request_id, run_id, target_id, request_digest, owner_id, claim_epoch, lease_until, state)
      SELECT request_id, run_id, target_id, request_digest, NULL, 0, NULL, 'reserved'
      FROM target_run_requests;
  `,
] as const;

export function migrateSqlite(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) throw new Error(`SQLite schema version ${current} is newer than supported ${MIGRATIONS.length}`);
  // Preflight before *any* version upgrade. A failed capability check never
  // creates memory tables or advances the original database's user_version.
  if (current < 5) {
    database.exec("CREATE VIRTUAL TABLE temp.diagnostic_memory_fts5_probe USING fts5(tokens, tokenize='unicode61')");
    database.exec('DROP TABLE temp.diagnostic_memory_fts5_probe');
  }
  for (let version = current + 1; version <= MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version - 1];
    if (sql === undefined) throw new Error(`Missing SQLite migration ${version}`);
    database.transaction(() => {
      database.exec(sql);
      database.pragma(`user_version = ${version}`);
    })();
  }
}
