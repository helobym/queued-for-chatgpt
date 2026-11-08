/* Queued for ChatGPT v1.2.14 — on-demand activation, safe reactivation and notifications. */
'use strict';
importScripts('core.js', 'coordinator.js');
const C = globalThis.QFC;
const M = globalThis.QFCCoordinator;
const V1_FAVORITES = 'qfc_v1_favorites';
const V1_QUEUE_PREFIX = 'qfc_v1_queue_';
// Only small metadata is retained for active runs; never prompts or replies.
const RUN_PREFIX = 'qfc_v1_notify_run_';
const RUN_ID = /^[a-zA-Z0-9_-]{8,120}$/;
const RUN_REASONS = Object.freeze({
  response: 'Response completion could not be confirmed',
  send: 'Prompt submission could not be confirmed',
  composer: 'ChatGPT composer needs review',
  storage: 'Queue or storage state changed',
  route: 'Conversation changed during execution',
  unexpected: 'The run stopped unexpectedly',
  discarded: 'Chrome discarded the running ChatGPT tab'
});
// The fallback keeps older simulated browser environments compatible; Chrome's
// session storage survives a normal Manifest V3 service-worker restart.
const volatileRuns = new Map();
function runKey(tabId) { return RUN_PREFIX + tabId; }
async function getRun(tabId) {
  try {
    if (chrome.storage.session?.get) {
      const stored = await chrome.storage.session.get(runKey(tabId));
      if (stored[runKey(tabId)]) return stored[runKey(tabId)];
    }
  } catch (_) { /* Notifications cannot affect execution. */ }
  return volatileRuns.get(tabId) || null;
}
async function storeRun(tabId, record) {
  if (record) volatileRuns.set(tabId, record);
  else volatileRuns.delete(tabId);
  try {
    if (!chrome.storage.session) return;
    if (record) await chrome.storage.session.set({ [runKey(tabId)]: record });
    else await chrome.storage.session.remove(runKey(tabId));
  } catch (_) { /* Fallback stays valid until this worker sleeps. */ }
}
// Audio is optional. Only one offscreen document and a single in-flight
// creation promise are used even when several runs finish at the same time.
let creatingAudioDocument = null;
async function ensureAudioDocument() {
  if (!chrome.offscreen?.createDocument || !chrome.runtime?.sendMessage) return false;
  if (creatingAudioDocument) return creatingAudioDocument;
  creatingAudioDocument = (async () => {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('offscreen.html')]
      });
      if (contexts.length) return true;
    } else if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) {
      return true;
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play optional, bounded user-selected queue notification sounds.'
    });
    return true;
  })();
  try { return await creatingAudioDocument; }
  catch (_) { return false; }
  finally { creatingAudioDocument = null; }
}
async function playConfiguredSound(sound, duration, volume) {
  if (!['soft', 'double', 'alert'].includes(sound) ||
      !C.validSoundDuration(duration) || !C.validSoundVolume(volume) || volume === 0) return false;
  try {
    if (!await ensureAudioDocument()) return false;
    const result = await chrome.runtime.sendMessage({
      app: 'qfc-audio-v1', action: 'play', sound, duration, volume
    });
    return result?.played === true;
  } catch (_) { return false; }
}
// Stopping sound must never create an offscreen document.
async function stopConfiguredSound() {
  try {
    const exists = chrome.runtime.getContexts
      ? (await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [chrome.runtime.getURL('offscreen.html')]
        })).length > 0
      : (chrome.offscreen?.hasDocument ? await chrome.offscreen.hasDocument() : false);
    if (!exists) return true;
    const result = await chrome.runtime.sendMessage({ app: 'qfc-audio-v1', action: 'stop' });
    return result?.stopped === true;
  } catch (_) { return false; }
}
async function showTestNotification(tabId) {
  const settings = await getNotificationSettings();
  if (!settings?.enabled || !chrome.notifications?.create) return false;
  try {
    await chrome.notifications.create('qfc-test-' + tabId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Queued for ChatGPT — test notification',
      message: 'Notification test requested. No queue or workflow was started.',
      silent: true,
      requireInteraction: false
    });
    return true; // Requested from Chrome, not guaranteed shown by ChromeOS.
  } catch (_) { return false; }
}
async function getNotificationSettings() {
  // A failed settings read must not silently override the user's opt-out.
  try {
    const stored = await chrome.storage.local.get(C.NOTIFICATION_SETTINGS_KEY);
    return C.cleanNotificationSettings(stored[C.NOTIFICATION_SETTINGS_KEY]);
  } catch (_) { return null; }
}
async function showRunNotification(run, outcome, count, name, reason) {
  const settings = await getNotificationSettings();
  if (!settings?.enabled || !chrome.notifications?.create ||
      (outcome === 'success' && !settings.onSuccess) ||
      (outcome !== 'success' && !settings.onInterrupted)) return;
  const workflowName = C.validWorkflowName(name) ? name.trim() : '';
  const suffix = workflowName ? ' · ' + workflowName : '';
  const title = outcome === 'success'
    ? (workflowName ? 'Workflow completed successfully' : 'Queue completed successfully')
    : (workflowName ? 'Workflow stopped — action required' : 'Queue stopped — action required');
  const detail = outcome === 'success'
    ? 'All ' + count + (count === 1 ? ' prompt finished' : ' prompts finished')
    : RUN_REASONS[reason] || RUN_REASONS.unexpected;
  const progress = outcome !== 'success' && reason !== 'discarded' && count > 0
    ? ' · ' + count + ' verified' : '';
  const iconUrl = chrome.runtime.getURL
    ? chrome.runtime.getURL('icons/icon128.png') : 'icons/icon128.png';
  const custom = ['soft', 'double', 'alert'].includes(settings.sound);
  try {
    await chrome.notifications.create('qfc-run-' + run.tabId + '-' + run.runId, {
      type: 'basic', iconUrl, title,
      message: (detail + progress + suffix).slice(0, 250),
      silent: custom || settings.sound === 'silent',
      requireInteraction: settings.visibility === 'persistent'
    });
    // Do not await playback in the serialized queue coordinator. The audio
    // document owns its own bounded timer and audio resources.
    if (custom && settings.soundVolume > 0)
      void playConfiguredSound(settings.sound, settings.soundDuration, settings.soundVolume);
  } catch (_) { /* User/OS may block notifications. */ }
}

