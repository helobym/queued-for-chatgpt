# Queued for ChatGPT v1.2.1 — One-click Start Workflow

An unofficial, independently written, lightweight Chrome / Chromebook extension for sequential ChatGPT prompts and reusable **Saved Queue Workflows**. No Superpower dependency, login, subscription, or cloud server.

**Testing release.** The automated checks use simulated ChatGPT pages. Compatibility with your live ChatGPT account and Chromebook memory consumption are not yet verified.

## What changed from v1.2.0

- **▶ Start Workflow** replaces **+ Load to Queue** on each saved workflow.
- Clicking once **appends all workflow steps to the current conversation's queue and starts sending immediately**. It no longer requires a second click on the main Queue **Start** button.
- It works in both **New Chat** and existing ChatGPT conversations. On New Chat, the first prompt creates the conversation and the remaining workflow steps continue after a confirmed reply.
- If the current chat already has pending prompts, a confirmation explains that **existing prompts send first** and workflow steps follow. Cancelling changes nothing.
- The extension acquires the conversation's exclusive sender lock **before appending** workflow steps. If another tab owns it, nothing is appended or sent.
- If the queue contains a message whose send or response is uncertain, Start Workflow stops and asks you to review that prompt first.
- If the queue is already running in this tab, pause it before starting another workflow. Starting the same workflow repeatedly adds additional copies of its steps; be deliberate.
- A workflow is appended all-or-none; insufficient queue capacity prevents adding any steps or starting the queue.
- **Normal Queue Start remains available**, including for manually typed prompts. No other queue, storage, workflow editing, multi-tab, or floating-panel behavior was intentionally changed.

## Upgrade safely from v1.2.0

1. **Do not uninstall** v1.2.0: uninstalling may delete locally saved queues and workflows.
2. Extract `queued-for-chatgpt-v1.2.1.zip` in the Chromebook Files app.
3. Copy the new files into the **same existing unpacked extension folder**, replacing matching files. Keep the extension ID unchanged.
4. Go to `chrome://extensions`, click **Reload** on the existing **Queued for ChatGPT** card, and confirm version **1.2.1** and the same ID.
5. Refresh all open ChatGPT tabs and windows to load the updated UI.

If you've stored important workflow data, export it from the Workflows panel before changing files. Do not install a second copy alongside the old extension.

## How to use Start Workflow

1. Open a fresh ChatGPT **New Chat** or an existing conversation.
2. Open the movable **☷ Queue** floating panel, then the **☷ Workflows** tab.
3. Create or select a saved workflow containing at least one prompt.
4. Click **▶ Start Workflow**. The view changes to **Queue** and begins automatic sequential sending.
5. Watch the first run: the next prompt sends only after the previous response is confirmed finished.

**If queued items already exist**, confirm the dialog to send those **before** the saved workflow steps, or cancel and manage the existing queue first. The extension does not silently clear, replace, or reorder existing prompts.

**If the current queue is running**, pause it before clicking a different Start Workflow. If another tab/window is already processing the same chat, the start attempt will be refused without appending. Different conversations may still have independent queues.

## Existing features retained

- New-chat first prompt, sequential auto-send, pause/resume, edit/remove/reorder, conservative receipt/completion checks, safe manual recovery.
- Shared workflow library across browser tabs and windows: save pending queue as workflow, create/edit/reorder/delete workflows, JSON import/export.
- Draggable floating panel, position reset, and per-tab position persistence.
- Old Favorites data remains in legacy storage for separate backup, but the old star/Favorites UI stays removed.
- Manifest V3, vanilla JS, local-only storage, no API key, no telemetry or external backend.

## Safety and limitations

- Auto-send only runs while its ChatGPT tab is active and the page remains available. Background suspension or tab closure may interrupt it.
- The extension does **not** treat a temporarily idle composer as proof of a completed response. Missing confirmation leads to a pause, not an automatic retry or duplicate send.
- If an item is marked sending/awaiting, inspect ChatGPT before using **✓ Done** or **↺ Retry**. Retrying may duplicate a message already sent.
- A composer draft that ChatGPT hasn't sent won't be overwritten. If an existing draft blocks sending, review it and the queued item before resuming.
- Queue limit: 100 prompts; workflow limit: 200 named workflows, maximum 100 steps per workflow. Prompt text is stored in local Chrome extension storage and may contain sensitive data.
- Under-25 MB incremental memory remains a target, not a measurement or guarantee.

## Automated tests

`node --test tests/*.test.js` — 28 unit/coordinator/background tests.

Playwright (installed Chromium, simulated page):

- `tests/smoke_workflows.py` — create/edit then directly start a saved workflow in an existing chat.
- `tests/smoke_workflow_new_chat.py` — directly start workflow on New Chat.
- `tests/smoke_workflow_direct_start_safety.py` — three safety cases: existing queue approval, lock refusal, uncertain item.
- `tests/smoke_browser.py`, `tests/smoke_new_chat.py`, `tests/smoke_app_shell.py`, `tests/smoke_draggable_panel.py` — regression scenarios.
- `tests/smoke_app_shell_uncertain.py`, `tests/smoke_first_reply_uncertain.py` — two uncertainty safeguards.

No live-site or Chromebook memory test was possible here. Begin with two harmless prompts in a new chat while watching the first run.

## Privacy policy

Queued for ChatGPT saves queues and workflows locally in your browser and submits prompts to ChatGPT when you start a queue or workflow. See our [Privacy Policy](PRIVACY.md) for details about storage, data sharing, and removal.

## License and ownership

Copyright (c) 2026 **Helobym Networking (Malaysia)**. This project is open source under the **[MIT License](LICENSE)**. You may use, modify, and redistribute the code, including commercially, provided the copyright and license notices remain intact.

The project is independently developed; no Superpower for ChatGPT code or assets were reused. It is unofficial and not affiliated with or endorsed by OpenAI or Superpower. Third-party trademarks are not licensed by MIT. Confirm the correct registered legal copyright holder and any necessary contributor rights assignments before publication.
