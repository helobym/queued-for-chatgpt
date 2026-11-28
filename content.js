/* Queued for ChatGPT v1.2.21 — opt-in completion alarm. */
(() => {
  'use strict';
  if (globalThis.__qfcContentLoaded || !globalThis.QFC || !chrome?.storage?.local) return;
  const C = globalThis.QFC;
  const STORAGE = chrome.storage.local;
  // Recent ChatGPT app-shell renders messages under a timeline using search-unit
  // attributes, not the legacy author-role attributes. Preserve both families.
  const USER_SELECTORS = [
    '[data-app-action-timeline-scroll][role="region"] [data-user-message-bubble="true"]',
    '[data-app-action-timeline-scroll][role="region"] [data-chatgpt-search-unit-key$=":user"]',
    '[data-message-author-role="user"]',
    'section[data-turn="user"], article[data-turn="user"]',
    '[data-user-message-bubble="true"]',
    '[data-chatgpt-search-unit-key$=":user"]',
    '[data-content-search-unit-key$=":user"]'
  ];
  const ASSISTANT_SELECTORS = [
    '[data-app-action-timeline-scroll][role="region"] [data-chatgpt-search-unit-key$=":assistant"]',
    '[data-app-action-timeline-scroll][role="region"] [data-content-search-unit-key$=":assistant"]',
    '[data-message-author-role="assistant"]',
    'section[data-turn="assistant"], article[data-turn="assistant"]',
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-content-search-unit-key$=":assistant"]',
    '[data-markdown-text-style="assistant-message"]',
    '[data-turn-key] [data-conversation-role="assistant"]'
  ];
  const USER_SELECTOR = USER_SELECTORS.join(', ');
  const ASSISTANT_SELECTOR = ASSISTANT_SELECTORS.join(', ');
  const STOP_SELECTORS = '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop response"]';
  const PAGE_ID = C.newQueueItem('runtime').id;
  const TEMP_SESSION_KEY = 'qfc_v1_temporary_conversation';
  // Keep distinct temporary queues for each Project while preserving ordinary New Chat storage.
  const temporaryRouteCache = new Map();
  const temporaryRouteKeys = new Map();
  const PANEL_POSITION_KEY = 'qfc_panel_position_v1';
  const state = {
    route: null, queue: [], lastCompleted: null, workflows: [], tab: 'queue', open: false,
    editingQueueId: null, workflowDraft: null,
    running: false, senderLockRoute: null, status: 'Paused', waiting: false, queueRev: -1, workflowsRev: -1,
    routeLoading: false, storageHealthy: true
  };
  let root, queueList, workflowsList, statusLine, queueTextArea, workflowSearch;
  let pageObserver, routeTimer, domWakeTimer = null, lastAssistantChange = Date.now();
  let routeLoadGeneration = 0;
  let trackingSendAttempt = false, observedStopDuringSend = false;
  let lastPathname = location.pathname;
  let tempSubmittedAt = 0;
  let navigateToExistingChat = false;
  let newChatHandoff = null;
  // UI placement is kept per browser tab, so moving the panel in Window A
  // does not move the panel in Window B. Only non-sensitive pixel offsets are saved.
  let panelOffsetX = 0, panelOffsetY = 0;
  let panelDrag = null;
  const signalListeners = new Set();
  // In-flight Load clicks must finish before an active runner decides the queue is empty.
  const pendingWorkflowLoads = new Map();
  // View-only state; never persist expanded prompt contents or runner ownership.
  const expandedWorkflowIds = new Set();
  let lastWorkflowRenderKey = null;
  let lastQueueRenderKey = null;
  // View-only disclosure: do not persist prompt details or introduce new storage keys.
  let activityExpanded = false;
  // Settings is a view within the floating window, not a new browser tab.
  // Saved workflow expansion and selected Queue/Workflows tab remain untouched.
  let settingsOpen = false;
  const ALARM_KEY = 'qfc_v1_completion_alarm';
  let alarmEnabled = false, manualAlarm = null, alarmAudio = null;
  function closeAlarmAudio() {
    const audio = alarmAudio;
    alarmAudio = null;
    if (audio) void audio.close().catch(() => {});
  }
  function playCompletionAlarm() {
    if (!alarmEnabled || disposed || disposing || alarmAudio) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      const audio = alarmAudio = new Audio();
      const oscillator = audio.createOscillator(), gain = audio.createGain();
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.08, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 1);
      oscillator.connect(gain); gain.connect(audio.destination);
      oscillator.onended = () => { if (alarmAudio === audio) closeAlarmAudio(); };
      oscillator.start(); oscillator.stop(audio.currentTime + 1);
      const timer = setTimeout(() => {
        transientTimers.delete(timer);
        if (alarmAudio === audio) closeAlarmAudio();
      }, 2000);
      transientTimers.add(timer);
      void audio.resume().catch(() => { if (alarmAudio === audio) closeAlarmAudio(); });
    } catch (_) { closeAlarmAudio(); }
  }
  function clearManualAlarm() {
    if (!manualAlarm) return;
    const attempt = manualAlarm;
    manualAlarm = null;
    attempt.observer?.disconnect();
    clearTimeout(attempt.timeout);
    clearTimeout(attempt.checkTimer);
    clearTimeout(attempt.settle);
    scheduleIdleSleep();
  }
  function armManualAlarm() {
    if (!alarmEnabled || state.running || runnerPromise || disposed || disposing) return;
    const editor = findEditor(), area = composerArea(editor);
    const text = C.normalize(editorText(editor));
    const send = findSendButton(editor);
    if (!area || !text || !send || send.disabled || send.getAttribute('aria-disabled') === 'true' || isGenerating(editor)) return;
    clearManualAlarm();
    const attempt = {
      baseline: assistantMessages().at(-1), users: snapshotUserTurns(), text,
      path: location.pathname, route: currentRoute(), receipt: false,
      observer: null, timeout: null, checkTimer: null, settle: null,
      reply: null, lastText: '', changedAt: 0
    };
    manualAlarm = attempt;
    const check = () => {
      if (manualAlarm !== attempt) return;
      if (!alarmEnabled || state.running || runnerPromise || disposed || disposing) {
        clearManualAlarm(); return;
      }
      const route = currentRoute();
      if (location.pathname !== attempt.path &&
          (attempt.route || !route)) { clearManualAlarm(); return; }
      if (!attempt.receipt && hasNewUserReceipt(attempt.text, attempt.users)) {
        attempt.receipt = true;
        if (route) { attempt.route = route; attempt.path = location.pathname; }
        // Keep no prompt text or user snapshot after receipt.
        attempt.text = ''; attempt.users = null;
        clearTimeout(attempt.timeout);
        attempt.timeout = setTimeout(clearManualAlarm, 10 * 60 * 1000);
      }
      if (attempt.receipt && !attempt.route && route) {
        attempt.route = route; attempt.path = location.pathname;
      }
      if (!attempt.receipt) return;
      if (!findEditor() || isGenerating()) {
        clearTimeout(attempt.settle); attempt.settle = null;
        attempt.reply = null; attempt.lastText = '';
        return;
      }
      const newest = assistantMessages().at(-1);
      if (!newest || newest === attempt.baseline) return;
      const response = C.normalize(assistantText(newest));
      if (!response) return;
      if (newest !== attempt.reply || response !== attempt.lastText) {
        attempt.reply = newest; attempt.lastText = response; attempt.changedAt = Date.now();
      }
      const remaining = 1700 - (Date.now() - attempt.changedAt);
      if (remaining > 0) {
        clearTimeout(attempt.settle);
        attempt.settle = setTimeout(() => { attempt.settle = null; check(); }, remaining);
        return;
      }
      if (assistantHasCompletedActions(newest)) {
        clearManualAlarm(); playCompletionAlarm();
      }
    };
    // Only active for a possible manual submission. Watch replacements and late
    // response controls as well as composer changes; coalesce mutation bursts.
    attempt.observer = new MutationObserver(records => {
      if (manualAlarm !== attempt || attempt.checkTimer !== null) return;
      if (records.every(record => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        return target?.closest?.('#qfc-root');
      })) return;
      attempt.checkTimer = setTimeout(() => { attempt.checkTimer = null; check(); }, 150);
    });
    attempt.observer.observe(document.body, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['aria-label', 'data-testid', 'd'] });
    // A keyboard shortcut or disabled submission must not hold idle shutdown.
    attempt.timeout = setTimeout(clearManualAlarm, 15000);
    scheduleIdleSleep();
  }
  function renderAlarmSetting() {
    const input = root?.querySelector('#qfc-completion-alarm');
    if (input) input.checked = alarmEnabled;
  }
  function applyAlarmSetting(value) {
    alarmEnabled = value === true;
    if (!alarmEnabled) { clearManualAlarm(); closeAlarmAudio(); }
    renderAlarmSetting();
  }
  const IDLE_SLEEP_SCALE_MS = 60 * 1000;
  let autoTurnOffMinutes = C.DEFAULT_AUTO_TURN_OFF_MINUTES;
  let confirmedAutoTurnOffMinutes = autoTurnOffMinutes;
  let autoOffRevision = 0, savedAutoOffRevision = 0;
  let autoOffWriteLoop = null, autoOffSaveStatus = 'Ready';
  let idleTimer = null, idleSince = null;
  let shortcutInfo = { status: 'unknown', value: '' }, shortcutRequest = 0;
  let disposing = false, disposed = false, initialized = false;
  let initializationReady = null, runnerPromise = null;
  let uiOperations = 0;
  const cleanupListeners = [];
  const transientTimers = new Set();
  const pendingDownloadUrls = new Set();
  function clearIdleTimer() {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }
  function hasUnsavedInput() {
    return Boolean(state.workflowDraft || state.editingQueueId ||
      C.normalize(queueTextArea?.value) ||
      C.normalize(root?.querySelector('#qfc-workflow-name')?.value));
  }
  function canSleep() {
    return initialized && autoTurnOffMinutes > 0 && !disposed && !disposing &&
      !state.running && !runnerPromise && !state.routeLoading && !uiOperations &&
      !autoOffWriteLoop && !manualAlarm &&
      !pendingWorkflowLoads.size && !hasUnsavedInput() &&
      !state.queue.some(item => item.status !== 'pending');
  }
  // Idle time accumulates only while the extension is safe to turn off.
  // A run or protected operation invalidates the old idle period.
  function scheduleIdleSleep({ reset = false } = {}) {
    clearIdleTimer();
    if (!canSleep()) { idleSince = null; return; }
    if (reset || idleSince === null) idleSince = Date.now();
    const duration = autoTurnOffMinutes * IDLE_SLEEP_SCALE_MS;
    const delay = Math.max(0, duration - (Date.now() - idleSince));
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!canSleep()) { idleSince = null; return; }
      if (Date.now() - idleSince < duration) { scheduleIdleSleep(); return; }
      void sleepTab(false);
    }, delay);
  }
  function queuedInteraction() {
    if (disposed || disposing) return;
    scheduleIdleSleep({ reset: true });
  }

  function renderAutoTurnOffSetting() {
    const select = root?.querySelector('#qfc-auto-turn-off');
    if (select) select.value = String(autoTurnOffMinutes);
    const feedback = root?.querySelector('#qfc-auto-turn-off-status');
    if (feedback) {
      feedback.textContent = autoOffSaveStatus;
      feedback.dataset.state = autoOffSaveStatus.startsWith('Save failed') ? 'error'
        : autoOffSaveStatus === 'Saved' ? 'saved' : 'neutral';
    }
  }
  async function persistAutoTurnOffMinutes() {
    if (autoOffWriteLoop) return autoOffWriteLoop;
    const loop = (async () => {
      while (savedAutoOffRevision < autoOffRevision) {
        const revision = autoOffRevision;
        const snapshot = autoTurnOffMinutes;
        try {
          // Preserve legacy and future fields of qfc_v1_settings.
          const stored = (await STORAGE.get(C.SETTINGS_KEY))[C.SETTINGS_KEY];
          const previous = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
          await STORAGE.set({ [C.SETTINGS_KEY]: { ...previous, autoTurnOffMinutes: snapshot } });
          confirmedAutoTurnOffMinutes = snapshot;
          savedAutoOffRevision = revision;
        } catch (_) {
          autoTurnOffMinutes = confirmedAutoTurnOffMinutes;
          savedAutoOffRevision = autoOffRevision;
          autoOffSaveStatus = 'Save failed — previous duration restored.';
          renderAutoTurnOffSetting();
          return;
        }
      }
      autoOffSaveStatus = 'Saved';
      renderAutoTurnOffSetting();
    })();
    autoOffWriteLoop = loop;
    try { await loop; }
    finally {
      autoOffWriteLoop = null;
      if (savedAutoOffRevision < autoOffRevision) void persistAutoTurnOffMinutes();
      else scheduleIdleSleep({ reset: true });
    }
  }
  function saveAutoTurnOffMinutes(value) {
    if (!C.validAutoTurnOffMinutes(value)) return;
    autoTurnOffMinutes = value;
    autoOffRevision++;
    autoOffSaveStatus = 'Saving…';
    renderAutoTurnOffSetting();
    void persistAutoTurnOffMinutes();
  }

  // Persist at most one settings record at a time; coalesce rapid changes and
  // avoid newer local selections being replaced by stale storage events.
  function wake() {
    for (const fn of Array.from(signalListeners)) fn();
  }
  // Coalesce DOM-triggered wakes; manual actions and storage events stay immediate.
  function queueDomWake() {
    if (domWakeTimer !== null || !signalListeners.size) return;
    domWakeTimer = setTimeout(() => {
      domWakeTimer = null;
      if (!disposed && !disposing) wake();
    }, 200);
  }
  function clearDomWake() {
    if (domWakeTimer !== null) clearTimeout(domWakeTimer);
    domWakeTimer = null;
  }
  function signalOrTimeout(ms) {
    return new Promise(resolve => {
      let timer;
      const finish = () => { clearTimeout(timer); signalListeners.delete(finish); resolve(); };
      signalListeners.add(finish);
      timer = setTimeout(finish, ms);
    });
  }
  function setStatus(message) {
    state.status = message;
    renderHeader();
    renderActivity();
  }
  function notify(message) { setStatus(message); }
  function currentRoute() { return C.conversationId(location.pathname); }
  function projectLandingId(pathname = location.pathname) {
    return String(pathname).match(/^\/g\/(g-p-[a-zA-Z0-9_-]+)\/project\/?$/)?.[1] || null;
  }
  function isNewChatPage() {
    return ['/', '/new'].includes(location.pathname) ||
      /^\/g\/g-[a-zA-Z0-9_-]+\/?$/.test(location.pathname) ||
      Boolean(projectLandingId());
  }
  function temporaryStorageKey() {
    const projectId = projectLandingId();
    return projectId ? TEMP_SESSION_KEY + '_project_' + projectId : TEMP_SESSION_KEY;
  }
  function getTemporaryRoute() {
    const key = temporaryStorageKey();
    let token;
    try { token = sessionStorage.getItem(key); } catch (_) { /* in-memory fallback */ }
    if (!/^new:[a-zA-Z0-9_-]+$/.test(token || '')) {
      token = temporaryRouteCache.get(key);
      if (!/^new:[a-zA-Z0-9_-]+$/.test(token || '')) {
        const identifier = key === TEMP_SESSION_KEY ? PAGE_ID : C.newQueueItem('runtime').id;
        token = 'new:' + identifier.replace(/[^a-zA-Z0-9_-]/g, '');
      }
      try { sessionStorage.setItem(key, token); } catch (_) { /* in-memory fallback */ }
    }
    const previous = temporaryRouteCache.get(key);
    if (previous && previous !== token) temporaryRouteKeys.delete(previous);
    temporaryRouteCache.set(key, token);
    temporaryRouteKeys.set(token, key);
    return token;
  }
  function forgetTemporaryRoute(source) {
    const key = temporaryRouteKeys.get(source);
    if (!key) return;
    try {
      if (sessionStorage.getItem(key) === source) sessionStorage.removeItem(key);
    } catch (_) { /* ignored */ }
    if (temporaryRouteCache.get(key) === source) temporaryRouteCache.delete(key);
    temporaryRouteKeys.delete(source);
  }
  function isUsableRoute(route) {
    if (typeof route !== 'string') return false;
    const stable = currentRoute();
    if (route.startsWith('chat:')) return stable === route;
    return route.startsWith('new:') && !stable && isNewChatPage() &&
      getTemporaryRoute() === route;
  }
  function makeOperationId() { return crypto.randomUUID ? crypto.randomUUID() : C.newQueueItem('op').id; }
  async function rpc(command, fields = {}, operationId) {
    const request = { app: 'qfc-v1.1', command, ...fields };
    if (operationId) request.operationId = operationId;
    // Retry the SAME operation id exactly once if a transient worker wakeup fails.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage(request);
        if (!response?.ok) throw new Error(response?.error || 'Storage coordinator unavailable.');
        return response.data;
      } catch (error) {
        if (attempt || !/message port|receiving end|extension context|coordinator unavailable/i.test(String(error.message))) throw error;
      }
    }
  }
  function applyQueue(route, record) {
    if (route !== state.route || !record || record.rev < state.queueRev) return;
    state.queueRev = record.rev;
    state.queue = C.cleanQueue(record.items);
    state.lastCompleted = C.cleanLastCompleted(record.lastCompleted);
    render(); wake(); scheduleIdleSleep();
  }
  function applyWorkflows(record) {
    if (!record || record.rev < state.workflowsRev) return;
    state.workflowsRev = record.rev;
    state.workflows = C.cleanWorkflows(record.items);
    const available = new Set(state.workflows.map(workflow => workflow.id));
    for (const id of expandedWorkflowIds) if (!available.has(id)) expandedWorkflowIds.delete(id);
    render();
  }
  async function queueOp(type, data = {}, route = state.route) {
    if (!route) throw new Error('No active chat selected.');
    try {
      const record = await rpc('queue', { route, mutation: { type, ...data } }, makeOperationId());
      applyQueue(route, record);
      return record;
    } catch (error) {
      if (['sending', 'cancel-unsent', 'awaiting', 'complete'].includes(type)) pause('Storage or queue state changed; review the chat before resuming.', 'interrupted', 'storage');
      throw error;
    }
  }
  async function workflowOp(type, data = {}) {
    const record = await rpc('workflows', { mutation: { type, ...data } }, makeOperationId());
    applyWorkflows(record);
    return record;
  }
  async function saveQueueWorkflow(name) {
    const record = await rpc('saveQueueWorkflow', { route: state.route, name }, makeOperationId());
    applyWorkflows(record);
    notify('Workflow saved. You can load it into any conversation.');
  }
  // Load is append-only: it does not acquire the sender lock, start a runner,
  // or interrupt the tab already processing this conversation.
  async function loadWorkflow(workflow) {
    if (state.routeLoading || !state.storageHealthy) {
      notify('The chat queue is not ready. Reload or try again.'); return;
    }
    const route = state.route;
    if (!isUsableRoute(route)) {
      notify('Open a ChatGPT conversation or New Chat page before loading.'); return;
    }
    const handoff = newChatHandoff;
    pendingWorkflowLoads.set(route, (pendingWorkflowLoads.get(route) || 0) + 1);
    try {
      const record = await rpc('appendWorkflow', { route, workflowId: workflow.id }, makeOperationId());
      applyQueue(route, record);
      if (state.route !== route) {
        // A New Chat may become a stable chat while the append is in flight.
        // Move any steps appended after the ordinary temporary-queue migration.
        if (route.startsWith('new:') && state.route?.startsWith('chat:') &&
            (handoff?.destination === state.route || newChatHandoff?.destination === state.route)) {
          applyQueue(state.route, await rpc('moveTemp', {
            source: route, destination: state.route
          }, makeOperationId()));
        } else {
          notify('Conversation changed while loading. Review the previous conversation queue.');
          return;
        }
      }
      notify(state.running
        ? `Added ${workflow.steps.length} step(s) from “${workflow.name}” to the running queue.`
        : `Loaded ${workflow.steps.length} step(s) from “${workflow.name}”. If the queue is stopped, press Start.`);
    } catch (error) {
      notify(error.message || 'Could not load workflow.');
    } finally {
      const remaining = (pendingWorkflowLoads.get(route) || 1) - 1;
      if (remaining) pendingWorkflowLoads.set(route, remaining);
      else pendingWorkflowLoads.delete(route);
      wake();
      scheduleIdleSleep();
    }
  }
  async function editWithLock(fn) {
    // Reject changes while a second tab owns this conversation's sender lock.
    if (state.running) { notify('Pause the queue before editing.'); return false; }
    if (!navigator.locks?.request) { notify('Web Locks unavailable; cannot safely edit the queue.'); return false; }
    const route = state.route;
    let acquired = false;
    await navigator.locks.request('qfc-queue-' + route, { ifAvailable: true }, async lock => {
      if (!lock) return;
      acquired = true;
      await fn();
    });
    if (!acquired) notify('This conversation is running in another tab. Pause it there before editing.');
    return acquired;
  }
  async function loadRoute(route, { migrateFrom = null } = {}) {
    const generation = ++routeLoadGeneration;
    state.routeLoading = true;
    try {
      const record = migrateFrom
        ? await rpc('moveTemp', { source: migrateFrom, destination: route }, makeOperationId())
        : await rpc('getQueue', { route });
      // The migration may finish after another navigation. Clear only its source
      // identifier once the coordinator confirms the move, never the new page's.
      if (migrateFrom) forgetTemporaryRoute(migrateFrom);
      if (generation !== routeLoadGeneration || state.route !== route) return;
      applyQueue(route, record);
      state.editingQueueId = null;
    } catch (_) {
      if (generation !== routeLoadGeneration || state.route !== route) return;
      setStatus('Could not load saved queue.');
      state.storageHealthy = false;
    } finally {
      if (generation === routeLoadGeneration) {
        state.routeLoading = false;
        renderHeader();
        scheduleIdleSleep();
      }
    }
  }
  function checkRoute() {
    lastPathname = location.pathname;
    const stable = currentRoute();
    const route = stable || getTemporaryRoute();
    if (route === state.route) return;
    const previous = state.route;
    // Only migrate a temporary queue after a user submission initiated from the composer.
    // Clicking an existing chat must never attach the temporary queue to that other chat.
    const expectedHandoff = Boolean(state.running && newChatHandoff &&
      previous === newChatHandoff.from && stable && !navigateToExistingChat &&
      newChatHandoff.clickedAt && Date.now() - newChatHandoff.clickedAt < 90000);
    const migrateFrom = previous && previous.startsWith('new:') && stable &&
      !navigateToExistingChat && (expectedHandoff || Date.now() - tempSubmittedAt < 90000)
      ? previous : null;
    navigateToExistingChat = false; tempSubmittedAt = 0;
    if (state.running && !expectedHandoff) pause('Conversation changed — queue paused.', 'interrupted', 'route');
    if (expectedHandoff) newChatHandoff.destination = stable;
    state.route = route;
    // Set loading BEFORE rendering the emptied route to avoid a false Idle flash.
    state.routeLoading = true;
    state.queue = []; state.queueRev = -1; state.lastCompleted = null;
    render();
    setStatus(expectedHandoff ? 'New chat created — verifying first prompt…' :
      migrateFrom ? 'New chat saved — review queue before resuming.' : 'Paused');
    loadRoute(route, { migrateFrom });
  }

  function makeElement(tag, className, textValue) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textValue != null) el.textContent = String(textValue);
    return el;
  }
  function actionButton(label, action, id, title) {
    const button = makeElement('button', 'qfc-small', label);
    button.type = 'button'; button.dataset.action = action;
    if (id) button.dataset.id = id;
    button.title = title || label;
    button.setAttribute('aria-label', title || label);
    return button;
  }
  function initPanel() {
    root = document.createElement('div');
    root.id = 'qfc-root';
    root.style.visibility = 'hidden'; // No user interaction before initialization finishes.
    root.innerHTML = `
      <button type="button" class="qfc-dock" data-action="toggle" aria-expanded="false" aria-controls="qfc-panel">☷ Queue<span id="qfc-dock-status"> · Loading</span><span id="qfc-dock-count"></span></button>
      <section class="qfc-panel" id="qfc-panel" aria-label="Queued for ChatGPT" hidden>
        <header class="qfc-head">
          <div class="qfc-drag-handle" role="button" tabindex="0"
               title="Drag to move · arrow keys to nudge · Shift + arrow for larger steps"
               aria-label="Move Queue panel. Drag with mouse or touch, or use arrow keys.">
            <strong><span class="qfc-drag-icon" aria-hidden="true">⠿</span> Queued for ChatGPT</strong>
            <small>Drag here to move · local · lightweight</small>
          </div>
          <div class="qfc-head-actions">
            <button type="button" class="qfc-small" data-action="open-settings" title="Settings" aria-label="Settings" aria-pressed="false">⚙</button>
            <button type="button" class="qfc-small" data-action="reset-position" title="Reset panel position" aria-label="Reset panel position">⌖</button>
            <button type="button" class="qfc-small qfc-minimize" data-action="toggle" title="Minimize to the Queue dock" aria-label="Minimize Queued to dock">−</button>
            <button type="button" class="qfc-small qfc-power" data-action="turn-off" title="Close Queued and turn it off in this tab" aria-label="Close Queued and turn it off in this tab">✕</button>
          </div>
        </header>
        <nav class="qfc-nav" aria-label="Extension sections">
          <button type="button" data-action="tab-queue" class="qfc-active">Queue <span id="qfc-count">0</span></button>
          <button type="button" data-action="tab-workflows">☷ Workflows <span id="qfc-workflow-count">0</span></button>
        </nav>
        <section id="qfc-activity" class="qfc-activity" aria-label="Recent queue activity" hidden>
          <button type="button" class="qfc-activity-heading" data-action="toggle-activity"
                  aria-expanded="false" aria-controls="qfc-activity-details">
            <strong>Recent activity</strong><span id="qfc-activity-summary">▾ Expand</span>
          </button>
          <div id="qfc-activity-details" hidden>
            <div id="qfc-activity-current" class="qfc-activity-entry" hidden>
              <div class="qfc-activity-top"><strong class="qfc-activity-label"></strong><span class="qfc-activity-state"></span></div>
              <div class="qfc-activity-preview"></div><div class="qfc-activity-origin"></div>
            </div>
            <div id="qfc-activity-previous" class="qfc-activity-entry" hidden>
              <div class="qfc-activity-top"><strong class="qfc-activity-label"></strong><span class="qfc-activity-state"></span></div>
              <div class="qfc-activity-preview"></div><div class="qfc-activity-origin"></div>
            </div>
          </div>
        </section>
        <div id="qfc-queue-view" class="qfc-view">
          <label class="qfc-label" for="qfc-compose">Next prompt</label>
          <textarea id="qfc-compose" rows="3" maxlength="20000" placeholder="Write a prompt to queue…"></textarea>
          <div class="qfc-row qfc-wrap">
            <button type="button" class="qfc-primary" id="qfc-add" data-action="add">+ Add to queue</button>
            <button type="button" class="qfc-small" id="qfc-cancel" data-action="cancel-edit" hidden>Cancel edit</button>
          </div>
          <div class="qfc-row qfc-controls">
            <button type="button" class="qfc-primary" data-action="start" id="qfc-start">▶ Start</button>
            <button type="button" class="qfc-small" data-action="pause" id="qfc-pause" disabled>Ⅱ Pause</button>
            <button type="button" class="qfc-small qfc-danger" data-action="clear">Clear</button>
          </div>
          <div id="qfc-queue-items" class="qfc-items" aria-live="polite"></div>
          <div class="qfc-workflow-save">
            <label class="qfc-label" for="qfc-workflow-name">Save pending queue as a workflow</label>
            <input id="qfc-workflow-name" type="text" maxlength="100" placeholder="Workflow name (e.g. Research steps)" autocomplete="off" />
            <button type="button" class="qfc-small" data-action="save-queue-workflow">Save pending steps as workflow</button>
          </div>
        </div>
        <div id="qfc-workflows-view" class="qfc-view" hidden>
          <label class="qfc-label" for="qfc-search">Saved queue workflows</label>
          <input id="qfc-search" type="search" placeholder="Search workflows…" autocomplete="off" />
          <div class="qfc-row"><button type="button" class="qfc-small" data-action="new-workflow">+ Create workflow</button></div>
          <div id="qfc-workflow-editor" hidden>
            <label class="qfc-label" for="qfc-edit-workflow-name">Workflow name</label>
            <input id="qfc-edit-workflow-name" type="text" maxlength="100" autocomplete="off" />
            <label class="qfc-label">Prompts in sending order</label>
            <div id="qfc-step-editor"></div>
            <div class="qfc-row qfc-wrap"><button type="button" class="qfc-small" data-action="add-workflow-step">+ Add step</button>
              <button type="button" class="qfc-primary" data-action="save-workflow-edit">Save workflow</button>
              <button type="button" class="qfc-small" data-action="cancel-workflow-edit">Cancel</button></div>
          </div>
          <div id="qfc-workflow-items" class="qfc-items" aria-live="polite"></div>
          <div class="qfc-row qfc-backup qfc-wrap">
            <button type="button" class="qfc-small" data-action="export-workflows">Export workflows + settings</button>
            <button type="button" class="qfc-small" data-action="import-workflows">Import workflows + settings</button>
            <button type="button" class="qfc-small" data-action="export-legacy-favorites" title="Backup old Favorites stored before version 1.2">Backup old Favorites</button>
            <input type="file" id="qfc-import-file" accept=".json,application/json" hidden>
          </div>
        </div>
        <div id="qfc-settings-view" class="qfc-view qfc-settings" aria-label="Queued settings" hidden>
          <div class="qfc-settings-head">
            <button type="button" class="qfc-small" data-action="settings-back" aria-label="Back to previous view">← Back</button>
            <strong>Settings</strong>
          </div>
          <strong class="qfc-settings-subtitle">Keyboard shortcut</strong>
          <div class="qfc-hotkey-row">
            <code class="qfc-hotkey-value" id="qfc-shortcut-value" aria-live="polite">Checking…</code>
            <button type="button" class="qfc-small" data-action="refresh-shortcut" title="Refresh assigned shortcut">↻ Refresh</button>
          </div>
          <p class="qfc-settings-help" id="qfc-shortcut-help">Minimize, restore or reopen Queued without interrupting a workflow.</p>
          <button type="button" class="qfc-small qfc-hotkey-manage" data-action="change-shortcut">Change in Chrome</button>
          <div class="qfc-settings-divider"></div>
          <label class="qfc-label" for="qfc-auto-turn-off">Automatically turn off after (idle only)</label>
          <select id="qfc-auto-turn-off" aria-describedby="qfc-auto-turn-off-help">
            <option value="0">Never (stay on)</option>
            <option value="1">1 minute</option>
            <option value="5">5 minutes (default)</option>
            <option value="10">10 minutes</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">60 minutes</option>
          </select>
          <p class="qfc-settings-help" id="qfc-auto-turn-off-help">The full countdown begins after a run finishes and its sender lock is released. Running or uncertain prompts, unsaved edits and unfinished saves prevent automatic turn-off.</p>
          <p class="qfc-settings-feedback" id="qfc-auto-turn-off-status" role="status" aria-live="polite">Ready</p>
          <label class="qfc-label"><input type="checkbox" id="qfc-completion-alarm"> Response completion alarm</label>
          <p class="qfc-settings-help">Play a short sound after verified completion while Queued is active. Browser audio restrictions may prevent playback.</p>
        </div>
        <footer id="qfc-status" role="status">Paused</footer>
      </section>`;
    document.body.append(root);
    queueList = root.querySelector('#qfc-queue-items');
    workflowsList = root.querySelector('#qfc-workflow-items');
    statusLine = root.querySelector('#qfc-status');
    queueTextArea = root.querySelector('#qfc-compose');
    workflowSearch = root.querySelector('#qfc-search');
    root.addEventListener('click', event => {
      queuedInteraction();
      if (event.target.closest('button[data-action]')?.dataset.action === 'turn-off') {
        void sleepTab(true).catch(error => {
          disposing = false;
          notify(error.message || 'Could not turn off Queued.');
          scheduleIdleSleep();
        });
        return;
      }
      uiOperations++;
      void onPanelClick(event).catch(error => notify(error.message || 'Unable to save changes.'))
        .finally(() => { uiOperations--; scheduleIdleSleep(); });
    });
    root.addEventListener('input', queuedInteraction);
    root.addEventListener('change', queuedInteraction);
    root.addEventListener('keydown', queuedInteraction);
    root.addEventListener('pointerdown', queuedInteraction);
    workflowSearch.addEventListener('input', renderWorkflows);
    root.querySelector('#qfc-import-file').addEventListener('change', importFile);
    root.addEventListener('change', event => {
      const target = event.target;
      if (target.id === 'qfc-completion-alarm') {
        const previous = alarmEnabled;
        applyAlarmSetting(target.checked);
        void STORAGE.set({ [ALARM_KEY]: alarmEnabled }).catch(() => {
          applyAlarmSetting(previous); notify('Could not save alarm preference.');
        });
        return;
      }
      if (target.id === 'qfc-auto-turn-off') {
        saveAutoTurnOffMinutes(Number(target.value));
        return;
      }
    });
    root.addEventListener('input', event => {
      const draft = state.workflowDraft;
      if (!draft) return;
      if (event.target.id === 'qfc-edit-workflow-name') draft.name = event.target.value;
      const stepIndex = event.target.dataset?.stepIndex;
      if (stepIndex != null && draft.steps[Number(stepIndex)] !== undefined) draft.steps[Number(stepIndex)] = event.target.value;
    });
    setupPanelDragging();
  }
  function getStoredPanelPosition() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(PANEL_POSITION_KEY) || 'null');
      if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
        // Defend against corrupted values and unexpected site-written data.
        return { x: Math.max(-10000, Math.min(10000, stored.x)),
                 y: Math.max(-10000, Math.min(10000, stored.y)) };
      }
    } catch (_) { /* Session storage can be unavailable in restricted contexts. */ }
    return { x: 0, y: 0 };
  }
  function savePanelPosition() {
    try { sessionStorage.setItem(PANEL_POSITION_KEY, JSON.stringify({ x: panelOffsetX, y: panelOffsetY })); }
    catch (_) { /* Dragging still works even if persistence is unavailable. */ }
  }
  function setPanelPosition(x, y, { constrain = true, save = false } = {}) {
    if (!root) return;
    let nextX = x, nextY = y;
    if (constrain) {
      const bounds = root.getBoundingClientRect();
      const baseX = bounds.left - panelOffsetX;
      const baseY = bounds.top - panelOffsetY;
      const margin = 8;
      const minX = margin - baseX;
      const maxX = innerWidth - margin - bounds.width - baseX;
      const minY = margin - baseY;
      const maxY = innerHeight - margin - bounds.height - baseY;
      // The panel fits the viewport under normal conditions. If the viewport
      // becomes extremely small, keep the title visible rather than losing it.
      nextX = Math.max(minX, Math.min(maxX < minX ? minX : maxX, x));
      nextY = Math.max(minY, Math.min(maxY < minY ? minY : maxY, y));
    }
    panelOffsetX = Math.round(nextX);
    panelOffsetY = Math.round(nextY);
    root.style.transform = `translate3d(${panelOffsetX}px, ${panelOffsetY}px, 0)`;
    if (save) savePanelPosition();
  }
  function resetPanelPosition() {
    setPanelPosition(0, 0, { save: true });
    notify('Panel position reset.');
  }
  function setupPanelDragging() {
    const handle = root.querySelector('.qfc-drag-handle');
    if (!handle) return;
    const stored = getStoredPanelPosition();
    setPanelPosition(stored.x, stored.y, { constrain: false });
    handle.addEventListener('pointerdown', event => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      panelDrag = {
        id: event.pointerId, x: event.clientX, y: event.clientY,
        startX: panelOffsetX, startY: panelOffsetY, moved: false
      };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('qfc-is-dragging');
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!panelDrag || panelDrag.id !== event.pointerId) return;
      const dx = event.clientX - panelDrag.x, dy = event.clientY - panelDrag.y;
      if (!panelDrag.moved && Math.hypot(dx, dy) < 4) return;
      panelDrag.moved = true;
      setPanelPosition(panelDrag.startX + dx, panelDrag.startY + dy);
    });
    function finishDrag(event) {
      if (!panelDrag || panelDrag.id !== event.pointerId) return;
      const changed = panelDrag.moved;
      panelDrag = null;
      handle.classList.remove('qfc-is-dragging');
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (changed) savePanelPosition();
    }
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', event => {
      if (panelDrag?.id === event.pointerId) {
        panelDrag = null;
        handle.classList.remove('qfc-is-dragging');
        savePanelPosition();
      }
    });
    handle.addEventListener('keydown', event => {
      const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (event.key === 'Home') {
        event.preventDefault(); resetPanelPosition(); return;
      }
      const movement = steps[event.key];
      if (!movement) return;
      event.preventDefault();
      const size = event.shiftKey ? 40 : 10;
      setPanelPosition(panelOffsetX + movement[0] * size,
                       panelOffsetY + movement[1] * size, { save: true });
    });
    const onResize = () => setPanelPosition(panelOffsetX, panelOffsetY, { save: true });
    window.addEventListener('resize', onResize);
    cleanupListeners.push(() => window.removeEventListener('resize', onResize));
  }
  function dockDisplay() {
    if (!state.route || state.routeLoading) return { phase: 'loading', label: 'Loading', suffix: '' };
    if (!state.storageHealthy) return { phase: 'unavailable', label: 'Unavailable', suffix: '' };
    const pending = state.queue.filter(item => item.status === 'pending').length;
    const owned = state.running && state.senderLockRoute === state.route;
    if (state.running && !owned) {
      return { phase: 'starting', label: 'Starting', suffix: pending ? ` · ${pending} pending` : '' };
    }
    if (owned) {
      // The active item may still be pending while the runner prepares the composer.
      const preparing = state.queue[0]?.status === 'pending' ? 1 : 0;
      return { phase: 'running', label: 'Running', suffix: ` · ${Math.max(0, pending - preparing)} left` };
    }
    if (state.queue.some(item => item.status !== 'pending')) {
      // A different tab may own the queue, or its send may require review.
      return { phase: 'check', label: 'Check status', suffix: pending ? ` · ${pending} pending` : '' };
    }
    if (pending) return { phase: 'paused', label: 'Paused', suffix: ` · ${pending} pending` };
    return { phase: 'idle', label: 'Idle', suffix: '' };
  }
  function renderShortcut() {
    if (!root) return;
    const value = root.querySelector('#qfc-shortcut-value');
    const help = root.querySelector('#qfc-shortcut-help');
    if (!value || !help) return;
    value.textContent = shortcutInfo.status === 'assigned' ? shortcutInfo.value
      : shortcutInfo.status === 'unassigned' ? 'Not assigned'
        : shortcutInfo.status === 'loading' ? 'Checking…' : 'Unavailable';
    help.textContent = shortcutInfo.status === 'unassigned'
      ? 'No key is assigned in Chrome. Choose Change in Chrome to set one.'
      : shortcutInfo.status === 'unavailable'
        ? 'Could not read Chrome shortcuts. Check chrome://extensions/shortcuts.'
        : 'Minimize, restore or reopen Queued without interrupting a running workflow.';
  }
  async function refreshShortcut() {
    const request = ++shortcutRequest;
    shortcutInfo = { status: 'loading', value: '' };
    renderShortcut();
    try {
      const details = await rpc('getShortcut');
      if (request !== shortcutRequest || disposed || disposing) return;
      shortcutInfo = !details?.supported ? { status: 'unavailable', value: '' }
        : details.shortcut ? { status: 'assigned', value: details.shortcut }
          : { status: 'unassigned', value: '' };
    } catch (_) {
      if (request !== shortcutRequest || disposed || disposing) return;
      shortcutInfo = { status: 'unavailable', value: '' };
    }
    renderShortcut();
  }
  function renderHeader() {
    if (!root) return;
    const count = state.queue.length;
    const dock = root.querySelector('.qfc-dock');
    const before = dock.textContent;
    const display = dockDisplay();
    root.querySelector('#qfc-count').textContent = count;
    root.querySelector('#qfc-dock-status').textContent = ' · ' + display.label;
    root.querySelector('#qfc-dock-count').textContent = display.suffix;
    dock.dataset.phase = display.phase;
    dock.setAttribute('aria-label', `Queue, ${display.label}${display.suffix}`);
    const headWorkflow = state.queue[0]?.workflow;
    dock.title = headWorkflow && display.phase === 'running'
      ? `${headWorkflow.name} · Step ${headWorkflow.step}/${headWorkflow.total}`
      : `Queued for ChatGPT — ${display.label}${display.suffix}`;
    root.querySelector('#qfc-workflow-count').textContent = state.workflows.length;
    dock.setAttribute('aria-expanded', String(state.open));
    root.querySelector('#qfc-panel').hidden = !state.open;
    root.querySelector('.qfc-nav').hidden = settingsOpen;
    root.querySelector('#qfc-settings-view').hidden = !settingsOpen;
    root.querySelector('[data-action="open-settings"]').setAttribute('aria-pressed', String(settingsOpen));
    root.querySelector('#qfc-queue-view').hidden = settingsOpen || state.tab !== 'queue';
    root.querySelector('#qfc-workflows-view').hidden = settingsOpen || state.tab !== 'workflows';
    root.querySelector('[data-action="tab-queue"]').classList.toggle('qfc-active', state.tab === 'queue');
    root.querySelector('[data-action="tab-workflows"]').classList.toggle('qfc-active', state.tab === 'workflows');
    const btn = root.querySelector('#qfc-start');
    const canStart = isUsableRoute(state.route);
    btn.disabled = state.running || state.routeLoading || !state.storageHealthy || !state.queue.length || !canStart;
    root.querySelector('#qfc-pause').disabled = !state.running;
    statusLine.textContent = state.route?.startsWith('new:') && !state.running && state.status === 'Paused'
      ? isNewChatPage()
        ? 'New chat: Start sends the first queued prompt to create this conversation.'
        : 'Open New Chat to start a queue.'
      : state.status;
    if (before !== dock.textContent && !state.open) {
      setPanelPosition(panelOffsetX, panelOffsetY);
    }
  }
  function renderActivity() {
    if (!root) return;
    const section = root.querySelector('#qfc-activity');
    const head = state.queue[0];
    const current = head && (head.status !== 'pending' || state.running) ? head : null;
    const previous = state.lastCompleted;
    const wasHidden = section.hidden;
    section.hidden = settingsOpen || (!current && !previous);
    const button = root.querySelector('[data-action="toggle-activity"]');
    const details = root.querySelector('#qfc-activity-details');
    const currentStatus = !current ? '' : current.status === 'pending' ? 'Preparing' :
      !state.running ? 'Needs review' :
      current.status === 'sending' ? 'Sending' : 'Awaiting response';
    const expanded = activityExpanded && !section.hidden;
    button.setAttribute('aria-expanded', String(expanded));
    details.hidden = !expanded;
    root.querySelector('#qfc-activity-summary').textContent = expanded ? '▴ Collapse' :
      current ? `▾ Current: ${currentStatus}` : '▾ Previous completed';

    // In the collapsed state the current/previous records remain in application
    // state; populate only when expanded to avoid retaining large hidden strings.
    if (expanded) {
      function populate(id, item, label, status) {
        const element = root.querySelector(id);
        element.hidden = !item;
        if (!item) return;
        element.querySelector('.qfc-activity-label').textContent = label;
        element.querySelector('.qfc-activity-state').textContent = status;
        const preview = element.querySelector('.qfc-activity-preview');
        const display = String(item.text || item.preview || '').slice(0, C.MAX_ACTIVITY_PREVIEW);
        preview.textContent = display;
        preview.title = display;
        const origin = element.querySelector('.qfc-activity-origin');
        const workflow = item.workflow;
        origin.textContent = workflow
          ? `${workflow.name} · Step ${workflow.step}/${workflow.total} · ID ${workflow.id.slice(0, 8)}…`
          : 'Queue prompt';
        origin.title = workflow ? `Workflow ID: ${workflow.id}` : 'Queued prompt (workflow origin unavailable)';
      }
      populate('#qfc-activity-current', current, 'Current', currentStatus);
      populate('#qfc-activity-previous', previous, 'Previous',
        previous?.completion === 'confirmed' ? 'Confirmed done' : 'Completed');
    }
    if (state.open && wasHidden !== section.hidden) {
      setPanelPosition(panelOffsetX, panelOffsetY, { save: true });
    }
  }
  function renderQueue() {
    if (!queueList || !state.open || state.tab !== 'queue') return;
    // The route is essential: separate conversations may share a queue revision.
    const renderKey = JSON.stringify([state.route, state.queueRev]);
    if (lastQueueRenderKey === renderKey) return;
    const frag = document.createDocumentFragment();
    if (!state.queue.length) frag.append(makeElement('p', 'qfc-empty', 'Queue empty. Add prompts above.'));
    state.queue.forEach((item, index) => {
      const row = makeElement('div', 'qfc-item');
      const title = makeElement('div', 'qfc-preview', item.text);
      title.title = item.text;
      const meta = makeElement('div', 'qfc-meta', `${index + 1}. ${item.status === 'pending' ? 'Pending' : item.status === 'sending' ? 'Sending — check ChatGPT' : 'Awaiting response'}`);
      const actions = makeElement('div', 'qfc-row qfc-item-actions');
      if (item.status === 'pending') {
        actions.append(actionButton('↑', 'up', item.id, 'Move up'), actionButton('↓', 'down', item.id, 'Move down'),
          actionButton('Edit', 'edit', item.id, 'Edit queued prompt'),
          actionButton('Copy', 'copy', item.id, 'Copy full queued prompt'),
          actionButton('×', 'remove', item.id, 'Remove queued prompt'));
      } else {
        actions.append(actionButton('Copy', 'copy', item.id, 'Copy full queued prompt'),
          actionButton('✓ Done', 'confirm-done', item.id, 'Confirm completed and remove from queue'),
          actionButton('↺ Retry', 'confirm-retry', item.id, 'Confirm retry; may cause a duplicate send'));
      }
      row.append(meta, title, actions);
      frag.append(row);
    });
    queueList.replaceChildren(frag);
    lastQueueRenderKey = renderKey;
  }
  function renderWorkflows() {
    if (!workflowsList || !state.open || settingsOpen || state.tab !== 'workflows') return;
    const query = C.normalize(workflowSearch.value).toLocaleLowerCase();
    const renderKey = JSON.stringify([state.workflowsRev, query, [...expandedWorkflowIds].sort()]);
    // Queue status updates must not destroy Copy feedback, text selection or focus.
    if (renderKey === lastWorkflowRenderKey) return;
    const view = root.querySelector('#qfc-workflows-view');
    const scrollTop = view.scrollTop;
    const active = workflowsList.contains(document.activeElement) ? document.activeElement : null;
    const focusedAction = active?.dataset?.action;
    const focusedId = active?.dataset?.id;
    const focusedStep = active?.dataset?.stepIndex;
    const found = state.workflows.filter(w =>
      C.normalize(w.name).toLocaleLowerCase().includes(query) ||
      w.steps.some(step => C.normalize(step).toLocaleLowerCase().includes(query)));
    const frag = document.createDocumentFragment();
    if (!found.length) frag.append(makeElement('p', 'qfc-empty', 'No saved workflows. Save the pending queue or create a workflow here.'));
    for (const [index, workflow] of found.entries()) {
      const expanded = expandedWorkflowIds.has(workflow.id);
      const row = makeElement('div', 'qfc-item qfc-workflow-item');
      const heading = makeElement('div', 'qfc-workflow-heading');
      const titleGroup = makeElement('div', 'qfc-workflow-heading-text');
      titleGroup.append(makeElement('div', 'qfc-workflow-title', workflow.name),
        makeElement('div', 'qfc-meta', `${workflow.steps.length} steps`));
      const actions = makeElement('div', 'qfc-row qfc-item-actions');
      const toggle = actionButton(expanded ? '▾' : '▸',
        'toggle-workflow', workflow.id, expanded ? 'Collapse saved workflow prompts' : 'Expand saved workflow prompts');
      toggle.classList.add('qfc-disclosure');
      heading.append(toggle, titleGroup);
      const details = makeElement('div', 'qfc-workflow-details');
      details.id = `qfc-workflow-details-${index}`;
      details.hidden = !expanded;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-controls', details.id);
      const startButton = actionButton('▶ Start Workflow', 'start-workflow', workflow.id,
        'Add this workflow to the current conversation and immediately begin sending');
      startButton.classList.add('qfc-primary');
      actions.append(startButton,
        actionButton('+ Load', 'load-workflow', workflow.id,
          'Append these prompts to the queue without starting it'),
        actionButton('Edit', 'edit-workflow', workflow.id, 'Edit name and steps'),
        actionButton('Delete', 'remove-workflow', workflow.id, 'Delete saved workflow'));
      if (expanded) {
        workflow.steps.forEach((step, stepIndex) => {
          const entry = makeElement('div', 'qfc-workflow-prompt');
          const heading = makeElement('div', 'qfc-workflow-prompt-head');
          heading.append(makeElement('strong', 'qfc-meta', `Prompt ${stepIndex + 1}`));
          const copy = actionButton('Copy', 'copy-workflow-step', workflow.id,
            `Copy full prompt ${stepIndex + 1} from ${workflow.name}`);
          copy.dataset.stepIndex = String(stepIndex);
          heading.append(copy);
          entry.append(heading, makeElement('div', 'qfc-workflow-prompt-text', step));
          details.append(entry);
        });
      }
      row.append(heading, actions, details);
      frag.append(row);
    }
    workflowsList.replaceChildren(frag);
    lastWorkflowRenderKey = renderKey;
    view.scrollTop = scrollTop;
    if (focusedAction && focusedId) {
      const restored = [...workflowsList.querySelectorAll('button[data-action]')].find(button =>
        button.dataset.action === focusedAction && button.dataset.id === focusedId &&
        button.dataset.stepIndex === focusedStep);
      restored?.focus({ preventScroll: true });
    }
  }
  function renderWorkflowEditor() {
    const editor = root.querySelector('#qfc-workflow-editor');
    const draft = state.workflowDraft;
    editor.hidden = !draft;
    if (!draft) return;
    root.querySelector('#qfc-edit-workflow-name').value = draft.name;
    const list = root.querySelector('#qfc-step-editor');
    const frag = document.createDocumentFragment();
    draft.steps.forEach((step, index) => {
      const row = makeElement('div', 'qfc-step');
      const label = makeElement('label', 'qfc-label', `Step ${index + 1}`);
      label.htmlFor = `qfc-step-${index}`;
      const text = makeElement('textarea');
      text.id = `qfc-step-${index}`;
      text.dataset.stepIndex = String(index);
      text.rows = 3; text.maxLength = C.MAX_PROMPT_LENGTH;
      text.value = step;
      const buttons = makeElement('div', 'qfc-row qfc-item-actions');
      buttons.append(actionButton('↑', 'workflow-step-up', String(index), 'Move step up'),
        actionButton('↓', 'workflow-step-down', String(index), 'Move step down'),
        actionButton('× Remove', 'workflow-step-remove', String(index), 'Remove step'));
      row.append(label, text, buttons); frag.append(row);
    });
    list.replaceChildren(frag);
  }
  function openWorkflowEditor(workflow) {
    state.workflowDraft = workflow ? {
      id: workflow.id, name: workflow.name, steps: [...workflow.steps], expectedUpdatedAt: workflow.updatedAt
    } : {id: null, name: '', steps: [''], expectedUpdatedAt: null};
    setTab('workflows');
    renderWorkflowEditor();
    root.querySelector('#qfc-edit-workflow-name').focus();
  }
  function render() { renderHeader(); renderActivity(); renderQueue(); renderWorkflows(); }
  async function addPrompt(text) {
    if (!C.validText(text)) { notify('Enter a prompt (up to 20,000 characters).'); return false; }
    try { await queueOp('add', { text }); render(); return true; }
    catch (error) { notify(error.message || 'Could not add prompt.'); return false; }
  }
  function pause(message = 'Paused', outcome = 'interrupted', reason = 'unexpected') {
    state.running = false;
    state.senderLockRoute = null;
    newChatHandoff = null;
    trackingSendAttempt = false;
    observedStopDuringSend = false;
    setStatus(message);
    wake();
    scheduleIdleSleep();
  }
  function setTab(tab) {
    state.tab = tab;
    settingsOpen = false;
    renderHeader();
    // A hidden list may have missed several queue or workflow revisions.
    renderQueue();
    renderWorkflows();
  }
  function togglePanel() {
    if (!root) return;
    state.open = !state.open;
    // Panel visibility is tab-local; preserve the prior shared setting record unchanged.
    render();
    // Clamp the expanded panel (or narrower dock) without resetting drag offsets.
    setPanelPosition(panelOffsetX, panelOffsetY, { save: true });
    queuedInteraction();
  }
  async function copyPromptText(text, button, resetLabel) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.');
      await navigator.clipboard.writeText(text);
      if (button.isConnected) {
        button.textContent = '✓ Copied';
        button.setAttribute('aria-label', 'Prompt copied');
      }
    } catch (_) {
      if (button.isConnected) {
        button.textContent = 'Copy failed';
        button.setAttribute('aria-label', 'Could not copy prompt');
      }
    }
    // Feedback is local to the button and never changes execution status.
    const timer = setTimeout(() => {
      transientTimers.delete(timer);
      if (button.isConnected) {
        button.textContent = 'Copy';
        button.setAttribute('aria-label', resetLabel);
      }
    }, 1600);
    transientTimers.add(timer);
  }
  async function onPanelClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (location.pathname !== lastPathname) checkRoute();
    const action = button.dataset.action, id = button.dataset.id;
    const queueItem = state.queue.find(item => item.id === id);
    const workflow = state.workflows.find(item => item.id === id);
    switch (action) {
      case 'toggle': togglePanel(); break;
      case 'toggle-activity':
        activityExpanded = !activityExpanded;
        renderActivity();
        setPanelPosition(panelOffsetX, panelOffsetY);
        break;
      case 'open-settings':
        settingsOpen = !settingsOpen;
        render();
        renderAutoTurnOffSetting();
        if (settingsOpen) {
          void refreshShortcut();
        }
        setPanelPosition(panelOffsetX, panelOffsetY);
        break;
      case 'refresh-shortcut':
        await refreshShortcut();
        break;
      case 'change-shortcut':
        try { await rpc('openShortcutSettings'); }
        catch (_) { notify('Could not open Chrome shortcuts. Open chrome://extensions/shortcuts manually.'); }
        break;
      case 'settings-back':
        settingsOpen = false;
        render();
        setPanelPosition(panelOffsetX, panelOffsetY);
        break;
      case 'reset-position': resetPanelPosition(); break;
      case 'tab-queue': setTab('queue'); break;
      case 'tab-workflows': setTab('workflows'); break;
      case 'add': {
        const content = queueTextArea.value;
        if (state.editingQueueId) {
          const edited = state.queue.find(item => item.id === state.editingQueueId);
          if (!edited || edited.status !== 'pending') { notify('Cannot edit a message already sent.'); break; }
          if (!C.validText(content)) { notify('Prompt must be 1–20,000 characters.'); break; }
          if (await editWithLock(() => queueOp('edit', { id: edited.id, text: content }))) cancelQueueEdit();
          render();
        } else {
          if (!C.validText(content)) { notify('Enter a prompt (up to 20,000 characters).'); break; }
          if (await addPrompt(content)) queueTextArea.value = '';
        }
        break;
      }
      case 'cancel-edit': cancelQueueEdit(); break;
      case 'start': startQueue(); break;
      case 'pause': pause('Paused by you.', 'manual'); break;
      case 'clear':
        if (!state.queue.length || !confirm('Clear all pending queued prompts for this conversation?')) break;
        if (state.running) pause('Queue cleared.', 'manual');
        await editWithLock(() => queueOp('clear')); render(); break;
      case 'up': case 'down':
        if (!queueItem || state.running) { notify('Pause before reordering.'); break; }
        const i = state.queue.findIndex(item => item.id === id);
        const j = i + (action === 'up' ? -1 : 1);
        if (j < 0 || j >= state.queue.length || state.queue[j].status !== 'pending' || queueItem.status !== 'pending') break;
        await editWithLock(() => queueOp('move', { id, direction: action })); render(); break;
      case 'edit':
        if (!queueItem || queueItem.status !== 'pending' || state.running) { notify('Pause before editing.'); break; }
        state.editingQueueId = queueItem.id;
        queueTextArea.value = queueItem.text;
        root.querySelector('#qfc-add').textContent = 'Save prompt';
        root.querySelector('#qfc-cancel').hidden = false;
        queueTextArea.focus(); break;
      case 'remove':
        if (!queueItem || queueItem.status !== 'pending' || state.running) { notify('Pause before removing.'); break; }
        await editWithLock(() => queueOp('remove', { id })); render(); break;
      case 'copy':
        if (queueItem) await copyPromptText(queueItem.text, button, 'Copy full queued prompt');
        break;
      case 'save-queue-workflow': {
        const nameInput = root.querySelector('#qfc-workflow-name');
        if (!C.validWorkflowName(nameInput.value)) { notify('Enter a workflow name (1–100 characters).'); break; }
        await saveQueueWorkflow(nameInput.value);
        nameInput.value = '';
        setTab('workflows');
        break;
      }
      case 'confirm-done':
        if (!queueItem || state.running || state.queue[0]?.id !== id) { notify('Pause first; resolve the oldest uncertain prompt.'); break; }
        if (!confirm('Confirm this prompt was sent and its response is complete? Remove it and allow the next queue item to run?')) break;
        if (await editWithLock(() => queueOp('confirm-done', { id, confirmed: true }))) setStatus('Confirmed complete. Select Start to continue.');
        render(); break;
      case 'confirm-retry':
        if (!queueItem || state.running || state.queue[0]?.id !== id) { notify('Pause first; resolve the oldest uncertain prompt.'); break; }
        if (!confirm('Retry might send a duplicate. Have you checked that this prompt was NOT already sent?')) break;
        if (await editWithLock(() => queueOp('confirm-retry', { id, confirmed: true }))) setStatus('Ready to retry. Select Start.');
        render(); break;
      case 'start-workflow':
        if (workflow) startQueue(workflow.id);
        break;
      case 'load-workflow':
        if (workflow) await loadWorkflow(workflow);
        break;
      case 'toggle-workflow':
        if (!workflow) break;
        if (expandedWorkflowIds.has(id)) expandedWorkflowIds.delete(id);
        else expandedWorkflowIds.add(id);
        renderWorkflows();
        setPanelPosition(panelOffsetX, panelOffsetY);
        break;
      case 'copy-workflow-step': {
        const stepIndex = Number(button.dataset.stepIndex);
        if (!workflow || !Number.isSafeInteger(stepIndex) || stepIndex < 0 ||
            stepIndex >= workflow.steps.length) break;
        await copyPromptText(workflow.steps[stepIndex], button, 'Copy full saved workflow prompt');
        break;
      }
      case 'new-workflow': openWorkflowEditor(null); break;
      case 'edit-workflow': if (workflow) openWorkflowEditor(workflow); break;
      case 'cancel-workflow-edit':
        state.workflowDraft = null; renderWorkflowEditor(); break;
      case 'add-workflow-step': {
        if (!state.workflowDraft) break;
        if (state.workflowDraft.steps.length >= C.MAX_QUEUE) { notify('Maximum 100 steps per workflow.'); break; }
        state.workflowDraft.steps.push(''); renderWorkflowEditor();
        root.querySelector(`#qfc-step-${state.workflowDraft.steps.length - 1}`).focus();
        break;
      }
      case 'workflow-step-up': case 'workflow-step-down': case 'workflow-step-remove': {
        const draft = state.workflowDraft;
        const stepIndex = Number(id);
        if (!draft || !Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= draft.steps.length) break;
        if (action === 'workflow-step-remove') draft.steps.splice(stepIndex, 1);
        else {
          const neighbor = stepIndex + (action === 'workflow-step-up' ? -1 : 1);
          if (neighbor < 0 || neighbor >= draft.steps.length) break;
          [draft.steps[stepIndex], draft.steps[neighbor]] = [draft.steps[neighbor], draft.steps[stepIndex]];
        }
        renderWorkflowEditor(); break;
      }
      case 'save-workflow-edit': {
        const draft = state.workflowDraft;
        if (!draft) break;
        if (!C.validWorkflowName(draft.name)) { notify('Workflow name must be 1–100 characters.'); break; }
        try { C.cleanWorkflowSteps(draft.steps); }
        catch (error) { notify(error.message); break; }
        await workflowOp(draft.id ? 'edit' : 'create', {
          ...(draft.id ? {id: draft.id, expectedUpdatedAt: draft.expectedUpdatedAt} : {}),
          name: draft.name, steps: draft.steps
        });
        state.workflowDraft = null;
        renderWorkflowEditor();
        notify('Workflow saved.');
        break;
      }
      case 'remove-workflow':
        if (workflow && confirm(`Delete saved workflow “${workflow.name}”? Existing queued prompts are unaffected.`)) {
          await workflowOp('remove', {id: workflow.id, expectedUpdatedAt: workflow.updatedAt});
          notify('Workflow deleted.');
        }
        break;
      case 'export-workflows': {
        // Read committed values, not pending optimistic UI selections, and obtain
        // the current workflow revision from the serialized coordinator.
        if (autoOffWriteLoop) await autoOffWriteLoop;
        const [record, stored] = await Promise.all([
          rpc('getWorkflows'), STORAGE.get(C.SETTINGS_KEY)
        ]);
        downloadJson({
          app: 'Queued for ChatGPT', kind: 'workflows', version: 5,
          exportedAt: new Date().toISOString(), workflows: record.items,
          settings: {
            autoTurnOffMinutes: C.cleanAutoTurnOffMinutes(stored[C.SETTINGS_KEY]?.autoTurnOffMinutes)
          }
        }, 'queued-for-chatgpt-workflows-and-settings.json');
        notify('Workflow and settings backup exported.');
        break;
      }
      case 'export-legacy-favorites': {
        const backup = await rpc('exportLegacyFavorites');
        downloadJson(backup, 'queued-for-chatgpt-old-favorites.json');
        notify('Old Favorites exported. They remain stored, but are no longer shown.');
        break;
      }
      case 'import-workflows': root.querySelector('#qfc-import-file').click(); break;
      default: break;
    }
  }
  function cancelQueueEdit() {
    state.editingQueueId = null; queueTextArea.value = '';
    root.querySelector('#qfc-add').textContent = '+ Add to queue';
    root.querySelector('#qfc-cancel').hidden = true;
  }
  function downloadJson(payload, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'}));
    pendingDownloadUrls.add(url);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename;
    root.append(anchor); anchor.click(); anchor.remove();
    const timer = setTimeout(() => {
      transientTimers.delete(timer);
      pendingDownloadUrls.delete(url);
      URL.revokeObjectURL(url);
    }, 1000);
    transientTimers.add(timer);
  }
  async function importFile(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    uiOperations++;
    queuedInteraction();
    try {
      if (file.size > 2 * 1024 * 1024) {
        notify('Workflow backup is too large (max 2 MB).'); return;
      }
      const data = JSON.parse(await file.text());
      // Validate settings BEFORE changing any saved workflows. Older v3 workflow
      // backups have no settings field and leave preferences unchanged.
      const importedSettings = C.validateBackupSettings(data?.settings);
      if (importedSettings && !confirm(
        'Restore the auto turn-off duration from this backup too? This replaces that setting across ChatGPT tabs.')) return;
      const before = state.workflows.length;
      await workflowOp('import', {payload: data});
      const added = Math.max(0, state.workflows.length - before);
      if (!importedSettings) {
        notify(`Imported ${added} new workflows. Existing settings were kept.`);
        return;
      }
      if (autoOffWriteLoop) await autoOffWriteLoop;
      const existing = (await STORAGE.get(C.SETTINGS_KEY))[C.SETTINGS_KEY];
      const appSettings = existing && typeof existing === 'object' &&
        !Array.isArray(existing) ? existing : {};
      try {
        await STORAGE.set({
          [C.SETTINGS_KEY]: {
            ...appSettings, autoTurnOffMinutes: importedSettings.autoTurnOffMinutes
          }
        });
      } catch (_) {
        notify(`Imported ${added} workflows, but settings could not be restored. Check storage and retry.`);
        return;
      }
      // The storage listener also updates other tabs. Refresh this tab
      // explicitly in case a browser mock or existing listener was unavailable.
      autoTurnOffMinutes = confirmedAutoTurnOffMinutes = importedSettings.autoTurnOffMinutes;
      autoOffSaveStatus = 'Saved';
      renderAutoTurnOffSetting();
      scheduleIdleSleep();
      notify(`Imported ${added} new workflows and restored settings.`);
    } catch (error) {
      notify(error.message || 'Could not import workflow backup.');
    } finally {
      uiOperations--;
      scheduleIdleSleep();
    }
  }

  // DOM detection is deliberately conservative: never call network endpoints or reuse credentials.
  // Prefer the actual composer ID, then explicit composer markup. Never pick
  // an unrelated message editor just because it is a visible textbox.
  function findEditor() {
    const visible = el => !el.closest('#qfc-root, [inert], [aria-hidden="true"]') &&
      el.isConnected && el.getClientRects().length &&
      (el.isContentEditable || el.matches('textarea')) && composerArea(el);
    const tiers = [
      '#prompt-textarea',
      '[data-testid="composer-input"], textarea[data-id="root"]',
      '[contenteditable="true"][role="textbox"]'
    ];
    for (let i = 0; i < tiers.length; i++) {
      const options = [...document.querySelectorAll(tiers[i])].filter(el => {
        if (!visible(el)) return false;
        if (i < 2) return true;
        const area = composerArea(el);
        return area.matches('[data-testid="composer"], [data-chatgpt-composer]') ||
          Boolean(area.querySelector('[data-testid="send-button"], [data-testid="composer-submit-button"], ' + STOP_SELECTORS));
      });
      if (options.length) return options.length === 1 ? options[0] : null;
    }
    return null;
  }
  function editorText(editor) {
    return editor ? (editor.matches('textarea') ? editor.value : (editor.innerText || '').replace(/\u200b/g, '')) : '';
  }
  function composerArea(editor) {
    return editor?.closest('form, [data-testid="composer"], [data-chatgpt-composer]') || null;
  }
  function findSendButton(editor) {
    const area = composerArea(editor);
    if (!area) return null;
    const eligible = selector => [...area.querySelectorAll(selector)].filter(button =>
      button.tagName === 'BUTTON' && button.isConnected && button.getClientRects().length &&
      !button.matches(STOP_SELECTORS) &&
      !button.querySelector('svg.icon-primary-action path[d^="M4.5 5.75"]'));
    // Prefer ChatGPT's explicit Send controls. A generic form submit button
    // is only a fallback, and ambiguity must never result in a wrong click.
    const explicit = eligible('[data-testid="send-button"], [data-testid="composer-submit-button"]');
    const candidates = explicit.length ? explicit : eligible('button[type="submit"]');
    return candidates.length === 1 ? candidates[0] : null;
  }
  function isGenerating(editor = findEditor()) {
    const area = composerArea(editor);
    if (!area) return false;
    if (area.querySelector(STOP_SELECTORS)) return true;
    // A square Stop glyph used in a ChatGPT composer design; do not classify other icons.
    return Boolean(area.querySelector('button svg.icon-primary-action path[d^="M4.5 5.75"]'));
  }
  // Prefer one markup family so nested message wrappers are not double-counted.
  // Scoped timeline markers avoid hidden pre-rendered conversation copies.
  function selectMessages(selectors) {
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)]
        .filter(node => !node.closest('#qfc-root'));
      if (found.length) return found;
    }
    return [];
  }
  function userMessages() { return selectMessages(USER_SELECTORS); }
  function assistantMessages() { return selectMessages(ASSISTANT_SELECTORS); }
  function assistantText(message) {
    if (!message) return '';
    const pieces = message.querySelectorAll('[data-markdown-text-style="assistant-message"], .markdown, .prose');
    if (pieces.length) return [...pieces].map(node => node.innerText || node.textContent || '').join(' ').trim();
    // The role marker in some builds is only an h4; the answer is its sibling.
    if (message.matches('[data-conversation-role="assistant"]')) {
      const unit = message.closest('[data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-turn-key]');
      if (unit && unit !== message) return (unit.innerText || unit.textContent || '').trim();
    }
    return (message.innerText || message.textContent || '').trim();
  }
  function extractMessage(message) {
    const specific = message.querySelector('[data-testid="user-message"], .whitespace-pre-wrap, .prose, .markdown');
    const source = specific || message;
    if (specific && !specific.querySelector('.qfc-message-star')) return (specific.innerText || specific.textContent || '').trim();
    const copy = source.cloneNode(true);
    copy.querySelectorAll('.qfc-message-star, button, svg, [aria-hidden="true"]').forEach(el => el.remove());
    return (copy.innerText || copy.textContent || '').trim();
  }
  function writeEditor(editor, text) {
    if (editor.matches('textarea')) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(editor, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }
    if (!editor.isContentEditable) return false;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange(); range.selectNodeContents(editor);
    selection.removeAllRanges(); selection.addRange(range);
    // The browser sends native editing events understood by ProseMirror/Tiptap.
    return document.execCommand('insertText', false, text);
  }
  function healthyRoute(route) {
    return state.running && state.route === route && isUsableRoute(route);
  }
  // Mutation signals wake a check; they do not count as elapsed time.
  // A stable real draft still pauses; transient content is never erased.
  const COMPOSER_SETTLE_MS = 1400;
  const COMPOSER_DRAFT_GRACE_MS = 3500;
  async function waitForComposerIdle(route, deadline) {
    let previousEditor = null, emptySince = null, draftSince = null;
    while (healthyRoute(route) && Date.now() < deadline) {
      const editor = findEditor();
      const now = Date.now();
      if (editor !== previousEditor) {
        previousEditor = editor;
        emptySince = draftSince = null;
      }
      if (!editor || isGenerating(editor)) {
        emptySince = draftSince = null;
        if (state.status !== 'Waiting for ChatGPT to finish…') setStatus('Waiting for ChatGPT to finish…');
      } else if (C.normalize(editorText(editor))) {
        emptySince = null;
        if (draftSince === null) draftSince = now;
        if (now - draftSince >= COMPOSER_DRAFT_GRACE_MS) {
          pause('ChatGPT has an unsent draft. Queue paused to protect it.', 'interrupted', 'composer');
          return null;
        }
        if (state.status !== 'Waiting for ChatGPT composer to clear…') setStatus('Waiting for ChatGPT composer to clear…');
      } else {
        draftSince = null;
        if (emptySince === null) emptySince = now;
        if (now - emptySince >= COMPOSER_SETTLE_MS) return editor;
        if (state.status !== 'Waiting for ChatGPT composer to settle…') setStatus('Waiting for ChatGPT composer to settle…');
      }
      await signalOrTimeout(Math.min(500, Math.max(0, deadline - Date.now())));
    }
    if (healthyRoute(route)) pause('ChatGPT did not become ready. Queue paused.', 'interrupted', 'composer');
    return null;
  }
  // Reserve the head before writing. If the composer changes during storage,
  // undo only a reservation we KNOW has not reached writeEditor.
  async function prepareAndSend(item, route) {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (healthyRoute(route) && Date.now() < deadline) {
      const editor = await waitForComposerIdle(route, deadline);
      if (!editor || !healthyRoute(route)) return null;
      await queueOp('sending', { id: item.id }, route);
      if (!healthyRoute(route) || findEditor() !== editor ||
          isGenerating(editor) || C.normalize(editorText(editor))) {
        await queueOp('cancel-unsent', { id: item.id }, route);
        continue;
      }
      const userBaseline = snapshotUserTurns();
      const oldAssistant = assistantMessages().at(-1);
      const handoff = route.startsWith('new:') ? {
        from: route, id: item.id, text: item.text, clickedAt: 0, destination: null
      } : null;
      if (handoff) newChatHandoff = handoff;
      const clicked = await sendMessage(item.text, route, editor);
      return { clicked, userBaseline, oldAssistant, handoff };
    }
    if (healthyRoute(route)) pause('ChatGPT did not become ready. Queue paused.', 'interrupted', 'composer');
    return null;
  }
  async function sendMessage(text, route, editor) {
    // No asynchronous gap between the caller's final preflight and insertion.
    if (!writeEditor(editor, text)) { pause('Composer changed; cannot safely insert prompt.', 'interrupted', 'composer'); return false; }
    // ChatGPT may enable Send asynchronously after accepting the inserted text.
    // Check for up to 3 seconds initially, then make three more bounded 3-second
    // checks. Never insert the text again or click twice: receipt verification
    // after a click remains the caller's responsibility.
    const SEND_BUTTON_RETRY_MS = 3000;
    const MAX_SEND_BUTTON_RETRIES = 3;
    const intendedText = C.normalize(text);
    // The framework may expose the newly inserted value one render later.
    // Only treat a later text change as an edited draft once our text was seen.
    let sawInsertedText = C.normalize(editorText(editor)) === intendedText;
    for (let retry = 0; retry <= MAX_SEND_BUTTON_RETRIES && healthyRoute(route); retry++) {
      if (retry) setStatus(`Waiting for Send button — retry ${retry}/${MAX_SEND_BUTTON_RETRIES}…`);
      const deadline = Date.now() + SEND_BUTTON_RETRY_MS;
      while (Date.now() < deadline && healthyRoute(route)) {
        // An edited/replaced composer or new generation may mean the message
        // was submitted elsewhere. Never overwrite or click in that state.
        const sameText = C.normalize(editorText(editor)) === intendedText;
        if (sameText) sawInsertedText = true;
        if (findEditor() !== editor || (sawInsertedText && !sameText) || isGenerating(editor)) {
          pause('Composer changed before sending. Check ChatGPT before retrying.', 'interrupted', 'send');
          return false;
        }
        const button = sameText ? findSendButton(editor) : null;
        if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
            !button.closest('[inert]')) {
          // Record the intentional send before clicking: the site may update its URL immediately.
          if (newChatHandoff?.from === route) newChatHandoff.clickedAt = Date.now();
          // This is an attempt, not proof of acceptance. Receipt verification
          // in the caller must succeed before changing to "awaiting".
          trackingSendAttempt = true;
          observedStopDuringSend = false;
          button.click();
          return true;
        }
        await signalOrTimeout(Math.min(250, Math.max(0, deadline - Date.now())));
      }
    }
    if (healthyRoute(route)) {
      pause('Could not verify Send button after 3 retries. Check draft before retrying.', 'interrupted', 'send');
    }
    return false;
  }
  // DOM nodes can be replaced when ChatGPT re-renders a conversation. A new
  // node containing the old prompt is NOT sufficient evidence of submission.
  function userTurnKey(message) {
    if (!message) return null;
    const attributes = ['data-message-id', 'data-chatgpt-search-unit-key',
      'data-content-search-unit-key', 'data-turn-key'];
    for (const attribute of attributes) {
      const owner = message.closest('[' + attribute + ']');
      const value = owner?.getAttribute(attribute);
      if (value) return attribute + ':' + value;
    }
    const turn = message.closest('[data-testid^="conversation-turn-"]');
    return turn ? 'conversation-turn:' + turn.getAttribute('data-testid') : null;
  }
  function snapshotUserTurns() {
    const messages = userMessages();
    return { count: messages.length,
      keys: new Set(messages.map(userTurnKey).filter(Boolean)) };
  }
  function hasNewUserReceipt(text, baseline) {
    const messages = userMessages();
    const newest = messages.at(-1);
    if (!newest || C.normalize(extractMessage(newest)) !== C.normalize(text)) return false;
    const key = userTurnKey(newest);
    if (key && baseline.keys.has(key)) return false;
    const grew = messages.length > baseline.count;
    // When older turns are virtualized away, a new stable key plus an old
    // surviving key still proves that a genuinely new turn was appended.
    const retainedOldKey = baseline.keys.size > 0 &&
      messages.some(message => baseline.keys.has(userTurnKey(message)));
    if (!grew && !(key && retainedOldKey)) return false;
    // A matching unsent draft is evidence against successful submission,
    // even if ChatGPT has replaced older message nodes.
    const editor = findEditor();
    if (editor && C.normalize(editorText(editor)) === C.normalize(text)) return false;
    return true;
  }
  async function waitForReceipt(text, baseline, route) {
    const deadline = Date.now() + 15000;
    while (healthyRoute(route) && Date.now() < deadline) {
      if (hasNewUserReceipt(text, baseline)) return true;
      await signalOrTimeout(Math.min(1250, deadline - Date.now()));
    }
    return false;
  }
  async function waitForFirstTurnEvidence(text, userBaseline, oldAssistant, route) {
    // The first send creates a chat and can re-render the original user turn.
    // ChatGPT sometimes changes the user's message markup during that transition;
    // requiring an exact user-bubble match alone causes a false negative.
    // A *new assistant reply* in the *newly assigned chat*, following our Send
    // click, is independent confirmation that ChatGPT accepted a first turn.
    // Response completion is checked SEPARATELY before any second send.
    const deadline = Date.now() + 2 * 60 * 1000;
    let sawStop = false;
    while (healthyRoute(route) && Date.now() < deadline) {
      if (isGenerating()) sawStop = true;
      if (hasNewUserReceipt(text, userBaseline)) {
        return { receipt: 'user', sawStop };
      }
      const latestAssistant = assistantMessages().at(-1);
      if (latestAssistant && latestAssistant !== oldAssistant &&
          C.normalize(assistantText(latestAssistant))) {
        // An assistant turn cannot be used as proof of *completion*, only of
        // submission. The existing waitForResponse still verifies completion.
        return { receipt: 'assistant', sawStop };
      }
      await signalOrTimeout(Math.min(1500, deadline - Date.now()));
    }
    return null;
  }
  function assistantHasCompletedActions(last) {
    if (!last) return false;
    const turn = last.closest('[data-turn-key], [data-testid^="conversation-turn-"]') ||
      last.parentElement?.parentElement || last;
    // Copy/regenerate controls become available on a completed response. The
    // current app-shell nests these in .turn-action-controls. Require the
    // control to follow the assistant content (not the user's earlier footer).
    const buttons = turn.querySelectorAll(
      '[data-testid="copy-turn-action-button"], button[aria-label="Copy"], ' +
      'button[aria-label="Copy response"], button[data-testid="copy-button"], ' +
      'button[aria-label="Regenerate"], button[aria-label="Regenerate response"], ' +
      '.turn-action-controls button'
    );
    return [...buttons].some(button => last.contains(button) ||
      Boolean(last.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING));
  }
  async function waitForResponse(oldAssistant, route, sawStopEarlier = false) {
    const deadline = Date.now() + 10 * 60 * 1000;
    let sawStop = sawStopEarlier, sawReply = false;
    let lastReply = null, lastText = '', replyChangedAt = Date.now();
    // Retry only completion observation, never Send. Retain Stop and reply
    // evidence from the initial wait across all three additional checks.
    const RESPONSE_RETRY_MS = 3000;
    const MAX_RESPONSE_RETRIES = 3;
    for (let retry = 0; retry <= MAX_RESPONSE_RETRIES && healthyRoute(route); retry++) {
      if (retry) setStatus(`Checking response completion — retry ${retry}/${MAX_RESPONSE_RETRIES}…`);
      const checkDeadline = retry === 0 ? deadline : Date.now() + RESPONSE_RETRY_MS;
      while (healthyRoute(route) && Date.now() < checkDeadline) {
        const stop = isGenerating();
        if (stop) sawStop = true;
        const all = assistantMessages();
        const newest = all[all.length - 1];
        if (newest && newest !== oldAssistant) {
          lastReply = newest;
          // Skip full response text reads while ChatGPT is streaming.
          if (!stop) {
            const text = C.normalize(assistantText(newest));
            if (text && text !== lastText) { lastText = text; replyChangedAt = Date.now(); }
            if (text) sawReply = true;
          }
        }
        const stableFor = Date.now() - Math.max(lastAssistantChange, replyChangedAt);
        // Never treat merely an idle composer or absent Stop button as completion.
        // A real new assistant reply AND an observed Stop lifecycle or completion
        // control are both required, plus settling time.
        if (sawReply && !stop && stableFor >= 1700 &&
            (sawStop || assistantHasCompletedActions(lastReply))) return true;
        const remaining = checkDeadline - Date.now();
        if (remaining <= 0) break;
        await signalOrTimeout(Math.min(remaining, sawReply && !stop ? 1800 : 5000));
      }
    }
    return false;
  }
  async function runQueue(route) {
    try {
      while (healthyRoute(route)) {
        if (!state.queue.length) {
          if (pendingWorkflowLoads.get(route)) {
            await signalOrTimeout(250);
            continue;
          }
          // A second tab may append steps immediately after the previous
          // completion. Refresh under the existing sender lock before success.
          const latest = await rpc('getQueue', { route });
          if (!healthyRoute(route)) return;
          applyQueue(route, latest);
          if (state.queue.length) continue;
          break;
        }
        const item = state.queue[0];
        if (item.status !== 'pending') {
          pause('Review uncertain message. Use ✓ Done or ↺ Retry before resuming.', 'interrupted', 'send'); return;
        }
        const attempt = await prepareAndSend(item, route);
        if (!attempt) return;
        const { clicked, userBaseline, oldAssistant } = attempt;
        if (!clicked) {
          // Never restore to pending automatically: editor text may have been inserted.
          if (state.running) pause('Send not confirmed. Check ChatGPT and resolve item manually.', 'interrupted', 'send');
          return;
        }
        setStatus('Checking submitted prompt…');
        const received = await waitForReceipt(item.text, userBaseline, route);
        if (!received) { pause('Could not confirm sent message. Check ChatGPT before continuing.', 'interrupted', 'send'); return; }
        await queueOp('awaiting', { id: item.id }, route); render();
        setStatus('Waiting for response to finish…');
        const finished = await waitForResponse(oldAssistant, route, observedStopDuringSend);
        if (!finished) {
          if (healthyRoute(route)) pause('Response completion uncertain after 3 retries. Verify ChatGPT, then use ✓ Done.', 'interrupted', 'response');
          return;
        }
        trackingSendAttempt = false;
        if (!healthyRoute(route)) return;
        await queueOp('complete', { id: item.id }, route); render();
        if (!healthyRoute(route)) return;
        playCompletionAlarm();
        setStatus('Response complete; continuing queue…');
      }
      if (state.running) pause('Queue complete.', 'success');
    } catch (error) { pause('Queue stopped due to an unexpected page or storage error.', 'interrupted', 'storage'); console.warn('[Queued for ChatGPT]', error); }
  }
  async function runFirstPromptInNewChat(temporaryRoute) {
    const first = state.queue[0];
    if (!first || first.status !== 'pending') {
      pause('Review the first queued prompt before starting.'); return;
    }
    const attempt = await prepareAndSend(first, temporaryRoute);
    if (!attempt) return;
    const { clicked, userBaseline: previousUsers, oldAssistant: previousAssistant, handoff } = attempt;
    if (!clicked) {
      if (state.running) pause('First send uncertain. Check the composer before retrying.', 'interrupted', 'send');
      return;
    }
    setStatus('Creating ChatGPT conversation…');
    const deadline = Date.now() + 90000;
    while (state.running && newChatHandoff === handoff && Date.now() < deadline &&
           !handoff.destination) {
      if (currentRoute() && location.pathname !== lastPathname) scheduleRouteCheck();
      await signalOrTimeout(500);
    }
    if (!state.running || newChatHandoff !== handoff) return;
    const stableRoute = handoff.destination;
    if (!stableRoute || state.route !== stableRoute) {
      pause('Chat ID was not confirmed. Check the first message and retry only after review.', 'interrupted', 'route'); return;
    }
    // A second tab must not send to the newly created conversation while we verify the first prompt.
    await navigator.locks.request('qfc-queue-' + stableRoute, { ifAvailable: true }, async lock => {
      if (!lock) { pause('This new conversation is being controlled by another tab.', 'interrupted', 'route'); return; }
      state.senderLockRoute = stableRoute;
      renderHeader();
      while (state.running && state.routeLoading && Date.now() < deadline) await signalOrTimeout(250);
      if (!healthyRoute(stableRoute) || !state.storageHealthy || state.routeLoading ||
          state.queue[0]?.id !== handoff.id || state.queue[0]?.status !== 'sending') {
        pause('Could not verify queue migration. Review first prompt before resuming.', 'interrupted', 'storage'); return;
      }
      setStatus('Checking the first submitted prompt or reply…');
      const evidence = await waitForFirstTurnEvidence(handoff.text, previousUsers, previousAssistant, stableRoute);
      if (!evidence) {
        pause('First send could not be confirmed. Check ChatGPT before resuming.', 'interrupted', 'send'); return;
      }
      await queueOp('awaiting', { id: handoff.id }, stableRoute);
      setStatus(evidence.receipt === 'assistant'
        ? 'First reply detected; verifying completion…' : 'Waiting for the first response…');
      if (!await waitForResponse(previousAssistant, stableRoute, evidence.sawStop || observedStopDuringSend)) {
        if (healthyRoute(stableRoute)) pause('First response completion uncertain after 3 retries. Use ✓ Done after reviewing.', 'interrupted', 'response');
        return;
      }
      if (!healthyRoute(stableRoute)) return;
      await queueOp('complete', { id: handoff.id }, stableRoute);
      trackingSendAttempt = false;
      newChatHandoff = null;
      if (!healthyRoute(stableRoute)) return;
      playCompletionAlarm();
      setStatus('First response complete; continuing queue…');
      await runQueue(stableRoute);
    });
  }
  // Clicking a saved workflow is a single explicit Start action: acquire the
  // conversation's sending lock BEFORE appending the steps, then run the queue.
  // This avoids adding prompts in a second tab that cannot own the sender lock.
  function startQueue(workflowId = null) {
    if (state.running) {
      if (workflowId) notify('This queue is already running. Pause it before starting a saved workflow.');
      return;
    }
    if (runnerPromise) { notify('Previous queue is stopping. Select Start again when it is ready.'); return; }
    if (state.routeLoading || !state.storageHealthy) {
      if (workflowId) notify('The chat queue is not ready. Reload or try again.');
      return;
    }
    if (!workflowId && !state.queue.length) return;
    const route = state.route;
    if (!isUsableRoute(route)) {
      notify('Open a ChatGPT conversation or New Chat page before starting.'); return;
    }
    const workflow = workflowId ? state.workflows.find(w => w.id === workflowId) : null;
    if (workflowId && !workflow) { notify('Workflow was changed or deleted. Reopen Workflows.'); return; }
    if (state.queue.some(item => item.status !== 'pending')) {
      notify('Review uncertain queued prompts using ✓ Done or ↺ Retry before starting.'); return;
    }
    if (workflow && state.queue.length && !confirm(
      `This chat already has ${state.queue.length} pending prompt(s). Start will send these FIRST, then all ${workflow.steps.length} steps of “${workflow.name}”. Continue?`)) return;
    if (!navigator.locks?.request) { notify('Web Locks unavailable: auto-send disabled to prevent multiple tabs sending.'); return; }
    // Detect edits that happened in another tab after the user approved starting.
    const initialRevision = state.queueRev;
    clearManualAlarm();
    state.running = true;
    idleSince = null;
    clearIdleTimer();
    setStatus(workflow ? `Preparing workflow “${workflow.name}”…` : 'Starting queue…');
    const pendingRunner = navigator.locks.request('qfc-queue-' + route, { ifAvailable: true }, async lock => {
      if (!lock) { pause('Another tab is controlling this conversation queue.'); return; }
      state.senderLockRoute = route;
      renderHeader();
      try {
        applyQueue(route, await rpc('getQueue', { route }));
        if (workflow) {
          if (state.queueRev !== initialRevision) {
            pause('Queue changed in another tab. Review before starting this workflow.'); return;
          }
          if (state.queue.some(item => item.status !== 'pending')) {
            pause('An uncertain queued prompt needs review before starting.'); return;
          }
          // appendWorkflow is one idempotent, all-or-none coordinator mutation.
          // A full queue or deleted workflow is rejected BEFORE any prompt sends.
          const record = await rpc('appendWorkflow', { route, workflowId }, makeOperationId());
          applyQueue(route, record);
          if (state.route !== route) {
            pause('Conversation changed; workflow was saved to the prior chat queue.', 'interrupted', 'route'); return;
          }
          setStatus(`Workflow “${workflow.name}” started — sending in order…`);
        }
        if (!state.queue.length || state.queue[0].status !== 'pending') {
          pause('Queue has changed. Review the first prompt before resuming.'); return;
        }
        // Only the lock owner with a ready queue may register a run.
        // Pause can occur while the queue was being loaded asynchronously.
        if (!healthyRoute(route)) return;
        if (!healthyRoute(route)) return;
        if (route.startsWith('new:')) await runFirstPromptInNewChat(route);
        else await runQueue(route);
      } catch (error) {
        pause(workflow ? 'Could not start workflow. Check queue and storage before retrying.' : 'Unable to load current queue.');
        console.warn('[Queued for ChatGPT]', error);
      }
    }).catch(error => {
      pause('Unable to lock the conversation queue.');
      console.warn('[Queued for ChatGPT]', error);
    }).finally(() => {
      if (runnerPromise === pendingRunner) runnerPromise = null;
      scheduleIdleSleep();
    });
    runnerPromise = pendingRunner;
  }

  async function sleepTab(manual) {
    if (disposed || disposing) return false;
    if (manual) {
      if (uiOperations || pendingWorkflowLoads.size || autoOffWriteLoop || state.routeLoading) {
        notify('Finish the current save or load before turning Queued off.');
        return false;
      }
      if (state.running && !confirm(
        'Pause this running queue and turn off Queued in this tab? Uncertain prompts will need review before restarting.')) return false;
      if (hasUnsavedInput() && !confirm(
        'Discard the unsaved Queued text or workflow edit and turn off only this tab?')) return false;
    } else if (!canSleep()) return false;
    disposing = true;
    clearManualAlarm(); closeAlarmAudio();
    idleSince = null;
    clearIdleTimer();
    // Stop the runner immediately, before an asynchronous shutdown handshake.
    if (state.running) pause('Paused by you.', 'manual');
    // Announce closing while the receiver is still registered. Commands issued
    // during shutdown are deferred until cleanup is actually complete.
    try {
      try { await rpc('tabClosing', { instanceId: PAGE_ID }); } catch (_) { /* Continue safe shutdown. */ }
      // Never tear down a runner before it has released the Web Lock.
      if (runnerPromise) await runnerPromise.catch(() => {});
      if (autoOffWriteLoop) await autoOffWriteLoop.catch(() => {});
    } finally {
      // Finalization must run even when an operation above fails. A partially
      // disposed script must never retain its injection guard permanently.
      clearDomWake();
      for (const timer of transientTimers) clearTimeout(timer);
      transientTimers.clear();
      for (const url of pendingDownloadUrls) {
        try { URL.revokeObjectURL(url); } catch (_) {}
      }
      pendingDownloadUrls.clear();
      if (routeTimer) clearTimeout(routeTimer);
      routeTimer = null;
      try { pageObserver?.disconnect(); } catch (_) {}
      try { wake(); } catch (_) {}
      for (const cleanup of cleanupListeners.splice(0)) {
        try { cleanup(); } catch (_) { /* Continue disposing other listeners. */ }
      }
      try {
        const handle = root?.querySelector('.qfc-drag-handle');
        if (panelDrag && handle?.hasPointerCapture(panelDrag.id)) handle.releasePointerCapture(panelDrag.id);
      } catch (_) {}
      panelDrag = null;
      // Serialize CSS removal before releasing the guard for reinjection.
      try { await rpc('tabSleep'); } catch (_) {}
      try { root?.remove(); } catch (_) {}
      root = queueList = workflowsList = statusLine = queueTextArea = workflowSearch = null;
      state.queue = []; state.workflows = []; state.workflowDraft = null;
      expandedWorkflowIds.clear(); temporaryRouteCache.clear(); temporaryRouteKeys.clear();
      signalListeners.clear(); pendingWorkflowLoads.clear();
      disposed = true;
      globalThis.__qfcContentLoaded = false;
      try { await rpc('tabClosed', { instanceId: PAGE_ID }); } catch (_) {
        // A later toolbar click can now detect that the guard is gone.
      }
    }
    return true;
  }

  function scheduleRouteCheck() {
    if (routeTimer) return;
    routeTimer = setTimeout(() => { routeTimer = null; checkRoute(); }, 250);
  }
  function observePage() {
    pageObserver = new MutationObserver(records => {
      // Keep the full observer subscription for ChatGPT's silent SPA route
      // changes, but avoid expensive assistant selectors when no runner needs
      // response evidence. This also retains characterData-only navigation.
      if (!state.running && signalListeners.size === 0) {
        if (location.pathname !== lastPathname) scheduleRouteCheck();
        return;
      }
      let touched = false;
      for (const change of records) {
        const target = change.target.nodeType === Node.ELEMENT_NODE ? change.target : change.target.parentElement;
        if (target?.closest?.('#qfc-root')) continue;
        if (target?.closest?.(ASSISTANT_SELECTOR)) lastAssistantChange = Date.now();
        if (change.type !== 'childList') { touched = true; continue; }
        for (const added of change.addedNodes) {
          if (added.nodeType !== Node.ELEMENT_NODE) continue;
          if (added.id === 'qfc-root') continue;
          touched = true;
        }
        // Removals can signal the Stop button disappearing or navigation.
        if (change.removedNodes.length) touched = true;
      }
      if (touched) {
        // Stop may appear and disappear while the coordinator acknowledges the
        // user receipt. Retain observed generation evidence for this one send.
        if (trackingSendAttempt && isGenerating()) observedStopDuringSend = true;
        queueDomWake();
        if (location.pathname !== lastPathname) scheduleRouteCheck();
      }
    });
    pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    const onPopState = () => { clearManualAlarm(); scheduleRouteCheck(); };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', scheduleRouteCheck);
    cleanupListeners.push(() => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', scheduleRouteCheck);
    });
    const onDocumentClick = event => {
      // Only a real user click; don't confuse the disappearance of Stop after
      // manual cancellation with successful assistant completion.
      if (state.running && event.isTrusted && event.target.closest?.(STOP_SELECTORS)) {
        pause('Response manually stopped. Review the current queued prompt.', 'manual');
      }
      if (event.isTrusted && alarmEnabled) {
        const editor = findEditor(), send = findSendButton(editor);
        if (event.target.closest?.(STOP_SELECTORS) ||
            (isGenerating(editor) && composerArea(editor)?.contains(event.target) &&
             event.target.closest?.('button'))) clearManualAlarm();
        else if (send && send.contains(event.target)) armManualAlarm();
      }
      const link = event.target.closest?.('a[href]');
      if (link) clearManualAlarm();
      if (link) {
        try {
          const destination = new URL(link.href);
          if (destination.origin === location.origin && C.conversationId(destination.pathname) && !currentRoute()) navigateToExistingChat = true;
        } catch (_) { /* ignore non-URLs */ }
        scheduleRouteCheck();
      }
      if (!currentRoute()) {
        const editor = findEditor();
        const send = findSendButton(editor);
        if (editor && send && (event.target === send || send.contains(event.target)) && C.normalize(editorText(editor))) tempSubmittedAt = Date.now();
      }
    };
    document.addEventListener('click', onDocumentClick, true);
    cleanupListeners.push(() => document.removeEventListener('click', onDocumentClick, true));
    const onDocumentKeydown = event => {
      if (event.isTrusted && alarmEnabled && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && !event.repeat) {
        const editor = findEditor();
        if (editor?.contains(event.target)) armManualAlarm();
      }
      if (currentRoute() || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      const editor = findEditor();
      if (editor && (event.target === editor || editor.contains(event.target)) && C.normalize(editorText(editor))) tempSubmittedAt = Date.now();
    };
    document.addEventListener('keydown', onDocumentKeydown, true);
    cleanupListeners.push(() => document.removeEventListener('keydown', onDocumentKeydown, true));
    const onPageHide = () => { clearManualAlarm(); closeAlarmAudio(); pause('Tab closed or navigating away.', 'abandoned'); };
    window.addEventListener('pagehide', onPageHide);
    cleanupListeners.push(() => window.removeEventListener('pagehide', onPageHide));
  }
  async function initialize() {
    initPanel();
    try {
      const [record, settings] = await Promise.all([
        rpc('getWorkflows'), STORAGE.get([C.SETTINGS_KEY, ALARM_KEY])
      ]);
      applyWorkflows(record);
      // Opening is local to an activation, not the obsolete cross-tab open flag.
      state.open = false;
      autoTurnOffMinutes = C.cleanAutoTurnOffMinutes(settings[C.SETTINGS_KEY]?.autoTurnOffMinutes);
      confirmedAutoTurnOffMinutes = autoTurnOffMinutes;
      applyAlarmSetting(settings[ALARM_KEY]);
      renderAutoTurnOffSetting();
    } catch (_) { state.storageHealthy = false; setStatus('Could not load workflows. Reload the tab.'); }
    checkRoute();
    render();
    setPanelPosition(panelOffsetX, panelOffsetY, { save: true });
    observePage();
    const onStorageChanged = (changes, area) => {
      if (disposed || disposing || area !== 'local') return;
      if (changes[C.SETTINGS_KEY] && !autoOffWriteLoop &&
          autoOffRevision === savedAutoOffRevision) {
        autoTurnOffMinutes = C.cleanAutoTurnOffMinutes(changes[C.SETTINGS_KEY].newValue?.autoTurnOffMinutes);
        confirmedAutoTurnOffMinutes = autoTurnOffMinutes;
        autoOffSaveStatus = 'Saved';
        renderAutoTurnOffSetting();
        scheduleIdleSleep({ reset: true });
      }
      if (changes[ALARM_KEY]) applyAlarmSetting(changes[ALARM_KEY].newValue);
      if (changes[C.WORKFLOWS_KEY]) applyWorkflows(changes[C.WORKFLOWS_KEY].newValue);
      if (state.route && changes[C.queueKey(state.route)]) applyQueue(state.route, changes[C.queueKey(state.route)].newValue);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    cleanupListeners.push(() => chrome.storage.onChanged.removeListener?.(onStorageChanged));
    initialized = true;
    root.style.visibility = '';
    queuedInteraction();
  }
  // A startup failure must not leave a guarded, invisible instance behind.
  // Do not use sleepTab here: its tabSleep RPC waits on the same worker task
  // that is awaiting this initialization. No runner can start before readiness.
  function failedInitialization(error) {
    disposed = true;
    clearManualAlarm(); closeAlarmAudio();
    initialized = false;
    routeLoadGeneration++; // Ignore any in-flight startup route read.
    clearIdleTimer();
    if (routeTimer) clearTimeout(routeTimer);
    routeTimer = null;
    clearDomWake();
    for (const timer of transientTimers) clearTimeout(timer);
    transientTimers.clear();
    try { pageObserver?.disconnect(); } catch (_) {}
    for (const cleanup of cleanupListeners.splice(0)) {
      try { cleanup(); } catch (_) {}
    }
    try { root?.remove(); } catch (_) {}
    root = queueList = workflowsList = statusLine = queueTextArea = workflowSearch = null;
    globalThis.__qfcContentLoaded = false;
    console.warn('[Queued for ChatGPT] Panel initialization failed.', error);
    return false;
  }
  function onUiMessage(message, sender, sendResponse) {
    if (sender?.id !== chrome.runtime.id || message?.app !== 'qfc-ui-v1') return false;
    if (message.action === 'status') {
      sendResponse({
        active: !disposed && !disposing,
        attached: Boolean(root?.isConnected),
        closing: disposing && !disposed,
        ready: initialized,
        open: state.open,
        instanceId: PAGE_ID
      });
      return false;
    }
    if (message.action !== 'open-panel' && message.action !== 'toggle-panel') return false;
    void Promise.resolve(initializationReady).then(() => {
      if (disposed || disposing || !root) return { active: false };
      // The site may replace its DOM while this instance is still alive.
      // Reattach the same panel (and its draft/runner), never inject a second one.
      const detached = !root.isConnected;
      if (detached) {
        if (!document.body) return { active: false };
        document.body.append(root);
        if (pageObserver) {
          pageObserver.disconnect();
          pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        }
      }
      if (message.action === 'toggle-panel' && !detached) togglePanel();
      else if (!state.open || detached) {
        state.open = true;
        render();
        setPanelPosition(panelOffsetX, panelOffsetY, { save: true });
      }
      queuedInteraction();
      return { active: true, ready: true };
    }).then(sendResponse, () => sendResponse({ active: false }));
    return true;
  }
  // Claim the guard only once synchronous setup is complete and ensure every
  // asynchronous initialization rejection releases it before the worker retries.
  globalThis.__qfcContentLoaded = true;
  try {
    chrome.runtime.onMessage.addListener(onUiMessage);
    cleanupListeners.push(() => chrome.runtime.onMessage.removeListener?.(onUiMessage));
    if (document.body) initializationReady = initialize().catch(failedInitialization);
    else initializationReady = new Promise(resolve => {
      const ready = () => resolve(initialize());
      document.addEventListener('DOMContentLoaded', ready, { once: true });
      cleanupListeners.push(() => document.removeEventListener('DOMContentLoaded', ready));
    }).catch(failedInitialization);
  } catch (error) {
    failedInitialization(error);
  }
})();
