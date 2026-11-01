'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

test('conversation IDs are strict and chat-local', () => {
  assert.equal(core.conversationId('/c/abcd-123'), 'chat:abcd-123');
  assert.equal(core.conversationId('/g/g-foo/c/abc_123'), 'chat:abc_123');
  assert.equal(core.conversationId('/'), null);
  assert.equal(core.conversationId('/g/g-foo'), null);
  assert.equal(core.queueKey('chat:abc-12'), 'qfc_v2_queue_chat:abc-12');
  assert.throws(() => core.queueKey('../../other'));
});
test('normalization deduplicates whitespace but preserves original favorite', () => {
  const fav = core.upsertFavorite([], 'Hello\n\t world', 'queued');
  const second = core.upsertFavorite(fav.favorites, ' Hello   world ', 'sent');
  assert.equal(second.added, false);
  assert.equal(second.favorites.length, 1);
  assert.equal(second.favorites[0].text, 'Hello\n\t world');
  assert.deepEqual(second.favorites[0].sources, ['queued', 'sent']);
});
test('star toggles a favorite', () => {
  const a = core.toggleFavorite([], 'Prompt', 'sent');
  assert.equal(a.added, true);
  const b = core.toggleFavorite(a.favorites, 'Prompt', 'queued');
  assert.equal(b.added, false);
  assert.equal(b.favorites.length, 0);
});
test('cleanQueue keeps uncertain statuses for recovery', () => {
  const queue = core.cleanQueue([{ text: 'a', id: 'x', status: 'sending' }, { text: 'b', status: 'awaiting' }]);
  assert.equal(queue[0].status, 'sending');
  assert.equal(queue[1].status, 'awaiting');
});
test('import merges favorite backups without duplicates', () => {
  const existing = core.upsertFavorite([], 'Repeat', 'queued').favorites;
  const data = { app: 'Queued for ChatGPT', favorites: [{ text: 'Repeat', sources: ['sent'] }, { text: 'New item', sources: ['sent'] }] };
  const { favorites, added } = core.importFavorites(data, existing);
  assert.equal(added, 1);
  assert.equal(favorites.length, 2);
});
test('invalid prompts are refused', () => {
  assert.throws(() => core.newQueueItem('  '));
  assert.throws(() => core.newQueueItem('x'.repeat(20001)));
  assert.equal(core.validText('abc'), true);
});
test('import retains both provenance labels', () => {
  const result = core.importFavorites({ app: 'Queued for ChatGPT', favorites: [
    { text: 'One', sources: ['queued', 'sent'] }
  ]}, []);
  assert.deepEqual(result.favorites[0].sources, ['queued', 'sent']);
});

test('workflow origin and recent activity data are validated and survive cleaning', () => {
  const workflow = { id: 'flow-1', name: 'Research', step: 2, total: 3 };
  const item = core.newQueueItem('Second prompt', workflow);
  assert.deepEqual(core.cleanQueue([item])[0].workflow, workflow);
  assert.equal(core.cleanQueue([{ ...item, workflow: { ...workflow, step: 4 } }])[0].workflow, undefined);
  assert.throws(() => core.newQueueItem('Prompt', { ...workflow, step: 0 }), /Invalid workflow/);
  const snapshot = core.cleanLastCompleted({
    id: item.id, preview: 'x'.repeat(250), completedAt: 123,
    completion: 'automatic', workflow
  });
  assert.equal(snapshot.preview.length, core.MAX_ACTIVITY_PREVIEW);
  assert.deepEqual(snapshot.workflow, workflow);
  assert.equal(core.cleanLastCompleted({ ...snapshot, completion: 'unconfirmed' }), null);
});
