# Changelog

## 1.2.3 (2026-11-01)

- Added a compact Current / Previous activity strip shared by Queue and Workflows views.
- Retained workflow ID, name and step number on queued prompts, including Load and New Chat transitions.
- Persisted one bounded last-completed prompt preview per conversation in the existing atomic queue record.
- Preserved conservative completion confirmation, manual recovery, storage idempotency and multi-tab synchronization.
- Updated local storage privacy disclosure, upgrade guidance and regression coverage.

## 1.2.2 (2026-11-01)

- Restored **+ Load** beside **▶ Start Workflow** for saved workflows.
- Load appends all workflow steps at the queue tail without starting an idle queue.
- If a conversation is already running, its sender continues to the loaded workflow after completing all earlier prompts; the active prompt is not interrupted or re-sent.
- Preserved atomic capacity checks, in-flight statuses, and idempotent coordinator appends.
- Improved end-of-queue handling for a Load operation already underway in the same tab.
- Added queue-order and mock-browser regression tests, refreshed docs, and prepared the v1.2.2 release.
- JavaScript syntax and coordinator checks passed; live-site/Chromebook verification remains pending.


## 1.2.1 (2026-10-31)

- Renamed saved workflow action to **▶ Start Workflow**: one click appends the entire workflow and begins sequential sending.
- Uses the existing exclusive per-conversation sender lock **before** appending, so other tabs cannot trigger an unintended workflow append.
- Requires confirmation when pending queue items would run before the chosen workflow.
- Refuses starts on uncertain in-flight items or a running queue; retains conservative completion checking.
- Keeps New Chat compatibility, workflow editing, backups, data, multi-tab behavior and movable floating panel.
- Passed Node tests and simulated Chromium regression and safety tests; live Chromebook verification remains pending.

## 1.2.0 (2026-10-31)

- **Replaced user-facing Favorites with Saved Queue Workflows**: no individual message star buttons or Favorites tab.
- Added saving an ordered snapshot of currently pending queue prompts under a workflow name, without altering the queue.
- Added manually creating, editing, reordering, removing, searching and loading workflows into any chat.
- Added serialized, idempotent atomic full-workflow queue append and conflict-safe edits across tabs/windows.
- Added JSON workflow import/export and separate, non-destructive backup access to legacy Favorites.
- Added conservative per-workflow and total character limits for memory/storage protection.
- Retained new-chat auto-send, latest ChatGPT app-shell completion detection and draggable panel.
- Unit, service-worker and mock-browser tests passed; live Chromebook behavior and memory footprint remain unverified.


## 1.1.4 (2026-10-31)

- Added a draggable title/header to reposition the floating Queue panel with mouse, Chromebook touchpad, or touchscreen.
- The position is kept per-tab through page refresh (session storage), not broadcast to all ChatGPT windows.
- Added a header reset-position control, arrow-key movement (Shift for faster nudge), and viewport clamping on drag/resize/open.
- Queue management, new-chat auto-continue, the combined Favorites library, and cross-tab storage remain unchanged.
- Local tests: 19 Node.js unit/integration tests and 8 mock Chromium browser workflows passed, including the new drag/persistence test. Live Chromebook validation is still required.

## 1.1.3 (2026-10-31)

- Fixed likely root cause of "Checking the first submitted prompt or reply…" on the current ChatGPT app-shell interface: older `data-message-author-role` selectors no longer match every rendered chat.
- Added both older and October 2026 app-shell user/assistant selectors, scoped to the main visible timeline when available.
- Added detection of post-response `.turn-action-controls` buttons, restricted to controls after the assistant content.
- Improved completion detection to require an actual, recently observed assistant response with stable text and a completion signal; an idle composer alone never completes a response.
- Added a manual-Stop safety pause, and new simulated browser tests for app-shell two-prompt flow and for absent completion evidence.
- Automated result: 19 Node logic/worker tests and 7 mock Chromium workflows passed; still requires live Chromebook verification.


## 1.1.2 (2026-10-31)

- Fixed false-negative first-send confirmation on new ChatGPT conversations when ChatGPT re-renders the initial user message or changes its markup.
- First send may now be verified by the creation of a new assistant reply in the just-created conversation, followed by a **separate response-completion check** before prompt 2 is sent.
- Extended first-turn confirmation deadline to handle slower first responses; no background polling or additional permissions.
- Added a second set of browser regression tests for first-turn confirmation fallback and for refusing to send prompt 2 when first-turn evidence is absent.
- Preserved in-flight queue state across upgrades; manual recovery remains required for an already-paused uncertain item.
- Automated result: 19 Node logic/worker tests and 5 mock Chromium flows passed. Live ChatGPT/Chromebook still unverified.


## 1.1.1 (2026-10-31)

- Fixed the disabled Start button on ChatGPT's New Chat page.
- Added safe first-message insertion and automatic migration from a temporary queue to the newly assigned conversation ID.
- Continues sending remaining prompts after confirming the first response in the new conversation.
- Keeps the first message marked uncertain and pauses when the new chat ID does not appear or sending cannot be verified.
- Added mock browser tests for successful new-chat creation and missing-ID failure.
- Updated help text and Chromebook test instructions.


## 1.1.0 (2026-10-31)

- Replaced per-tab whole-list writes with a single event-driven Manifest V3 service-worker coordinator.
- Implemented revisioned per-chat queues and one revisioned Favorites library.
- Added cross-tab synchronization and concurrency-safe queue operations.
- Enforced one active sender per conversation using Web Locks.
- Added manual recovery safeguards for in-flight messages, idempotent operation IDs and v1 lazy migration.
- Kept local data, combined queued/sent Favorites, no network backend, and minimal permissions.
- Tested with Node core/worker simulations and a mock ChatGPT webpage in Chromium; **not yet live-site or Chromebook memory tested**.
