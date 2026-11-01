'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const M = require('../coordinator.js');
function op(type, extra = {}) { return { type, ...extra }; }
let n = 0;
function trans(rec, kind, mutation) { return M.transact(rec, kind, mutation, `test-op-${++n}`.padEnd(12, 'x')).record; }
test('simultaneous queue adds compose without last writer wins', () => {
  let q = M.record([]);
  q = trans(q, 'queue', op('add', { text: 'first' }));
  q = trans(q, 'queue', op('add', { text: 'second' }));
  assert.deepEqual(q.items.map(x => x.text), ['first', 'second']);
  assert.equal(q.rev, 2);
});
test('operation IDs are idempotent after worker restart', () => {
  const action = { type: 'add', text: 'Once' };
  const first = M.transact(null, 'queue', action, 'fixed-op-1234');
  const retry = M.transact(JSON.parse(JSON.stringify(first.record)), 'queue', action, 'fixed-op-1234');
  assert.equal(retry.duplicate, true);
  assert.equal(retry.record.items.length, 1);
});
test('in-flight queue cannot be reordered, cleared, or duplicated by second sender', () => {
  let q = M.record([]);
  q = trans(q, 'queue', op('add', { text: 'A' }));
  q = trans(q, 'queue', op('add', { text: 'B' }));
  const id = q.items[0].id;
  q = trans(q, 'queue', op('sending', { id }));
  assert.throws(() => trans(q, 'queue', op('sending', { id })));
  assert.throws(() => trans(q, 'queue', op('clear')));
  assert.throws(() => trans(q, 'queue', op('move', { id, direction: 'down' })));
  q = trans(q, 'queue', op('awaiting', { id }));
  q = trans(q, 'queue', op('complete', { id }));
  assert.deepEqual(q.items.map(x => x.text), ['B']);
});
test('manual recovery requires explicit confirmation and oldest uncertain item', () => {
  let q = M.record([{ id: 'abc', text: 'A', status: 'awaiting' }, { id: 'def', text: 'B', status: 'pending' }]);
  assert.throws(() => trans(q, 'queue', op('confirm-retry', { id: 'abc' })));
  assert.throws(() => trans(q, 'queue', op('confirm-done', { id: 'def', confirmed: true })));
  q = trans(q, 'queue', op('confirm-retry', { id: 'abc', confirmed: true }));
  assert.equal(q.items[0].status, 'pending');
});
test('cross-tab Favorites saves merge, deduplicate and preserve provenance', () => {
  let f = M.record([]);
  f = trans(f, 'favorites', op('upsert', { text: 'A', source: 'queued' }));
  f = trans(f, 'favorites', op('upsert', { text: 'B', source: 'sent' }));
  f = trans(f, 'favorites', op('upsert', { text: 'A', source: 'sent' }));
  assert.equal(f.items.length, 2);
  assert.deepEqual(f.items.find(x => x.text === 'A').sources, ['queued', 'sent']);
});
test('concurrent edit of same favorite fails with stale version', () => {
  let f = trans(M.record([]), 'favorites', op('upsert', { text: 'A', source: 'sent' }));
  const id = f.items[0].id, stamp = f.items[0].updatedAt;
  f = trans(f, 'favorites', op('edit', { id, text: 'Updated', expectedUpdatedAt: stamp }));
  assert.throws(() => trans(f, 'favorites', op('edit', { id, text: 'Lost change', expectedUpdatedAt: stamp })), /changed/);
});
test('v1 queue and favorite records cleanly upgrade, uncertain status retained', () => {
  const old = { version: 1, writer: 'old', items: [{ id: 'x', text: 'Check me', status: 'sending' }] };
  const v2 = M.clean(old, 'queue');
  assert.equal(v2.version, 2);
  assert.equal(v2.items[0].status, 'sending');
  assert.equal(M.clean({ version: 1, items: [{ text: 'Fav', sources: ['queued', 'sent'] }] }, 'favorites').items.length, 1);
});

test('completion snapshots only the confirmed queue head and keeps one previous item', () => {
  let q = M.record([]);
  q = trans(q, 'queue', op('add', { text: 'First prompt' }));
  q = trans(q, 'queue', op('add', { text: 'Second prompt' }));
  const id = q.items[0].id;
  q = trans(q, 'queue', op('sending', { id }));
  assert.equal(q.lastCompleted, undefined);
  q = trans(q, 'queue', op('awaiting', { id }));
  q = trans(q, 'queue', op('complete', { id }));
  assert.equal(q.lastCompleted.id, id);
  assert.equal(q.lastCompleted.preview, 'First prompt');
  assert.equal(q.lastCompleted.completion, 'automatic');
  const saved = q.lastCompleted;
  q = trans(q, 'queue', op('add', { text: 'Third prompt' }));
  assert.deepEqual(q.lastCompleted, saved);
  const retryId = q.items[0].id;
  q = trans(q, 'queue', op('sending', { id: retryId }));
  q = trans(q, 'queue', op('confirm-retry', { id: retryId, confirmed: true }));
  assert.deepEqual(q.lastCompleted, saved);
  q = trans(q, 'queue', op('sending', { id: retryId }));
  q = trans(q, 'queue', op('confirm-done', { id: retryId, confirmed: true }));
  assert.equal(q.lastCompleted.id, retryId);
  assert.equal(q.lastCompleted.completion, 'confirmed');
  assert.deepEqual(M.clean(JSON.parse(JSON.stringify(q)), 'queue').lastCompleted, q.lastCompleted);
});
test('snapshot is not rewritten by duplicate completion operation', () => {
  let q = M.record([{ id: 'first', text: 'First', status: 'awaiting' }]);
  const cmd = { type: 'complete', id: 'first' };
  const first = M.transact(q, 'queue', cmd, 'activity-once-123').record;
  const replay = M.transact(first, 'queue', cmd, 'activity-once-123');
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.record.lastCompleted, first.lastCompleted);
});
