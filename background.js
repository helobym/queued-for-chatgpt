/* Queued for ChatGPT v1.2.3 — local event-driven, single-writer storage coordinator. */
'use strict';
importScripts('core.js', 'coordinator.js');
const C = globalThis.QFC;
const M = globalThis.QFCCoordinator;
const V1_FAVORITES = 'qfc_v1_favorites';
const V1_QUEUE_PREFIX = 'qfc_v1_queue_';
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
  serialized(async () => {
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
