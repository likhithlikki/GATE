/**
 * GATE Prep Studio PRIVATE backend: database schemas (Task 23). Schema definitions only.
 *
 * This is a standalone Apps Script project, separate from the public catalogue project in the repository root.
 * Its only web entry point is AuthRouter.gs (doPost, authentication operations; doGet refuses everything). Nothing in this file is reachable over HTTP.
 *
 * Column lists come from SECURITY_DESIGN.md section 4.2 and ANSWER_KEY_SCORING_SPEC.md sections 4.1, 4.2 and 4.6,
 * in the order recorded there. Every tab now has an explicit schema.
 *
 * Where the sources record a purpose but NOT a column layout (config, key_sets, key_staging, key_events,
 * explanations), the layout below is a CONSERVATIVE CHOICE: only fields the specifications already imply, with
 * free-text or JSON columns instead of enumerated value lists, so that no product or security decision is settled
 * by a column. Those tabs are marked "conservative layout" in comments. Extending any schema later means appending
 * columns at the END only (the migration in Setup.gs recognises an old header that is an exact prefix of the new one).
 *
 * Nothing in this file approves any open decision (password storage, OTPs, sessions, quotas, marking rules).
 */

var PRIVATE_DB_PROPERTY_KEYS = {
  AUTH_DB: 'AUTH_DB_ID',
  EXAM_DB: 'EXAM_DB_ID',
  KEYS_DB: 'KEYS_DB_ID'
};

var PRIVATE_DB_TITLES = {
  AUTH_DB: 'GATE Prep Studio AUTH_DB (private)',
  EXAM_DB: 'GATE Prep Studio EXAM_DB (private)',
  KEYS_DB: 'GATE Prep Studio KEYS_DB (private)'
};

/* Columns the answer-key spec requires to be plain text (decimals, option ids, hashes), so Sheets cannot coerce them. */
var ANSWER_KEY_COLUMNS = [
  'key_id', 'key_set_id', 'paper_id', 'year', 'paper_code', 'session', 'question_id', 'question_version',
  'content_hash', 'master_qno', 'section', 'type', 'marks', 'key_kind', 'mcq_answer', 'msq_answers', 'nat_lo',
  'nat_hi', 'nat_lo_inclusive', 'nat_hi_inclusive', 'nat_scale', 'nat_source_form', 'profile_id', 'profile_version',
  'source_name', 'source_url', 'source_sha256', 'source_retrieved_at', 'source_published_at', 'source_stage',
  'entered_by', 'verified_by', 'entry_method', 'revision', 'supersedes_key_id', 'status', 'dispute_state',
  'approved_at', 'approved_by', 'row_mac'
];