async function runLifecycle(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isSafeInteger(tabId) || tabId < 0 || !RUN_ID.test(message.runId))
    return { accepted: false };
  const action = message.action;
  if (!['start', 'success', 'interrupted', 'manual'].includes(action))
    return { accepted: false };
  if (action === 'start') {
    const name = C.validWorkflowName(message.workflowName)
      ? message.workflowName.trim() : '';
    const existing = await getRun(tabId);
    if (existing?.runId === message.runId) return { accepted: true };
    await storeRun(tabId, { tabId, runId: message.runId, workflowName: name, startedAt: Date.now() });
    return { accepted: true };
  }
  const run = await getRun(tabId);
  if (!run || run.runId !== message.runId) return { accepted: false };
  // Clear first: duplicates, tab discard and service-worker restarts cannot
  // display multiple terminal notifications for the same run.
  await storeRun(tabId, null);
  const count = Number.isSafeInteger(message.verifiedCount) &&
    message.verifiedCount >= 0 && message.verifiedCount <= 1000000
    ? message.verifiedCount : 0;
  const name = typeof message.workflowName === 'string'
    ? (C.validWorkflowName(message.workflowName) ? message.workflowName.trim() : '')
    : run.workflowName;
  if (action === 'success' && count > 0)
    await showRunNotification(run, 'success', count, name, '');
  else if (action === 'interrupted')
    await showRunNotification(run, 'interrupted', count, name,
      Object.hasOwn(RUN_REASONS, message.reason) ? message.reason : 'unexpected');
  return { accepted: true };
}
// This chain is process-local only: no durable state relies on the worker staying alive.
let writes = Promise.resolve();
function serialized(fn) {
  const run = writes.catch(() => {}).then(fn);
  writes = run.catch(() => {});
  return run;
}
function checkRoute(route) { return C.queueKey(route); }
function legacyItems(value, kind) {
  const items = Array.isArray(value) ? value : value?.items;
  return kind === 'favorites' ? C.cleanFavorites(items) : C.cleanQueue(items);
}
async function load(kind, route) {
  const key = kind === 'favorites' ? C.FAV_KEY : kind === 'workflows' ? C.WORKFLOWS_KEY : checkRoute(route);
  const legacyKey = kind === 'favorites' ? V1_FAVORITES : kind === 'workflows' ? null : V1_QUEUE_PREFIX + route;
  const stored = await chrome.storage.local.get(legacyKey ? [key, legacyKey] : [key]);
  if (stored[key] !== undefined) return M.clean(stored[key], kind);
  const rec = M.record(legacyKey ? legacyItems(stored[legacyKey], kind) : []);
  await chrome.storage.local.set({ [key]: rec });
  return rec;
}
async function mutate(kind, route, operationId, mutation) {
  const key = kind === 'favorites' ? C.FAV_KEY : kind === 'workflows' ? C.WORKFLOWS_KEY : checkRoute(route);
  const previous = await load(kind, route);
  const result = M.transact(previous, kind, mutation, operationId);
  if (!result.duplicate) await chrome.storage.local.set({ [key]: result.record });
  return result.record;
}
async function moveTemp(source, destination, operationId) {
  if (!/^new:[a-zA-Z0-9_-]+$/.test(source || '') || !/^chat:[a-zA-Z0-9_-]+$/.test(destination || '')) throw new Error('Invalid temporary-chat transition.');
  const from = await load('queue', source), to = await load('queue', destination);
  if (to.ops.includes(operationId)) {
    // Previous attempt may have saved the target but stopped before clearing source.
    // Only clear items verified present in the target; leave any unmatched prompts intact.
    const targetIds = new Set(to.items.map(item => item.id));
    const remaining = from.items.filter(item => !targetIds.has(item.id));
    if (remaining.length !== from.items.length) {
      await chrome.storage.local.set({ [C.queueKey(source)]: M.record(remaining, from.rev + 1, [...from.ops, operationId].slice(-80)) });
    }
    return to;
  }
  const existing = new Set(to.items.map(q => q.id));
  const additions = from.items.filter(q => !existing.has(q.id));
  if (to.items.length + additions.length > C.MAX_QUEUE) throw new Error('Target queue is full; temporary prompts were not moved.');
  // Write destination FIRST. If the worker stops between writes, replay deduplicates by ID.
  const lastCompleted = [to.lastCompleted, from.lastCompleted]
    .filter(Boolean).sort((a, b) => b.completedAt - a.completedAt)[0] || null;
  const merged = M.record([...to.items, ...additions], to.rev + 1,
    [...to.ops, operationId].slice(-80), lastCompleted);
  await chrome.storage.local.set({ [C.queueKey(destination)]: merged });
  await chrome.storage.local.set({ [C.queueKey(source)]: M.record([], from.rev + 1, [...from.ops, operationId].slice(-80)) });
  return merged;
}
async function snapshotWorkflow(route, name, operationId) {
  const existing = await load('workflows');
  if (existing.ops.includes(operationId)) return existing;
  // The coordinator serializes both queue and workflow operations. Snapshot the
  // currently pending prompts here, not from a potentially stale tab copy.
  const source = await load('queue', route);
  const steps = source.items.filter(item => item.status === 'pending').map(item => item.text);
  if (!steps.length) throw new Error('No pending prompts to save as a workflow.');
  return mutate('workflows', null, operationId, {type: 'create', name, steps});
}
async function appendWorkflow(route, workflowId, operationId) {
  const existingQueue = await load('queue', route);
  if (existingQueue.ops.includes(operationId)) return existingQueue;
  const rec = await load('workflows');
  const workflow = rec.items.find(w => w.id === workflowId);
  if (!workflow) throw new Error('Workflow no longer exists. Reload the list.');
  return mutate('queue', route, operationId, {type: 'addMany', steps: workflow.steps,
    workflow: {id: workflow.id, name: workflow.name}});
}
async function exportLegacyFavorites() {
  const stored = await chrome.storage.local.get([C.FAV_KEY, V1_FAVORITES]);
  return {app: 'Queued for ChatGPT', kind: 'legacy-favorites',
    exportedAt: new Date().toISOString(),
    favorites: legacyItems(stored[C.FAV_KEY] ?? stored[V1_FAVORITES], 'favorites')};
}
function allowedSender(sender) {
  try {
    const url = new URL(sender.url || '');
    return sender.id === chrome.runtime.id && sender.frameId === 0 && url.protocol === 'https:' && url.hostname === 'chatgpt.com';
  } catch (_) { return false; }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!allowedSender(sender) || !message || message.app !== 'qfc-v1.1') return false;
  if (message.command === 'tabClosing' || message.command === 'tabClosed') {
    const tabId = sender.tab?.id;
    if (!Number.isSafeInteger(tabId) || tabId < 0) return false;
    if (message.command === 'tabClosing') {
      // A shortcut requested during shutdown is deferred until the previous
      // content instance has removed its listeners, DOM and injection guard.
      const previous = closingTabs.get(tabId);
      closingTabs.set(tabId, { reopen: previous?.reopen === true });
      sendResponse({ ok: true, data: { closing: true } });
    } else {
      const pending = closingTabs.get(tabId);
      closingTabs.delete(tabId);
      sendResponse({ ok: true, data: { closed: true } });
      if (pending?.reopen) {
        void (async () => {
          try {
            const tab = await chrome.tabs.get(tabId);
            if (isChatGPTTab(tab?.url)) await requestTabOpening(tab);
          } catch (_) { /* The tab may have navigated or closed. */ }
        })();
      }
    }
    return false;
  }
  if (message.command === 'tabSleep') {
    const tabId = sender.tab?.id;
    if (!Number.isSafeInteger(tabId)) return false;
    void sequenceTab(tabId, async () => {
      // Never touch another tab. Failures during navigation are harmless; the
      // scoped CSS has no visible effect without #qfc-root.
      try {
        await chrome.scripting.removeCSS({ target: { tabId }, files: ['content.css'] });
      } catch (_) {}
      return { asleep: true };
    }).then(data => sendResponse({ ok: true, data }),
      error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  serialized(async () => {
    if (message.command === 'runLifecycle') return runLifecycle(message, sender);
    if (message.command === 'getShortcut') {
      if (!chrome.commands?.getAll) return { supported: false, shortcut: '' };
      const commands = await chrome.commands.getAll();
      const assigned = commands.find(item => item.name === 'toggle-queue-panel');
      return { supported: Boolean(assigned), shortcut: typeof assigned?.shortcut === 'string' ? assigned.shortcut : '' };
    }
    if (message.command === 'openShortcutSettings') {
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      return { opened: true };
    }
    if (message.command === 'notificationPermission')
      return chrome.notifications?.getPermissionLevel
        ? chrome.notifications.getPermissionLevel() : 'unavailable';
    if (message.command === 'previewSound')
      return { played: await playConfiguredSound(message.sound, message.duration, message.volume) };
    if (message.command === 'stopSound')
      return { stopped: await stopConfiguredSound() };
    if (message.command === 'testNotification')
      return { requested: await showTestNotification(sender.tab.id) };
    if (message.command === 'getQueue') return load('queue', message.route);
    if (message.command === 'getFavorites') return load('favorites');
    if (message.command === 'getWorkflows') return load('workflows');
    if (message.command === 'workflows') return mutate('workflows', null, message.operationId, message.mutation);
    if (message.command === 'saveQueueWorkflow') return snapshotWorkflow(message.route, message.name, message.operationId);
    if (message.command === 'appendWorkflow') return appendWorkflow(message.route, message.workflowId, message.operationId);
    if (message.command === 'exportLegacyFavorites') return exportLegacyFavorites();
    if (message.command === 'queue') return mutate('queue', message.route, message.operationId, message.mutation);
    if (message.command === 'favorites') return mutate('favorites', null, message.operationId, message.mutation);
    if (message.command === 'moveTemp') return moveTemp(message.source, message.destination, message.operationId);
    throw new Error('Unknown coordinator command.');
  }).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: String(error?.message || 'Coordinator error').slice(0, 200) }));
  return true;
});


