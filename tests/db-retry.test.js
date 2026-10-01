// node --test tests/db-retry.test.js  (reiner Unit-Test, kein Stack nötig)
const test = require('node:test');
const assert = require('node:assert');
const { withDbRetry, isConnectionError } = require('../app/db-retry');

const err = code => Object.assign(new Error(code), { code });
const opts = () => ({ sleep: async () => {}, log: () => {} });

test('3x ECONNREFUSED, dann Erfolg', async () => {
  let n = 0;
  const r = await withDbRetry(async () => { if (++n <= 3) throw err('ECONNREFUSED'); return 'ok'; }, opts());
  assert.strictEqual(r, 'ok');
  assert.strictEqual(n, 4);
});

test('dauerhafter Fehler: reject nach N Versuchen', async () => {
  let n = 0;
  await assert.rejects(withDbRetry(async () => { n++; throw err('57P03'); }, { ...opts(), attempts: 5 }), { code: '57P03' });
  assert.strictEqual(n, 5);
});

test('Nicht-Verbindungsfehler: sofort reject', async () => {
  let n = 0;
  await assert.rejects(withDbRetry(async () => { n++; throw err('42601'); }, opts()), { code: '42601' });
  assert.strictEqual(n, 1);
});

test('Backoff verdoppelt sich bis zum Maximum', async () => {
  const delays = [];
  await assert.rejects(withDbRetry(async () => { throw err('ENOTFOUND'); },
    { attempts: 6, baseDelayMs: 1, maxDelayMs: 5, sleep: async ms => { delays.push(ms); }, log: () => {} }));
  assert.deepStrictEqual(delays, [1, 2, 4, 5, 5]);
});

test('isConnectionError erkennt 08xxx und AggregateError', () => {
  assert.ok(isConnectionError(err('08006')));
  assert.ok(isConnectionError({ errors: [err('ECONNREFUSED'), err('ECONNREFUSED')] }));
  assert.ok(!isConnectionError(err('23505')));
});
