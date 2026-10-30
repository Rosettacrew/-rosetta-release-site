// Read-only regression tests for the draft DJ Loyalty singles storefront.
// Run: node --test tests/loyalty-singles.test.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../loyalty/loyalty.js'), 'utf8');
const ep = 'b05c0b7b-22af-441e-89b9-b722e93feceb';
const single = '23bdcdd9-cd64-4782-8699-cf4321a38df1';
const origin = 'https://sktgkrcahsxvidzjjxxt.supabase.co';
const context = {URL, SAMPLE_ORIGIN: origin,
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i};
vm.createContext(context);
const start = source.indexOf('function publicCoverUrl(');
const end = source.indexOf('\nfunction supportPresets', start);
assert.ok(start >= 0 && end > start, 'cover validator must exist');
vm.runInContext(source.slice(start, end) + '\nthis.cover = publicCoverUrl;', context);
const url = (id, name) => origin + '/storage/v1/object/public/release-public/' + id + '/cover/' + name;

test('all seven new singles and both live releases have pinned prices', () => {
  const slugs = [...source.matchAll(/"dj-loyalty-da-goat-[a-z-]+"/g)].map(m => m[0].slice(1,-1));
  const expected = ['loyal-to-a-fault','not-enough','i-m-him','you-broke-me','bad-for-you','nasty-remix','slow'];
  for (const suffix of expected) assert.ok(slugs.includes('dj-loyalty-da-goat-'+suffix), suffix);
  assert.match(source, /"dj-loyalty-da-goat-love-pain-loyalty-ep": 799/);
  assert.match(source, /"dj-loyalty-da-goat-even-though": 199/);
});
test('shared EP cover and own cover are allowed', () => {
  assert.ok(context.cover(url(ep, 'cover.jpeg'), single));
  assert.ok(context.cover(url(single, 'cover.png'), single));
});
test('unrelated cover is blocked', () => {
  assert.equal(context.cover(url('11111111-1111-4111-8111-111111111111','cover.png'), single), '');
});
test('query strings, path traversal, and non-image extensions are blocked', () => {
  assert.equal(context.cover(url(ep, 'cover.jpeg')+'?x=1', single), '');
  assert.equal(context.cover(url(ep, '../cover.png'), single), '');
  assert.equal(context.cover(url(ep, 'cover.svg'), single), '');
});