// No permanent page script, tab polling or resident wake listener.
// Chrome grants activeTab only on a user toolbar/shortcut invocation.
const closingTabs = new Map(); // Transient per-tab shutdown and deferred shortcut state.
const tabTasks = new Map();
function sequenceTab(tabId, task) {
  const prior = tabTasks.get(tabId) || Promise.resolve();
  const current = prior.catch(() => {}).then(task);
  tabTasks.set(tabId, current);
  void current.finally(() => {
    if (tabTasks.get(tabId) === current) tabTasks.delete(tabId);
  }).catch(() => {});
  return current;
}
function isChatGPTTab(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'chatgpt.com';
  } catch (_) { return false; }
}
async function sendUi(tabId, action) {
  return chrome.tabs.sendMessage(tabId, { app: 'qfc-ui-v1', action });
}
async function openOrToggleTab(tab) {
  if (!Number.isSafeInteger(tab?.id)) return;
  return sequenceTab(tab.id, async () => {
    // Command events may omit the URL. Resolve it without needing the broad tabs permission.
    let target = tab;
    if (!target.url && chrome.tabs.get) target = await chrome.tabs.get(tab.id);
    if (!isChatGPTTab(target?.url)) return;
    if (closingTabs.has(tab.id)) {
      closingTabs.get(tab.id).reopen = true;
      return;
    }
    let status = null;
    try { status = await sendUi(tab.id, 'status'); }
    catch (_) { /* A sleeping tab has no message receiver. */ }
    if (status?.closing) {
      const closing = closingTabs.get(tab.id) || { reopen: false };
      closing.reopen = true;
      closingTabs.set(tab.id, closing);
      return;
    }
    if (status?.active) {
      await sendUi(tab.id, 'toggle-panel');
      return;
    }
    // CSS is installed only for an activated tab and removed on successful sleep.
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['core.js', 'content.js']
      });
      const opened = await sendUi(tab.id, 'open-panel');
      if (!opened?.active) throw new Error('Queued did not initialize in this tab.');
    } catch (error) {
      try {
        await chrome.scripting.removeCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      } catch (_) { /* Navigation can invalidate the CSS target. */ }
      throw error;
    }
  });
}
function requestTabOpening(tab) {
  return openOrToggleTab(tab).catch(error => {
    console.warn('[Queued for ChatGPT] Could not activate selected tab.', error);
  });
}

