import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGuide, serializeGuide, slugify, wordCount } from '../src/js/lib/guide-format.js';

test('guide front matter round-trips', () => {
  const meta = { title: 'How to: save "money"', description: 'Line one\nline two', date: '2026-10-23', tool: '/compress-pdf/', draft: false };
  const text = serializeGuide(meta, '## Hello\n\nWorld');
  const back = parseGuide(text);
  assert.equal(back.meta.title, 'How to: save "money"');
  assert.equal(back.meta.description, 'Line one line two'); // newlines can't break front matter
  assert.equal(back.meta.draft, undefined);
  assert.equal(back.body.trim(), '## Hello\n\nWorld');
  assert.equal(parseGuide(serializeGuide({ title: 'x', draft: true }, 'b')).meta.draft, 'true');
});
test('slugify + word count', () => {
  assert.equal(slugify('Is Refinancing Worth It in 2026?'), 'is-refinancing-worth-it-in-2026');
  assert.equal(slugify('../../etc/passwd'), 'etcpasswd');
  assert.equal(wordCount("It's a three-word test"), 4);
});

test('titleTag: short search title, brand only when it fits in 60 chars', async () => {
  const { titleTag } = await import('../src/js/lib/guide-format.js');
  assert.equal(titleTag({ title: 'A long human title', seoTitle: 'Short title' }), 'Short title | PrivyForge');
  const long = 'Private TinyPNG Alternative: No Upload, No Limits';
  assert.equal(titleTag({ seoTitle: long }), long);
  assert.equal(titleTag({ title: 'Only a title' }), 'Only a title | PrivyForge');
});
