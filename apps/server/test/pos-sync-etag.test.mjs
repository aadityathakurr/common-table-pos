import test from 'node:test';
import assert from 'node:assert/strict';
import { ifNoneMatchMatches } from '../../../supabase/functions/pos-sync/etag.mjs';

test('POS menu conditional requests compare weak and strong ETags correctly', () => {
  const expected = '"menu-version"';
  assert.equal(ifNoneMatchMatches(expected, expected), true);
  assert.equal(ifNoneMatchMatches(`W/${expected}`, expected), true);
  assert.equal(ifNoneMatchMatches(`"other", W/${expected}`, expected), true);
  assert.equal(ifNoneMatchMatches('*', expected), true);
  assert.equal(ifNoneMatchMatches('W/"other"', expected), false);
  assert.equal(ifNoneMatchMatches(null, expected), false);
});
