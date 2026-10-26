import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAds } from '../src/js/lib/ads.js';

const ID = 'ca-pub-1234567890123456';
test('ads stay off with no (or a malformed) publisher ID, whatever the consent', () => {
  for (const consent of [null, 'granted', 'denied']) {
    assert.equal(decideAds({ client: '', consent }), 'off');
    assert.equal(decideAds({ client: 'pub-123', consent }), 'off');
  }
});
test('banner mode: nothing loads until the visitor accepts', () => {
  assert.equal(decideAds({ client: ID, mode: 'banner', consent: null }), 'ask');
  assert.equal(decideAds({ client: ID, mode: 'banner', consent: 'denied' }), 'declined');
  assert.equal(decideAds({ client: ID, mode: 'banner', consent: 'granted' }), 'load');
});
test('google-cmp mode defers to Google\'s certified CMP', () => {
  assert.equal(decideAds({ client: ID, mode: 'google-cmp', consent: null }), 'load-await-cmp');
});