// Chrome Commands is event-driven: no persistent worker or tab polling.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-queue-panel') return;
  try {
    const target = Number.isSafeInteger(tab?.id) ? tab :
      (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    await requestTabOpening(target);
  } catch (_) { /* Tab closed before the shortcut was delivered. */ }
});
chrome.action?.onClicked?.addListener(requestTabOpening);

// Tab lifecycle events are passive and event-driven. A loading navigation
// is not sufficient evidence of a discard; give the discarded event priority
// and clean abandoned records only when navigation completes.
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.discarded === true) {
    closingTabs.delete(tabId);
    void serialized(async () => {
      const run = await getRun(tabId);
      if (!run) return;
      await storeRun(tabId, null);
      await showRunNotification(run, 'interrupted', 0, run.workflowName, 'discarded');
    }).catch(() => {});
  } else if (changeInfo.status === 'complete' ||
             (typeof changeInfo.url === 'string' &&
              !/^https:\/\/chatgpt\.com(?:\/|$)/.test(changeInfo.url))) {
    closingTabs.delete(tabId);
    // A full navigation/reload ended the old content-script run. A New Chat
    // SPA route handoff does not trigger this cleanup.
    void serialized(() => storeRun(tabId, null)).catch(() => {});
  }
});
chrome.tabs?.onRemoved?.addListener(tabId => {
  closingTabs.delete(tabId);
  // Closing a tab is user-controlled; do not generate a false success/error.
  void serialized(() => storeRun(tabId, null)).catch(() => {});
});
chrome.notifications?.onClicked?.addListener(notificationId => {
  const match = /^qfc-run-(\d+)-[a-zA-Z0-9_-]{8,120}$/.exec(notificationId);
  if (!match) return;
  const tabId = Number(match[1]);
  void (async () => {
    try {
      // Never focus an unrelated tab if Chrome has reused a tab identifier.
      const existing = chrome.tabs.get ? await chrome.tabs.get(tabId) : null;
      if (existing?.url && !/^https:\/\/chatgpt\.com(?:\/|$)/.test(existing.url)) return;
      const tab = await chrome.tabs.update(tabId, { active: true });
      const windowId = existing?.windowId ?? tab?.windowId;
      if (Number.isSafeInteger(windowId)) await chrome.windows?.update(windowId, { focused: true });
    } catch (_) { /* The originating tab no longer exists. Never auto-open a tab. */ }
  })();
});
