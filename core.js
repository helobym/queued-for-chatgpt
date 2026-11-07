/* Queued for ChatGPT — independent utility functions (no third-party code). */
(function (root) {
  'use strict';
  const VERSION = 2;
  const MAX_PROMPT_LENGTH = 20000;
  const MAX_FAVORITES = 1000;
  const MAX_QUEUE = 100;
  const FAV_KEY = 'qfc_v2_favorites';
  const SETTINGS_KEY = 'qfc_v1_settings';
  const NOTIFICATION_SETTINGS_KEY = 'qfc_v1_notification_settings';
  const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
    enabled: true, onSuccess: true, onInterrupted: true,
    sound: 'system', soundDuration: 'once', soundVolume: 75, visibility: 'system'
  });
  function validSoundDuration(value) {
    return value === 'once' || (typeof value === 'string' && /^(?:[1-9]|[1-5][0-9]|60)$/.test(value));
  }
  function validSoundVolume(value) {
    return Number.isInteger(value) && value >= 0 && value <= 100;
  }
  function cleanNotificationSettings(input) {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const defaults = DEFAULT_NOTIFICATION_SETTINGS;
    return {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
      onSuccess: typeof value.onSuccess === 'boolean' ? value.onSuccess : defaults.onSuccess,
      onInterrupted: typeof value.onInterrupted === 'boolean' ? value.onInterrupted : defaults.onInterrupted,
      sound: ['system', 'soft', 'double', 'alert', 'silent'].includes(value.sound) ? value.sound : defaults.sound,
      soundDuration: validSoundDuration(value.soundDuration) ? value.soundDuration : defaults.soundDuration,
      soundVolume: validSoundVolume(value.soundVolume) ? value.soundVolume : defaults.soundVolume,
      visibility: ['system', 'persistent'].includes(value.visibility) ? value.visibility : defaults.visibility
    };
  }
  const WORKFLOWS_KEY = 'qfc_v3_workflows';
  const MAX_WORKFLOWS = 200;
  const MAX_WORKFLOW_CHARS = 150000;
  const MAX_WORKFLOWS_TOTAL_CHARS = 750000;
  const MAX_WORKFLOW_NAME = 100;
  const MAX_ACTIVITY_PREVIEW = 160;

  function normalize(text) {
    return String(text ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  }
  function validText(text) {
    return typeof text === 'string' && normalize(text).length > 0 && text.length <= MAX_PROMPT_LENGTH;
  }
  function id() {
    return (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() :
      'qfc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }
  function conversationId(path) {
    const match = String(path || '').match(/(?:^|\/)c\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    return match ? 'chat:' + match[1] : null;
  }
  function queueKey(conversation) {
    if (!/^chat:[a-zA-Z0-9_-]+$|^new:[a-zA-Z0-9_-]+$/.test(conversation || '')) {
      throw new Error('Invalid conversation identifier');
    }
    return 'qfc_v2_queue_' + conversation;
  }
  function newQueueItem(text, workflow = null) {
    if (!validText(text)) throw new Error('Prompt must be 1–20,000 characters.');
    const item = { id: id(), text: text.trim(), status: 'pending', createdAt: Date.now() };
    if (workflow) {
      const origin = cleanWorkflowOrigin(workflow);
      if (!origin) throw new Error('Invalid workflow origin.');
      item.workflow = origin;
    }
    return item;
  }
  function cleanQueue(items) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, MAX_QUEUE).filter(item => item && validText(item.text)).map(item => {
      const clean = {
        id: typeof item.id === 'string' && item.id.length <= 100 ? item.id : id(),
        text: item.text,
        status: ['pending', 'sending', 'awaiting'].includes(item.status) ? item.status : 'pending',
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
      };
      const origin = cleanWorkflowOrigin(item.workflow);
      if (origin) clean.workflow = origin;
      return clean;
    });
  }
  function cleanFavorites(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const result = [];
    for (const item of items.slice(0, MAX_FAVORITES * 2)) {
      if (!item || !validText(item.text)) continue;
      const key = normalize(item.text);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: typeof item.id === 'string' && item.id.length <= 100 ? item.id : id(),
        text: item.text,
        sources: [...new Set((Array.isArray(item.sources) ? item.sources : [item.source])
          .filter(x => x === 'queued' || x === 'sent'))],
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now()
      });
      if (result.length >= MAX_FAVORITES) break;
    }
    return result;
  }
  function toggleFavorite(items, text, source) {
    if (!validText(text)) throw new Error('Cannot save this message as a favorite.');
    const clean = cleanFavorites(items);
    const key = normalize(text);
    const match = clean.find(fav => normalize(fav.text) === key);
    if (match) return { favorites: clean.filter(fav => fav.id !== match.id), added: false };
    if (clean.length >= MAX_FAVORITES) throw new Error('Favorite limit reached (1,000).');
    return { favorites: [{ id: id(), text: text.trim(), sources: [source], createdAt: Date.now(), updatedAt: Date.now() }, ...clean], added: true };
  }
  function upsertFavorite(items, text, source) {
    if (!validText(text)) throw new Error('Cannot save this message as a favorite.');
    const clean = cleanFavorites(items);
    const existing = clean.find(fav => normalize(fav.text) === normalize(text));
    if (existing) {
      existing.sources = [...new Set([...existing.sources, source].filter(s => ['queued', 'sent'].includes(s)))];
      return { favorites: clean, added: false };
    }
    if (clean.length >= MAX_FAVORITES) throw new Error('Favorite limit reached (1,000).');
    return { favorites: [{ id: id(), text: text.trim(), sources: [source], createdAt: Date.now(), updatedAt: Date.now() }, ...clean], added: true };
  }
  function importFavorites(payload, existing) {
    if (payload && !Array.isArray(payload) && payload.app !== 'Queued for ChatGPT') {
      throw new Error('Not a Queued for ChatGPT favorites backup.');
    }
    const incoming = Array.isArray(payload) ? payload : payload && payload.favorites;
    if (!Array.isArray(incoming)) throw new Error('Backup is missing favorites.');
    let merged = cleanFavorites(existing);
    let added = 0;
    for (const fav of cleanFavorites(incoming)) {
      const sources = fav.sources.length ? fav.sources : ['sent'];
      for (const source of sources) {
        const result = upsertFavorite(merged, fav.text, source);
        merged = result.favorites;
        if (result.added) added++;
      }
    }
    return { favorites: merged, added };
  }
  function validWorkflowName(name) {
    return typeof name === 'string' && normalize(name).length > 0 && name.trim().length <= MAX_WORKFLOW_NAME;
  }
  function cleanWorkflowOrigin(value) {
    if (!value || typeof value !== 'object' ||
        typeof value.id !== 'string' || !value.id || value.id.length > 100 ||
        !validWorkflowName(value.name) ||
        !Number.isInteger(value.step) || !Number.isInteger(value.total) ||
        value.step < 1 || value.total > MAX_QUEUE || value.step > value.total) return null;
    return { id: value.id, name: value.name.trim(), step: value.step, total: value.total };
  }
  function cleanLastCompleted(value) {
    if (!value || typeof value !== 'object' ||
        typeof value.id !== 'string' || !value.id || value.id.length > 100 ||
        !validText(value.preview) ||
        !Number.isFinite(value.completedAt) || value.completedAt < 0 ||
        !['automatic', 'confirmed'].includes(value.completion)) return null;
    const clean = {
      id: value.id, preview: value.preview.slice(0, MAX_ACTIVITY_PREVIEW),
      completedAt: value.completedAt, completion: value.completion
    };
    const workflow = cleanWorkflowOrigin(value.workflow);
    if (workflow) clean.workflow = workflow;
    return clean;
  }
  function cleanWorkflowSteps(steps) {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_QUEUE ||
        !steps.every(validText)) throw new Error('Workflows need 1–100 nonempty prompts, up to 20,000 characters each.');
    if (steps.reduce((size, text) => size + text.length, 0) > MAX_WORKFLOW_CHARS)
      throw new Error('Workflow text exceeds 150,000 characters.');
    return steps.map(text => text.trim());
  }
  function cleanWorkflows(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const result = [];
    for (const item of items.slice(0, MAX_WORKFLOWS * 2)) {
      if (!item || !validWorkflowName(item.name)) continue;
      let steps;
      try { steps = cleanWorkflowSteps(item.steps); } catch (_) { continue; }
      const key = normalize(item.name).toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: typeof item.id === 'string' && item.id.length <= 100 ? item.id : id(),
        name: item.name.trim(), steps,
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now()
      });
      if (result.length >= MAX_WORKFLOWS) break;
    }
    return result;
  }
  const api = { VERSION, MAX_PROMPT_LENGTH, MAX_FAVORITES, MAX_QUEUE, FAV_KEY, SETTINGS_KEY,
    NOTIFICATION_SETTINGS_KEY, DEFAULT_NOTIFICATION_SETTINGS, cleanNotificationSettings,
    validSoundDuration, validSoundVolume,
    WORKFLOWS_KEY, MAX_WORKFLOWS, MAX_WORKFLOW_CHARS, MAX_WORKFLOWS_TOTAL_CHARS, MAX_ACTIVITY_PREVIEW,
    validWorkflowName, cleanWorkflowSteps, cleanWorkflows, cleanWorkflowOrigin, cleanLastCompleted,
    normalize, validText, conversationId, queueKey, newQueueItem, cleanQueue,
    cleanFavorites, toggleFavorite, upsertFavorite, importFavorites };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QFC = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
