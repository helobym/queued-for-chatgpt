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

test('notification settings default safely and use an independent storage key', () => {
  assert.equal(core.NOTIFICATION_SETTINGS_KEY, 'qfc_v1_notification_settings');
  const defaults = core.cleanNotificationSettings();
  assert.deepEqual(defaults, {
    enabled: true, onSuccess: true, onInterrupted: true,
    sound: 'system', soundDuration: 'once', soundVolume: 75, visibility: 'system'
  });
  assert.notEqual(core.NOTIFICATION_SETTINGS_KEY, core.SETTINGS_KEY);
});
test('notification settings clean strictly validates types and allowed options', () => {
  assert.deepEqual(core.cleanNotificationSettings({
    enabled: false, onSuccess: true, onInterrupted: false,
    sound: 'alert', soundDuration: '20', soundVolume: 90, visibility: 'persistent', extra: 'ignored'
  }), {
    enabled: false, onSuccess: true, onInterrupted: false,
    sound: 'alert', soundDuration: '20', soundVolume: 90, visibility: 'persistent'
  });
  assert.deepEqual(core.cleanNotificationSettings({
    enabled: 'false', onSuccess: 1, onInterrupted: null,
    sound: 'https://not-allowed', soundDuration: '999', soundVolume: 500, visibility: 'forever'
  }), core.cleanNotificationSettings());
  assert.deepEqual(core.cleanNotificationSettings([]), core.cleanNotificationSettings());
});

test('custom durations and volume are bounded and legacy values remain valid', () => {
  for (const duration of ['once', '1', '2', '5', '10', '20', '59', '60']) {
    assert.equal(core.cleanNotificationSettings({soundDuration:duration}).soundDuration,duration);
    assert.equal(core.validSoundDuration(duration),true);
  }
  for (const duration of ['0', '61', '01', '1.5', ' 5', '999', 5, null]) {
    assert.equal(core.validSoundDuration(duration),false);
    assert.equal(core.cleanNotificationSettings({soundDuration:duration}).soundDuration,'once');
  }
  for (const volume of [0,1,75,99,100]) {
    assert.equal(core.validSoundVolume(volume),true);
    assert.equal(core.cleanNotificationSettings({soundVolume:volume}).soundVolume,volume);
  }
  for (const volume of [-1,101,75.5,'75',null]) {
    assert.equal(core.validSoundVolume(volume),false);
    assert.equal(core.cleanNotificationSettings({soundVolume:volume}).soundVolume,75);
  }
});


test('auto turn-off duration has safe defaults and supports Never', () => {
  assert.equal(core.SETTINGS_KEY, 'qfc_v1_settings');
  assert.equal(core.DEFAULT_AUTO_TURN_OFF_MINUTES, 5);
  assert.equal(core.cleanAutoTurnOffMinutes(undefined), 5);
  assert.equal(core.cleanAutoTurnOffMinutes(0), 0);
  assert.equal(core.cleanAutoTurnOffMinutes(1), 1);
  assert.equal(core.cleanAutoTurnOffMinutes(60), 60);
  for (const invalid of [-1, 2, 61, '5', null, {}, 1.5]) {
    assert.equal(core.validAutoTurnOffMinutes(invalid), false);
    assert.equal(core.cleanAutoTurnOffMinutes(invalid), 5);
  }
});

test('v4 workflow backup settings validate strictly without losing notification opt-outs', () => {
  assert.equal(core.validateBackupSettings(undefined), null);
  const backup = {
    autoTurnOffMinutes: 0,
    notificationSettings: {
      enabled: false, onSuccess: false, onInterrupted: false,
      sound: 'alert', soundDuration: '20', soundVolume: 35,
      visibility: 'persistent'
    }
  };
  assert.deepEqual(core.validateBackupSettings(backup), backup);
  assert.deepEqual(core.validateBackupSettings({...backup, autoTurnOffMinutes: 15}),
    {...backup, autoTurnOffMinutes: 15});
  assert.throws(() => core.validateBackupSettings({...backup, autoTurnOffMinutes: '0'}), /Invalid settings/);
  assert.throws(() => core.validateBackupSettings({...backup, autoTurnOffMinutes: 120}), /Invalid settings/);
  assert.throws(() => core.validateBackupSettings({
    ...backup, notificationSettings: {...backup.notificationSettings, enabled: 'false'}
  }), /Invalid notification settings/);
  assert.throws(() => core.validateBackupSettings({
    ...backup, notificationSettings: { enabled: true }
  }), /Invalid notification settings/);
  assert.throws(() => core.validateBackupSettings(null), /Invalid settings/);
});
