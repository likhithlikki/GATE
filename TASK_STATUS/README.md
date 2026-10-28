# Task status and continuation instructions

This folder exists so task progress survives ZIP handoffs and context changes between AI sessions.

- `COMPLETED/TASKS_01-49.md`: carried-forward completed-task register; Task 48/49 details and caveats included.
- `COMPLETED/TASKS_50-54.md`: baseline/data release checkpoint evidence and remaining owner gate.
- `PENDING/ACTIVE_BUILD_TASKS_50-59.md`: active implementation sprint. Task 57 is implemented in source but remains operationally blocked until owner approvals, private Script Properties, a real Sheets header migration, an approved key set, and live GAS checks are completed. Task 58 auth safeguards are implemented in source, but live auth also requires owner endpoint/property configuration.
- `PENDING/DEFERRED_TASKS_60-65.md`: future production-hardening tasks the owner explicitly does not want done now.
- `TASK_BOARD.json`: machine-readable status snapshot.
- `NEXT_AI_TASK.md` at project root: copy-ready Task 59 package/deployment prompt. Task 57 remains the runtime activation blocker; source-level Task 58 work was continued per the owner's instruction, without enabling gates or claiming live auth.
- `REFERENCES/ORIGINAL_PRODUCTION_ROADMAP_TASKS_50-65.md`: prior detailed roadmap retained for context; the active build priority in this handoff supersedes its execution order.

## Required update rule for each AI/task session

1. Inspect the complete ZIP as the only source of truth before editing.
2. Implement the actual requested code change rather than returning only a plan.
3. Before delivering a ZIP, update `TASK_BOARD.json`, the relevant completed/pending file, and `NEXT_AI_TASK.md` with the new task, current status and next action.
4. Keep the whole project and every existing file. Never replace the project with a minimal reconstruction.
5. Mark a task complete only for code actually implemented. Record tests as passed, failed, or not run truthfully. Do not mark owner-only deployment/configuration as done until it really is.
6. Always return the updated complete ZIP after a task checkpoint.
