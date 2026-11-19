# Privacy Policy — Queued for ChatGPT

**Last updated:** 19 November 2026  
**Publisher:** Helobym Networking (Malaysia)

Queued for ChatGPT is a browser extension that helps users save prompt workflows and send queued prompts through ChatGPT. It is an independent project and is not affiliated with OpenAI.

## What the extension stores

The extension stores queued prompts, saved workflows, queue status, conversation identifiers, and interface preferences in Chrome's local extension storage. It also retains one short preview (up to 160 characters) of the most recently verified completed prompt per conversation, its completion time, and workflow origin when available. It may retain temporary conversation identifiers and panel positioning in tab-local storage. The idle turn-off duration is shared between active tabs. Earlier versions stored desktop-notification preferences and short-lived notification run metadata; v1.2.18 no longer reads, updates, or uses these historical records. Older Favorites records may remain stored for backup. The extension does not create a separate assistant-response archive.

This information stays in your browser profile. **Helobym Networking does not operate a server that receives it.** The extension does not use advertising trackers, analytics, or telemetry.

## When prompts are sent

When you click **Start** or **Start Workflow**, the extension submits your selected prompts to ChatGPT through the ChatGPT website. The **+ Load** button only appends prompts to the local queue and does not start a stopped queue; if that queue is already running, its existing sender will eventually submit the newly loaded prompts automatically. It also reads relevant ChatGPT page elements to check whether messages were sent and responses have finished.

Clicking **Copy** on a queued prompt or an individual saved workflow step places that prompt's full text on your device's clipboard. Copy does not send the prompt to ChatGPT or to Helobym Networking. Clipboard contents may be accessible to other applications on your device.

Version 1.2.18 no longer shows desktop notifications or plays custom notification sounds. Workflow status and safety warnings remain visible in the extension panel.

Prompt content submitted to ChatGPT is processed by OpenAI under its own terms and privacy policy. Helobym Networking does not control how OpenAI processes that content.

## Data sharing and removal

The extension does not sell or share your stored prompts with Helobym Networking or third-party advertisers. It sends prompts to ChatGPT only as part of the sending feature you activate.

You can remove queued prompts and saved workflows within the extension. **Clear** removes pending queue items but keeps the most recently completed prompt preview; to remove that saved preview and other local extension data, uninstall the extension (which normally removes its local extension storage). New version 5 workflow JSON exports contain the full saved workflow prompt text and your automatic idle turn-off duration. Older version 4 backups with notification settings remain importable; notification preferences are validated but not restored. Importing these settings requires your confirmation and updates preferences across active tabs; older workflow-only backups do not change settings. Exported JSON files remain wherever you saved them until you delete them yourself. Old Favorites exports remain separate.

## Permissions

The extension requests Chrome's **storage**, **activeTab**, and **scripting** permissions. The latter two allow an explicit toolbar click or keyboard shortcut to inject the Queue panel into the selected **https://chatgpt.com/** tab; it is not injected automatically into all pages. It does not request access to your passwords, contacts, or general browsing history.

## Questions

For questions about this policy, open an issue in the [Queued for ChatGPT GitHub repository](https://github.com/helobym/queued-for-chatgpt/issues).

We may update this policy as the extension changes. Updates will be published in this repository.
