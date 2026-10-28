/**
 * Column layouts of the three private databases, copied from private-backend/Schemas.gs (PRIVATE_DB_SCHEMAS) so that this project is
 * self-contained: it does not call, import or depend on any function of the private backend. Tab names and header names only; no data.
 *
 * Keep in step with private-backend/Schemas.gs. If a header is added there, add it here before the next backup, otherwise the backup refuses
 * (source_not_ready) rather than copying a layout it has not been told about. Drift check: compare this object with
 * PRIVATE_DB_SCHEMAS[db][tab].columns for every tab (the Task 41 mocked check did this: all 22 tabs matched).
 */
var BACKUP_DB_SCHEMAS = {
  AUTH_DB: {
    users: [
      'user_id', 'username', 'username_lower', 'full_name', 'email', 'email_canonical', 'email_verified_at', 'google_sub', 'status', 'role', 'consent_version', 'consent_at', 'created_at', 'last_login_at'
    ],
    credentials: [
      'user_id', 'pw_hash', 'pw_salt', 'pw_scheme', 'pepper_version', 'password_changed_at'
    ],
    otps: [
      'otp_id', 'purpose', 'email_canonical', 'code_hmac', 'created_at', 'expires_at', 'attempts', 'status', 'used_at'
    ],
    sessions: [
      'session_id', 'user_id', 'token_hmac', 'created_at', 'last_seen_at', 'expires_at', 'idle_expires_at', 'remember', 'revoked_at', 'revoked_reason'
    ],
    rate_limits: [
      'key_hmac', 'scope', 'window_start', 'count', 'blocked_until'
    ],
    audit_logs: [
      'ts', 'event', 'user_id', 'target_id', 'result', 'detail'
    ]
  },
  EXAM_DB: {
    questions: [
      'question_id', 'type', 'marks', 'branch', 'year', 'subject', 'topic', 'text', 'options_json', 'source_ref', 'status', 'content_hash', 'license_ref', 'question_version'
    ],
    attempts: [
      'attempt_id', 'user_id', 'mode', 'filters_json', 'question_count', 'total_marks', 'duration_seconds', 'started_at', 'deadline_at', 'status', 'submitted_at', 'score', 'rules_version', 'request_id', 'last_seq', 'answers_hash', 'closed_at', 'close_reason', 'profile_set', 'paper_id'
    ],
    attempt_questions: [
      'attempt_id', 'position', 'question_id', 'question_version', 'marks'
    ],
    answers: [
      'attempt_id', 'question_id', 'response_json', 'review_flag', 'seq', 'saved_at', 'correct', 'awarded_marks'
    ],
    bookmarks: [
      'user_id', 'question_id', 'created_at'
    ],
    config: [
      'config_key', 'config_version', 'value_json', 'status', 'created_at', 'created_by', 'supersedes_version', 'note'
    ],
    results: [
      'result_id', 'attempt_id', 'user_id', 'score_revision', 'status', 'total_num', 'total_den', 'max_marks', 'profile_set', 'key_set_digest', 'item_count', 'created_at', 'supersedes_result_id'
    ],
    result_items: [
      'result_id', 'question_id', 'outcome', 'awarded_num', 'awarded_den', 'key_id', 'key_revision', 'flags'
    ],
    papers: [
      'paper_id', 'year', 'paper_code', 'session', 'title', 'status', 'question_count', 'membership_digest', 'created_at', 'created_by'
    ],
    paper_questions: [
      'paper_id', 'position', 'question_id'
    ],
    question_imports: [
      'import_id', 'imported_at', 'catalogue_version', 'schema_version', 'question_count', 'new_versions', 'promoted', 'unchanged', 'withdrawn', 'license_ref'
    ]
  },
  KEYS_DB: {
    key_sets: [
      'key_set_id', 'batch_id', 'paper_id', 'year', 'paper_code', 'session', 'profile_id', 'profile_version', 'item_count', 'source_name', 'source_url', 'source_sha256', 'source_stage', 'entered_by', 'verified_by', 'approved_by', 'approved_at', 'key_set_digest'
    ],
    answer_keys: [
      'key_id', 'key_set_id', 'paper_id', 'year', 'paper_code', 'session', 'question_id', 'question_version', 'content_hash', 'master_qno', 'section', 'type', 'marks', 'key_kind', 'mcq_answer', 'msq_answers', 'nat_lo', 'nat_hi', 'nat_lo_inclusive', 'nat_hi_inclusive', 'nat_scale', 'nat_source_form', 'profile_id', 'profile_version', 'source_name', 'source_url', 'source_sha256', 'source_retrieved_at', 'source_published_at', 'source_stage', 'entered_by', 'verified_by', 'entry_method', 'revision', 'supersedes_key_id', 'status', 'dispute_state', 'approved_at', 'approved_by', 'row_mac'
    ],
    key_staging: [
      'batch_id', 'staging_row', 'paper_id', 'year', 'paper_code', 'session', 'question_id', 'question_version', 'content_hash', 'master_qno', 'section', 'type', 'marks', 'key_kind', 'mcq_answer', 'msq_answers', 'nat_lo', 'nat_hi', 'nat_lo_inclusive', 'nat_hi_inclusive', 'nat_scale', 'nat_source_form', 'profile_id', 'profile_version', 'source_name', 'source_url', 'source_sha256', 'source_retrieved_at', 'source_published_at', 'source_stage', 'entered_by', 'verified_by', 'entry_method', 'revision', 'supersedes_key_id', 'staging_status', 'staged_at', 'validated_at', 'decided_at', 'decided_by'
    ],
    key_events: [
      'event_id', 'ts', 'event_type', 'key_id', 'key_set_id', 'batch_id', 'question_id', 'question_version', 'revision', 'actor', 'reason', 'official_reference_url', 'official_reference_date', 'old_value_json', 'new_value_json', 'linked_key_id'
    ],
    explanations: [
      'explanation_id', 'question_id', 'question_version', 'explanation_text', 'source_ref', 'license_ref', 'created_at', 'created_by', 'supersedes_explanation_id'
    ]
  }
};
