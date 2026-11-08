# Changelog

## 1.2.11 (2026-11-08)

- Switched to on-demand per-tab activation via the Chrome toolbar and Alt+Shift+Q rather than injecting the full content script into every ChatGPT tab.
- Added a compact per-tab power button and five-minute safe idle sleep. Running queues, unsaved edits and in-flight saves block automatic sleep; manual OFF confirms potentially disruptive changes.
- Removed inactive tab UI, observers, injected CSS and listeners while preserving persistent queued prompts, Saved Workflows and notification preferences.
- Added a final authoritative queue refresh under the sender lock to pick up workflow steps appended at the end-of-run boundary. An observed Stop-button lifecycle is now carried across delayed receipt acknowledgement, without weakening response proof.
- Fixed mouse-wheel scroll chaining over expanded saved workflow prompts.
- Updated targeted unit and Chromium regressions, permissions, documentation, and the GitHub ZIP release workflow.


## 1.2.10 (2026-11-07)

- Made desktop/completion/automatic-stop notification settings obvious with ON/OFF switches, descriptions and Saved/Save failed feedback.
- Extended locally generated custom sound duration to Play Once or 1–60 seconds; added adjustable volume from 0% to 100%.
- Reused at most two oscillator/gain pairs per tone even for 60-second audio, with bounded timer and full cleanup; retained one active player and no idle polling.
- Added short Test sound and silent Test notification actions without touching queue execution.
- Preserved existing notification opt-outs, run-ID deduplication, Web Locks, New Chat/Project safety, and the installed extension storage key.
- Updated tests, documented ChromeOS limitations and built a versioned GitHub release workflow.

## 1.2.9 (2026-11-07)

- Moved the Saved Workflow Expand/Collapse action to a compact, accessible chevron at the left of each workflow name.
- Added a compact Notification Settings view in the floating window with Back navigation and retained Queue/Workflows state.
- Added persistent, cross-tab preferences for desktop notifications, verified success, automatic interruption, sound, custom sound duration and popup visibility.
- Added three original, locally generated Web Audio tones with optional once/5/10/20-second bounded playback and a Test Sound action.
- Used Chrome's Offscreen API only for optional sound; no always-running audio page, new backend, external assets, telemetry or additional queue polling.
- Preserved all v1.2.8 run-ID deduplication, sender ownership, manual Pause silence and conservative receipt/response checks.
- Expanded unit and simulated Chromium tests; added `offscreen` permission and audio files to the release package.
- Chrome/OS may suppress notifications or audio; `requireInteraction` is best effort and does not provide exact banner timeout control.

## 1.2.8 (2026-11-07)

- Added native Chrome desktop notifications for a successfully verified full run and for unexpected automatic pauses requiring manual review.
- Counted only completed queue mutations, including the first response of New Chat/Project handoffs, and labeled mixed-source queues accurately.
- Kept user Pause, manual ChatGPT Stop, rejected lock attempts and Load-only actions silent.
- Registered tiny per-tab run records in session-scoped storage to prevent duplicate alerts across service-worker restarts and detect Chrome Memory Saver tab discards.
- Added notification click routing to an existing ChatGPT tab; never opens a new tab without an explicit user action.
- Added focused worker and simulated Chromium tests, updated notification permission disclosures and packaged v1.2.8 release assets.
- No changes to queue storage schema, Web Locks, receipt/response verification, polling frequency, background servers or telemetry.
- Desktop notification delivery depends on Chrome/OS settings; live account and Chromebook performance remain unmeasured.

## 1.2.7 (2026-11-07)

- Kept Saved Workflows visible after both Start Workflow and + Load, preserving the active tab, search, step expansion and scroll without altering queue execution.
- Added an Alt+Shift+Q Chrome Commands shortcut to open/close the floating panel on the active ChatGPT tab, with safe no-receiver behavior and Chrome shortcut reassignment.
- Made Recent Activity collapsed by default, with accessible expansion and bounded Current/Previous previews that update when viewed.
- Reduced idle MutationObserver processing and avoided regenerating hidden queue/workflow lists; route changes invalidate the queue render cache.
- Retained existing Web Locks, local storage records, sequential sending, New Chat/Project migration, conservative send receipts and response-completion conditions.
- Expanded browser and worker regression tests for shortcut routing, view retention, deferred rendering and activity disclosure.
- Updated documentation, upgrade checklist and versioned illustrative screenshots for v1.2.7. Real-account and Chromebook memory/performance measurements remain outstanding.

## 1.2.6 (2026-11-06)

- Added live status and remaining-pending count to the floating Queue dock; excludes the currently active prompt while displaying Running.
- Added conservative Starting, Loading, Check status and Unavailable states so sender-lock refusal, remote tabs and route changes do not falsely display Running or Idle.
- Added collapsed-by-default Saved Workflows with numbered, individually copyable full prompt steps.
- Reused existing clipboard feedback and preserved workflow expansion across queue status changes without unnecessary list re-renders.
- Added targeted simulated browser coverage for status transitions, workflow display and copying, Project navigation, sender-lock refusal and draggable-panel layout.
- Kept the current queue/coordinator storage schema, permissions and conservative response verification unchanged.
- Updated the v1.2.6 release workflow, installation package, checksum, upgrade documentation and illustrative UI mockups.
- Live ChatGPT account compatibility and Chromebook resource usage remain to be verified.


## 1.2.5 (2026-11-06)

- Enabled + Load, Start Workflow and ordinary Queue Start on supported ChatGPT Project landing pages.
- Separated temporary queue identifiers per Project while preserving existing New Chat queues and first-send migration.
- Strengthened route validation during navigation and prevented stale asynchronous route loads from resetting the active page state.
- Added a Copy button to each pending, sending and awaiting-response prompt, copying the full text without changing queue or sending state.
- Added simulated Chromium regression tests for Project routing, queue isolation, first-send handoff and clipboard behavior.
- Updated the v1.2.5 GitHub release ZIP, checksum, installation guidance and illustrative screenshots.
- Live ChatGPT Project composer compatibility and Chromebook resource use remain to be verified.

## 1.2.4 (2026-11-06)

- Improved active Send-button selection and readiness checks.
- Added pre-send user-turn baselines and strengthened receipt verification so re-rendered historical messages do not count as a new sent prompt.
- A matching unsent draft blocks false receipt confirmation; ignored clicks pause safely instead of incorrectly advancing to Awaiting response.
- Preserved the single-send attempt, manual recovery, New Chat first-turn handling, Saved Workflows and existing local storage format.
- Added simulated Chromium regression coverage for consecutive identical prompts and an ignored Send click.
- Updated installation ZIP, SHA-256 release packaging, documentation, upgrade checklist and illustrative UI screenshots.
- Real-account ChatGPT compatibility remains unverified.

## 1.2.3 (2026-11-01)

- Added a compact Current / Previous activity strip shared by Queue and Workflows views.
- Retained workflow ID, name and step number on queued prompts, including Load and New Chat transitions.
- Persisted one bounded last-completed prompt preview per conversation in the existing atomic queue record.
- Preserved conservative completion confirmation, manual recovery, storage idempotency and multi-tab synchronization.
- Updated local storage privacy disclosure, upgrade guidance and regression coverage.
- Added the v1.2.3 release-packaging workflow, ZIP/SHA-256 assets and refreshed illustrative UI screenshots.

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
