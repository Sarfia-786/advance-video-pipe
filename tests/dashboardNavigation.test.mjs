import test from 'node:test';
import assert from 'node:assert/strict';
import { getDashboardNavigation } from '../lib/platform/dashboard/navigation.mjs';

test('dashboard quick actions keep seven stable IDs and no fake Shorts destination', () => {
  const { actions } = getDashboardNavigation();
  assert.deepEqual(actions.map(action => action.id), [
    'short', 'image', 'video', 'script', 'workflow', 'voice', 'thumbnail',
  ]);
  assert.equal(new Set(actions.map(action => action.id)).size, 7);
  assert.deepEqual(actions[0], { id: 'short', path: null, dependsOn: 18, href: null });
  for (const action of actions.slice(1)) {
    assert.match(action.href, /^\/studio\/[a-z-]+$/);
  }
});

test('English and Chinese navigation only use existing localized routes', () => {
  const en = getDashboardNavigation('en');
  const zh = getDashboardNavigation('zh');
  assert.deepEqual(en.primary.map(link => link.href), [
    '/dashboard', '/studio', '/captions', '/account',
  ]);
  assert.deepEqual(zh.primary.map(link => link.href), [
    '/zh/dashboard', '/zh/studio', '/zh/captions', '/zh/account',
  ]);
  assert.equal(en.actions[4].href, '/studio/workflows');
  assert.equal(zh.actions[4].href, '/zh/studio/workflows');
  assert.equal(zh.actions[6].href, '/zh/studio/design-agent');
  assert.equal(zh.actions[0].href, null);
  assert.deepEqual(getDashboardNavigation('unsupported'), en);
});
