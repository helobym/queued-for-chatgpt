# Privacy Policy — Queued for ChatGPT

**Last updated:** 7 November 2026  
**Publisher:** Helobym Networking (Malaysia)

Queued for ChatGPT is a browser extension that helps users save prompt workflows and send queued prompts through ChatGPT. It is an independent project and is not affiliated with OpenAI.

## What the extension stores

The extension stores queued prompts, saved workflows, queue status, conversation identifiers, and interface preferences in Chrome's local extension storage. It also keeps one short preview (up to 160 characters) of the most recently confirmed completed queued prompt per conversation, plus its completion time and workflow origin when available. This is not a full prompt or response history. It may also keep temporary chat identifiers and the floating panel position in the tab's session storage. Workflow expansion and the local dock-running indicator are kept only in the current page's memory and are not added to saved queue records. Notification delivery also retains a small active-run identifier, originating tab ID, start time and short workflow name in Chrome's session-scoped extension storage; it is cleared when the run ends or the tab closes. No full prompts or assistant replies are added to notification records. Older versions' Favorites data may remain locally for backup.

This information stays in your browser profile. **Helobym Networking does not operate a server that receives it.** The extension does not use advertising trackers, analytics, or telemetry.

## When prompts are sent

When you click **Start** or **Start Workflow**, the extension submits your selected prompts to ChatGPT through the ChatGPT website. The **+ Load** button only appends prompts to the local queue and does not start a stopped queue; if that queue is already running, its existing sender will eventually submit the newly loaded prompts automatically. It also reads relevant ChatGPT page elements to check whether messages were sent and responses have finished.

Clicking **Copy** on a queued prompt or an individual saved workflow step places that prompt's full text on your device's clipboard. Copy does not send the prompt to ChatGPT or to Helobym Networking. Clipboard contents may be accessible to other applications on your device.

When a run finishes or automatically stops, the extension can display a Chrome desktop notification with a bounded workflow name, outcome and verified prompt count or failure reason. Chrome/your operating system may show this text on screen, including a lock screen. Manual Pause and deliberate Stop do not trigger the alert. Tab discard notifications are best effort, not a guarantee of recovery.

Prompt content submitted to ChatGPT is processed by OpenAI under its own terms and privacy policy. Helobym Networking does not control how OpenAI processes that content.

## Data sharing and removal

The extension does not sell or share your stored prompts with Helobym Networking or third-party advertisers. It sends prompts to ChatGPT only as part of the sending feature you activate.

You can remove queued prompts and saved workflows within the extension. **Clear** removes pending queue items but keeps the most recently completed prompt preview; to remove that saved preview and other local extension data, uninstall the extension (which normally removes its local extension storage). If you export workflows or older Favorites as JSON files, those copies remain wherever you saved them until you delete them yourself.

## Permissions

The extension requests Chrome's **storage** and **notifications** permissions and runs only on **https://chatgpt.com/** pages. It does not request access to your passwords, contacts, or general browsing history.

## Questions

For questions about this policy, open an issue in the [Queued for ChatGPT GitHub repository](https://github.com/helobym/queued-for-chatgpt/issues).

We may update this policy as the extension changes. Updates will be published in this repository.