var PRIVATE_DB_SCHEMAS = {
  AUTH_DB: {
    users: { columns: ['user_id', 'username', 'username_lower', 'full_name', 'email', 'email_canonical',
      'email_verified_at', 'google_sub', 'status', 'role', 'consent_version', 'consent_at', 'created_at', 'last_login_at'] },
      /* Profile fields (branch, target_exam_year) are recorded as "not yet defined by the owner": not created here. */
    credentials: { columns: ['user_id', 'pw_hash', 'pw_salt', 'pw_scheme', 'pepper_version', 'password_changed_at'] },
    otps: { columns: ['otp_id', 'purpose', 'email_canonical', 'code_hmac', 'created_at', 'expires_at', 'attempts', 'status', 'used_at'] },
    sessions: { columns: ['session_id', 'user_id', 'token_hmac', 'created_at', 'last_seen_at', 'expires_at',
      'idle_expires_at', 'remember', 'revoked_at', 'revoked_reason'] },
    rate_limits: { columns: ['key_hmac', 'scope', 'window_start', 'count', 'blocked_until'] },
    audit_logs: { columns: ['ts', 'event', 'user_id', 'target_id', 'result', 'detail'] }
  },
  EXAM_DB: {
    questions: { columns: ['question_id', 'type', 'marks', 'branch', 'year', 'subject', 'topic', 'text', 'options_json',
      'source_ref', 'status', 'content_hash', 'license_ref', 'question_version'], textColumns: ['content_hash'] },
      /* question_version is appended at the END (the answer-key spec pins it, the questions list omitted it). Existing order unchanged. */
    attempts: { columns: ['attempt_id', 'user_id', 'mode', 'filters_json', 'question_count', 'total_marks', 'duration_seconds',
      'started_at', 'deadline_at', 'status', 'submitted_at', 'score', 'rules_version', 'request_id', 'last_seq',
      'answers_hash', 'closed_at', 'close_reason', 'profile_set', 'paper_id', 'key_set_id', 'key_set_digest'], textColumns: ['paper_id', 'key_set_id', 'key_set_digest'] },
      /* paper_id (Task 29), then key_set_id/key_set_digest (Task 57) are appended at the END: scoring uses a server-pinned immutable
       * approved key-set identity/digest captured at attempt start. Existing attempts with blank pins cannot be scored; they are never
       * retroactively assigned the current key set. Run migratePrivateDatabaseHeaders() before enabling the private project. */
    attempt_questions: { columns: ['attempt_id', 'position', 'question_id', 'question_version', 'marks'] },
    answers: { columns: ['attempt_id', 'question_id', 'response_json', 'review_flag', 'seq', 'saved_at', 'correct', 'awarded_marks'] },
    bookmarks: { columns: ['user_id', 'question_id', 'created_at'] },
    /* Conservative layout: a generic, versioned configuration record. It can hold a future `marking_rules` record
     * (config_key = 'marking_rules'; attempts.rules_version pins config_version). value_json is opaque here: no
     * marking-rule values are defined and no status values are enumerated. */
    config: { columns: ['config_key', 'config_version', 'value_json', 'status', 'created_at', 'created_by', 'supersedes_version', 'note'] },
    /* ANSWER_KEY_SCORING_SPEC.md 4.6. Fractions are two integer columns (num/den), never decimals. */
    results: { columns: ['result_id', 'attempt_id', 'user_id', 'score_revision', 'status', 'total_num', 'total_den', 'max_marks',
      'profile_set', 'key_set_digest', 'item_count', 'created_at', 'supersedes_result_id'], textColumns: ['key_set_digest'] },
    result_items: { columns: ['result_id', 'question_id', 'outcome', 'awarded_num', 'awarded_den', 'key_id', 'key_revision', 'flags'] },
    /* Task 32 (appended; existing tabs above are unchanged). The public catalogue carries NO paper identity, so a paper is an explicit,
     * owner-registered record (admin_register_paper in ExamCatalogue.gs): paper_id is supplied by the owner, never inferred. The papers row is
     * the commit marker for its paper_questions rows. Membership is immutable: changed membership needs a new paper_id (key sets are paper-bound). */
    papers: { columns: ['paper_id', 'year', 'paper_code', 'session', 'title', 'status', 'question_count', 'membership_digest', 'created_at', 'created_by'],
      textColumns: ['paper_id', 'membership_digest'] },
    paper_questions: { columns: ['paper_id', 'position', 'question_id'], textColumns: ['paper_id', 'question_id'] },
    /* One row per import that changed the repository (provenance). No answer keys, explanations or scoring metadata ever pass through it. */
    question_imports: { columns: ['import_id', 'imported_at', 'catalogue_version', 'schema_version', 'question_count', 'new_versions', 'promoted',
      'unchanged', 'withdrawn', 'license_ref'], textColumns: ['import_id', 'catalogue_version'] }
  },
  KEYS_DB: {
    /* Conservative layout (append-only; the row is the commit marker for an approved batch, spec 5.7 / 8.6).
     * Fields come from the spec: set id, batch id, paper identity, profile, source provenance, entered/verified/approved
     * by, and key_set_digest (the spec caches an approved set keyed by this digest). item_count lets a set row be
     * checked against its answer_keys rows. */
    key_sets: { columns: ['key_set_id', 'batch_id', 'paper_id', 'year', 'paper_code', 'session', 'profile_id', 'profile_version',
      'item_count', 'source_name', 'source_url', 'source_sha256', 'source_stage', 'entered_by', 'verified_by', 'approved_by',
      'approved_at', 'key_set_digest'], textColumns: ['key_set_id', 'batch_id', 'source_sha256', 'key_set_digest'] },
    answer_keys: { columns: ANSWER_KEY_COLUMNS,
      textColumns: ['key_id', 'key_set_id', 'question_id', 'content_hash', 'mcq_answer', 'msq_answers', 'nat_lo', 'nat_hi',
        'source_sha256', 'supersedes_key_id', 'row_mac'] },
    /* Conservative layout (mutable until approved or rejected): batch_id (unique per import) and the row position in the
     * batch, then the answer_keys fields a staged row can carry. Fields assigned only at approval (key_id, key_set_id,
     * status, dispute_state, approved_at, approved_by, row_mac) are NOT here. staging_status is free text. Validation
     * reports belong elsewhere: they must never hold key values. */
    key_staging: { columns: ['batch_id', 'staging_row', 'paper_id', 'year', 'paper_code', 'session', 'question_id', 'question_version',
      'content_hash', 'master_qno', 'section', 'type', 'marks', 'key_kind', 'mcq_answer', 'msq_answers', 'nat_lo', 'nat_hi',
      'nat_lo_inclusive', 'nat_hi_inclusive', 'nat_scale', 'nat_source_form', 'profile_id', 'profile_version', 'source_name',
      'source_url', 'source_sha256', 'source_retrieved_at', 'source_published_at', 'source_stage', 'entered_by', 'verified_by',
      'entry_method', 'revision', 'supersedes_key_id', 'staging_status', 'staged_at', 'validated_at', 'decided_at', 'decided_by'],
      textColumns: ['batch_id', 'question_id', 'content_hash', 'mcq_answer', 'msq_answers', 'nat_lo', 'nat_hi', 'source_sha256', 'supersedes_key_id'] },
    /* Conservative layout (append-only by convention). Spec 4.5: each event stores who, when, reason, official reference
     * (URL, notice date if any) and old and new values (these stay inside KEYS_DB). event_type is free text (approved,
     * superseded, withdrawn, disputed, corrected are named in the spec; not enumerated here). linked_key_id is the
     * "superseded event linking to the new one". */
    key_events: { columns: ['event_id', 'ts', 'event_type', 'key_id', 'key_set_id', 'batch_id', 'question_id', 'question_version',
      'revision', 'actor', 'reason', 'official_reference_url', 'official_reference_date', 'old_value_json', 'new_value_json',
      'linked_key_id'], textColumns: ['event_id', 'key_id', 'key_set_id', 'batch_id', 'linked_key_id'] },
    /* Conservative layout (append-only). Explanation text per question VERSION, with the source and licence references
     * AK-08 / D-07 / D-18 leave open. Defining this tab does NOT approve showing explanations to candidates. */
    explanations: { columns: ['explanation_id', 'question_id', 'question_version', 'explanation_text', 'source_ref', 'license_ref',
      'created_at', 'created_by', 'supersedes_explanation_id'], textColumns: ['explanation_id', 'supersedes_explanation_id'] }
  }
};
