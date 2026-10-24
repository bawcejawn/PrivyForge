import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashBuffer, cleanHash, algoForLength, sameHash } from '../src/js/lib/hash.js';

test('SHA-256 / SHA-1 of "test" match known digests', async () => {
  const buf = new TextEncoder().encode('test');
  assert.equal(await hashBuffer(buf, 'SHA-256'), '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  assert.equal(await hashBuffer(buf, 'SHA-1'), 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3');
});
test('cleanHash handles sha256sum output and prefixes', () => {
  assert.equal(cleanHash('9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08  ubuntu.iso'), '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  assert.equal(cleanHash('sha256:a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'), 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3');
  assert.equal(cleanHash('nope'), '');
});
test('algorithm detection and comparison', () => {
  assert.equal(algoForLength('a'.repeat(64)), 'SHA-256');
  assert.equal(algoForLength('a'.repeat(40)), 'SHA-1');
  assert.ok(sameHash('ABC'.padEnd(64, '0'), 'abc'.padEnd(64, '0')));
  assert.ok(!sameHash('a'.repeat(64), 'b'.repeat(64)));
});
