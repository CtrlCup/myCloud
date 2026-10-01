// Wiederholt eine DB-Operation (z. B. initDb) nur bei Verbindungsfehlern, mit exponentiellem Backoff.
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', '57P03']);

function isConnectionError(err) {
  const code = err && err.code ? String(err.code) : '';
  if (CONNECTION_CODES.has(code) || code.startsWith('08')) return true;
  // pg liefert bei mehreren Adressen ggf. einen AggregateError ohne eigenen code
  return Array.isArray(err && err.errors) && err.errors.length > 0 && err.errors.every(isConnectionError);
}

async function withDbRetry(fn, {
  attempts = 10,
  baseDelayMs = 500,
  maxDelayMs = 5000,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  log = console.warn,
} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isConnectionError(err) || attempt >= attempts) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      log(`Database not ready (${err.code || err.message}), attempt ${attempt}/${attempts}, retrying in ${delay} ms...`);
      await sleep(delay);
    }
  }
}

module.exports = { withDbRetry, isConnectionError };
