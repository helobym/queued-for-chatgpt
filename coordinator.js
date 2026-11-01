/* Queued for ChatGPT v1.1 — deterministic mutation functions, no dependencies. */
(function (root) {
  'use strict';
  const C = root.QFC || (typeof require !== 'undefined' ? require('./core.js') : null);
  function error(message) { throw new Error(message); }
  function record(items, rev = 0, ops = [], lastCompleted = null) {
    const result = { version: 2, rev, items, ops };
    const previous = C.cleanLastCompleted(lastCompleted);
    if (previous) result.lastCompleted = previous;
    return result;
  }
  function clean(recordValue, kind) {
    const value = recordValue || {};
    const raw = Array.isArray(value) ? value : value.items;
    const items = kind === 'favorites' ? C.cleanFavorites(raw) : kind === 'workflows' ? C.cleanWorkflows(raw) : C.cleanQueue(raw);
    return record(items, Number.isSafeInteger(value.rev) && value.rev >= 0 ? value.rev : 0,
      Array.isArray(value.ops) ? value.ops.filter(x => typeof x === 'string').slice(-80) : [],
      kind === 'queue' ? value.lastCompleted : null);
  }
  function mutateQueue(items, mutation) {
    let next = C.cleanQueue(items);
    const { type, id, text } = mutation;
    const i = next.findIndex(q => q.id === id);
    switch (type) {
      case 'addMany': {
        if (!Array.isArray(mutation.steps)) error('Invalid workflow steps.');
        const steps = C.cleanWorkflowSteps(mutation.steps);
        if (next.length + steps.length > C.MAX_QUEUE) error('Not enough room in the queue for the entire workflow (100 prompts maximum).');
        const workflow = mutation.workflow;
        if (workflow && !C.cleanWorkflowOrigin({ id: workflow.id, name: workflow.name,
          step: 1, total: steps.length })) error('Invalid workflow origin.');
        next.push(...steps.map((step, index) => C.newQueueItem(step, workflow ? {
          id: workflow.id, name: workflow.name, step: index + 1, total: steps.length
        } : null)));
        break;
      }
      case 'add':
        if (next.length >= C.MAX_QUEUE) error('Queue limit reached (100 prompts).');
        next.push(C.newQueueItem(text)); break;
      case 'edit':
        if (i < 0 || next[i].status !== 'pending') error('Prompt is no longer editable. Reload the queue.');
        if (!C.validText(text)) error('Prompt must be 1–20,000 characters.');
        next[i].text = text.trim(); break;
      case 'remove':
        if (i < 0 || next[i].status !== 'pending') error('Prompt cannot be removed while in flight.');
        next.splice(i, 1); break;
      case 'move': {
        if (i < 0 || next[i].status !== 'pending' || !['up', 'down'].includes(mutation.direction)) error('Prompt cannot be moved.');
        const j = i + (mutation.direction === 'up' ? -1 : 1);
        if (j < 0 || j >= next.length || next[j].status !== 'pending') error('Cannot reorder across an in-flight prompt.');
        [next[i], next[j]] = [next[j], next[i]]; break;
      }
      case 'clear':
        // Never drop an uncertain/in-flight message without the user's explicit resolution.
        if (next.some(q => q.status !== 'pending')) error('Resolve any uncertain prompt before clearing the queue.');
        next = []; break;
      case 'sending':
        if (!next.length || next[0].id !== id || next[0].status !== 'pending') error('Queue changed before sending. Paused.');
        next[0].status = 'sending'; break;
      case 'awaiting':
        if (!next.length || next[0].id !== id || next[0].status !== 'sending') error('Submission state changed. Paused.');
        next[0].status = 'awaiting'; break;
      case 'complete':
        if (!next.length || next[0].id !== id || next[0].status !== 'awaiting') error('Response state changed. Paused.');
        next.shift(); break;
      case 'confirm-done':
        if (!mutation.confirmed || !next.length || next[0].id !== id || next[0].status === 'pending') error('Confirm the first uncertain prompt before removing it.');
        next.shift(); break;
      case 'confirm-retry':
        if (!mutation.confirmed || !next.length || next[0].id !== id || next[0].status === 'pending') error('Confirm that the first uncertain prompt was not sent.');
        next[0].status = 'pending'; break;
      default: error('Unknown queue operation.');
    }
    return next;
  }
  function mutateFavorites(items, mutation) {
    let next = C.cleanFavorites(items);
    const i = next.findIndex(f => f.id === mutation.id);
    switch (mutation.type) {
      case 'set': {
        if (!C.validText(mutation.text)) error('Cannot change an empty Favorite.');
        const key = C.normalize(mutation.text);
        if (mutation.favorite === true) return C.upsertFavorite(next, mutation.text, mutation.source).favorites;
        if (mutation.favorite === false) return next.filter(f => C.normalize(f.text) !== key);
        error('Invalid Favorite intent.');
      }
      case 'toggle': return C.toggleFavorite(next, mutation.text, mutation.source).favorites;
      case 'upsert': return C.upsertFavorite(next, mutation.text, mutation.source).favorites;
      case 'remove':
        if (i < 0) error('Favorite was already removed.');
        next.splice(i, 1); return next;
      case 'edit':
        if (i < 0) error('Favorite no longer exists.');
        if (!C.validText(mutation.text)) error('Favorite must be 1–20,000 characters.');
        if (next.some((f, n) => n !== i && C.normalize(f.text) === C.normalize(mutation.text))) error('This prompt already exists in Favorites.');
        // Version check guards against silently overwriting a concurrent edit of this same item.
        if (mutation.expectedUpdatedAt !== next[i].updatedAt) error('Favorite changed in another tab. Review the updated text before editing.');
        next[i].text = mutation.text.trim(); next[i].updatedAt = Math.max(Date.now(), next[i].updatedAt + 1); return next;
      case 'import':
        return C.importFavorites(mutation.payload, next).favorites;
      default: error('Unknown Favorites operation.');
    }
  }
  function mutateWorkflows(items, mutation) {
    const next = C.cleanWorkflows(items);
    const index = next.findIndex(w => w.id === mutation.id);
    const nameTaken = name => next.some((w, i) => i !== index &&
      C.normalize(w.name).toLocaleLowerCase() === C.normalize(name).toLocaleLowerCase());
    switch (mutation.type) {
      case 'create': {
        if (next.length >= C.MAX_WORKFLOWS) error('Workflow limit reached (200).');
        if (!C.validWorkflowName(mutation.name)) error('Workflow name must be 1–100 characters.');
        const steps = C.cleanWorkflowSteps(mutation.steps);
        if (nameTaken(mutation.name)) error('A workflow with that name already exists.');
        const now = Date.now();
        next.unshift({id: C.newQueueItem('id').id, name: mutation.name.trim(), steps, createdAt: now, updatedAt: now});
        return next;
      }
      case 'edit': {
        if (index < 0) error('Workflow no longer exists.');
        if (mutation.expectedUpdatedAt !== next[index].updatedAt) error('Workflow changed in another tab. Reopen it before editing.');
        if (!C.validWorkflowName(mutation.name)) error('Workflow name must be 1–100 characters.');
        if (nameTaken(mutation.name)) error('A workflow with that name already exists.');
        next[index].name = mutation.name.trim();
        next[index].steps = C.cleanWorkflowSteps(mutation.steps);
        next[index].updatedAt = Math.max(Date.now(), next[index].updatedAt + 1);
        return next;
      }
      case 'remove':
        if (index < 0) error('Workflow no longer exists.');
        if (mutation.expectedUpdatedAt !== next[index].updatedAt) error('Workflow changed in another tab. Reload before deleting.');
        next.splice(index, 1);
        return next;
      case 'import': {
        const payload = mutation.payload;
        if (!payload || payload.app !== 'Queued for ChatGPT' || payload.kind !== 'workflows' || !Array.isArray(payload.workflows)) error('Invalid workflow backup.');
        if (payload.workflows.length > C.MAX_WORKFLOWS) error('Workflow backup exceeds the limit.');
        // Reject invalid items instead of silently dropping or truncating them.
        for (const w of payload.workflows) {
          if (!w || !C.validWorkflowName(w.name)) error('Workflow backup contains an invalid name.');
          C.cleanWorkflowSteps(w.steps);
        }
        const already = new Set(next.map(w => C.normalize(w.name).toLocaleLowerCase()));
        for (const w of payload.workflows) {
          const key = C.normalize(w.name).toLocaleLowerCase();
          if (already.has(key)) continue;
          if (next.length >= C.MAX_WORKFLOWS) error('Workflow limit reached while importing.');
          already.add(key);
          const now = Date.now();
          next.push({id: C.newQueueItem('import').id, name: w.name.trim(), steps: C.cleanWorkflowSteps(w.steps), createdAt: now, updatedAt: now});
        }
        return next;
      }
      default: error('Unknown workflow operation.');
    }
  }
  function transact(existing, kind, mutation, operationId) {
    if (!/^[a-zA-Z0-9_-]{8,120}$/.test(operationId || '')) error('Invalid operation identifier.');
    const current = clean(existing, kind);
    if (current.ops.includes(operationId)) return { record: current, duplicate: true };
    const items = kind === 'favorites' ? mutateFavorites(current.items, mutation) : kind === 'workflows' ? mutateWorkflows(current.items, mutation) : mutateQueue(current.items, mutation);
    if (kind === 'workflows' && items.reduce((size, w) => size + w.name.length + w.steps.reduce((n, step) => n + step.length, 0), 0) > C.MAX_WORKFLOWS_TOTAL_CHARS)
      error('Saved workflow library exceeds the 750,000-character lightweight storage limit.');
    let lastCompleted = kind === 'queue' ? current.lastCompleted : null;
    if (kind === 'queue' && ['complete', 'confirm-done'].includes(mutation.type)) {
      const finished = current.items[0];
      lastCompleted = C.cleanLastCompleted({
        id: finished.id, preview: finished.text.trim().slice(0, C.MAX_ACTIVITY_PREVIEW),
        completedAt: Date.now(),
        completion: mutation.type === 'complete' ? 'automatic' : 'confirmed',
        workflow: finished.workflow
      });
    }
    return { record: record(items, current.rev + 1, [...current.ops, operationId].slice(-80), lastCompleted), duplicate: false };
  }
  const api = { record, clean, mutateQueue, mutateFavorites, mutateWorkflows, transact };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QFCCoordinator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
