// node --test tests/zz-trust-proxy.test.js
// Test-Stack mit TRUST_PROXY=false. Verbraucht das Registrierungs-Limit (5/h pro IP) und muss
// daher als LETZTE Suite laufen; danach stoppt Registrierung im Stack bis zum App-Neustart.
const test = require('node:test');
const assert = require('node:assert');
const { BASE } = require('./_env');

test('rotierendes X-Forwarded-For umgeht das Registrierungs-Limit nicht', async () => {
  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const res = await fetch(BASE + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i + 1}` },
      body: JSON.stringify({ username: 'tp' + Date.now() + i, password: 'x' }), // ungültig, zählt trotzdem
    });
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), 'erwartet 429, erhalten: ' + statuses.join(','));
});
