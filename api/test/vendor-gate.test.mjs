// Strict vendor-list gate (default ON): an unlisted seller is refused on the CCD rail before signing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { strictVendorListEnabled, vendorGateDecision } from '../src/vendor-gate.mjs';

test('strict mode is on by default and only an explicit 0 turns it off', () => {
  assert.equal(strictVendorListEnabled({}), true);
  assert.equal(strictVendorListEnabled({ PAYONCE_STRICT_VENDOR_LIST: '1' }), true);
  assert.equal(strictVendorListEnabled({ PAYONCE_STRICT_VENDOR_LIST: '0' }), false);
});

test('an unlisted seller is refused, a listed one is allowed', () => {
  const unlisted = vendorGateDecision({ strict: true, approval: null, seller: 'SELLER_X' });
  assert.equal(unlisted.allow, false);
  assert.equal(unlisted.code, 'seller-not-on-vendor-list');
  assert.match(unlisted.reason, /SELLER_X/);
  assert.equal(vendorGateDecision({ strict: true, approval: { tier: 2 }, seller: 'S' }).allow, true);
});

test('with the gate off nothing is refused here (the old behaviour)', () => {
  assert.equal(vendorGateDecision({ strict: false, approval: null, seller: 'S' }).allow, true);
});
