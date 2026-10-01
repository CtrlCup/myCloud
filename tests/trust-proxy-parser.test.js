// node --test tests/trust-proxy-parser.test.js  (ohne Stack)
const test = require('node:test');
const assert = require('node:assert');
const { parseTrustProxy, DEFAULT_TRUST_PROXY } = require('../app/trust-proxy');

test('parseTrustProxy', () => {
  assert.strictEqual(parseTrustProxy(undefined), 'loopback, linklocal, uniquelocal');
  assert.strictEqual(parseTrustProxy('  '), DEFAULT_TRUST_PROXY);
  assert.strictEqual(parseTrustProxy('false'), false);
  assert.strictEqual(parseTrustProxy('0'), false);
  assert.strictEqual(parseTrustProxy('1'), 1);
  assert.strictEqual(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
  const warn = console.warn; let warned = false; console.warn = () => { warned = true; };
  try { assert.strictEqual(parseTrustProxy('true'), true); } finally { console.warn = warn; }
  assert.ok(warned);
});
