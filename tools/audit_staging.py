#!/usr/bin/env python3
"""Task 50 - read-only audit of the private staging master.

Usage:  python3 tools/audit_staging.py [staging.json] [out.json]
Reads data/questions-staging-v1.json (never modifies it) and writes reports/private/staging-audit-v1.json.
The report holds counts and question IDs only - no question text, options or media references - but it is still
PRIVATE (it lists unresolved records): do not publish reports/private/. Output is deterministic (sorted, no timestamps).
"""
import collections as C, hashlib, json, sys, os

src = sys.argv[1] if len(sys.argv) > 1 else 'data/questions-staging-v1.json'
dst = sys.argv[2] if len(sys.argv) > 2 else 'reports/private/staging-audit-v1.json'
raw = open(src, 'rb').read()
doc = json.loads(raw)
qs = doc['questions']
ids = [q['id'] for q in qs]
dup_ids = sorted(i for i, n in C.Counter(ids).items() if n > 1)
srt = lambda xs: sorted(xs, key=lambda s: (len(s), s))
by = lambda pred: srt(q['id'] for q in qs if pred(q))
st = lambda s: (lambda q: q['mapping']['status'] == s)
blank = lambda q: not (q.get('text') or '').strip()
confident = [q for q in qs if q['mapping']['status'] == 'paper_year_confident' and not blank(q) and q['branch'] and q['year']]
groups = C.Counter((q['branch'], q['year'], q['variant']) for q in confident)
ANSWERISH = {'answer', 'solution', 'explanation', 'accepted', 'accepted_range', 'correct', 'correct_answer', 'key', 'raw_source', 'solution_html'}
leaky_keys = sorted({k for q in qs for k in q if k in ANSWERISH} | {k for q in qs for o in q['options'] for k in o if k in ANSWERISH})
rep = {
  'audit_version': 1,
  'source_file': src, 'source_sha256': hashlib.sha256(raw).hexdigest(),
  'dataset_kind': doc.get('dataset_kind'), 'declared_question_count': doc.get('question_count'),
  'record_count': len(qs), 'unique_id_count': len(set(ids)), 'duplicate_ids': dup_ids,
  'count_reconciliation': {
    'staging_unique_ids': len(set(ids)), 'earlier_extractor_summary_unique_ids': 15140,
    'difference_unexplained': 15140 - len(set(ids)),
    'status': 'UNRESOLVED - the audit/extractor files that would explain the 30-ID difference are not in this ZIP; no IDs were invented'},
  'by_mapping_status': dict(sorted(C.Counter(q['mapping']['status'] for q in qs).items())),
  'by_release_status': dict(sorted(C.Counter(q['release_status'] for q in qs).items())),
  'by_type': dict(sorted(C.Counter(q['type'] for q in qs).items())),
  'by_branch': dict(sorted(C.Counter(str(q['branch']) for q in qs).items())),
  'records_without_year': sum(q['year'] is None for q in qs),
  'records_without_branch': sum(not q['branch'] for q in qs),
  'public_key_check': {'answer_like_field_names_found': leaky_keys, 'note': 'field NAMES only; free text legitimately contains words such as "solution"'},
  'media': {'records_with_media_refs': sum(bool(q['media_refs']) for q in qs),
            'media_ref_fields': dict(sorted(C.Counter(r['field'] for q in qs for r in q['media_refs']).items())),
            'resolved_to_local_file': sum(r.get('resolved_relative_path') is not None for q in qs for r in q['media_refs']),
            'note': 'every media ref is an unresolved remote source path; none is a bundled file, so none may be published as an image'},
  'eligibility': {
    'official_paper_year_set_candidates': len(confident), 'official_paper_year_set_groups': len(groups),
    'largest_group': max(groups.values()), 'groups_with_set_variant': sum(1 for g in groups if g[2]),
    'topic_only_no_year_catalogue_candidates': len([q for q in qs if q['mapping']['status'] == 'paper_topic_only_no_year' and not blank(q)]),
    'review_pool_only': 'see ids.* lists'},
  'ids': {
    'ambiguous_identity_needs_review': by(st('ambiguous_identity_needs_review')),
    'generic_topic_no_paper_year': by(st('generic_topic_no_paper_year')),
    'paper_topic_only_no_year': by(st('paper_topic_only_no_year')),
    'blank_text': by(blank),
    'requires_image_review': by(lambda q: q['requires_image_review']),
    'release_status_requires_image_rendering': by(lambda q: q['release_status'] == 'REQUIRES_IMAGE_RENDERING'),
    'option_count_unusual_for_type': by(lambda q: (q['type'] == 'NAT' and q['options']) or (q['type'] in ('MCQ', 'MSQ') and len(q['options']) != 4)),
    'conflict_noted': by(lambda q: bool(q['mapping']['conflict'])),
  },
}
rep['ids'] = {k: v for k, v in rep['ids'].items()}
rep['counts_of_id_lists'] = {k: len(v) for k, v in rep['ids'].items()}
# Count only paths that resolve to a real file bundled inside this project. The staged
# `resolved_relative_path` field may contain a website URL path such as /wp-content/...;
# non-null does NOT mean the image is present locally.
project_root = os.path.realpath(os.path.join(os.path.dirname(__file__), '..'))
def bundled_file_exists(ref):
  rel = ref.get('resolved_relative_path')
  if not isinstance(rel, str) or not rel.strip():
    return False
  rel = rel.replace('\\\\', '/').lstrip('/')
  parts = rel.split('/')
  if any(p in ('', '.', '..') for p in parts):
    return False
  full = os.path.realpath(os.path.join(project_root, *parts))
  try:
    if os.path.commonpath([project_root, full]) != project_root:
      return False
  except ValueError:
    return False
  return os.path.isfile(full)
rep['media']['resolved_to_local_file'] = sum(
  1 for q in qs for r in q['media_refs'] if bundled_file_exists(r)
)
json.dump(rep, open(dst, 'w'), indent=1, sort_keys=True); open(dst, 'a').write('\n')
print(json.dumps({k: rep[k] for k in ('record_count', 'unique_id_count', 'by_mapping_status', 'counts_of_id_lists', 'eligibility', 'count_reconciliation')}, indent=1))
