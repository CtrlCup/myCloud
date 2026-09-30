// Wertet TRUST_PROXY aus und liefert den Wert für app.set('trust proxy', ...).
// Standard: nur Peers aus Loopback/privaten Netzen gelten als Proxy, damit ein direkt
// verbundener öffentlicher Client X-Forwarded-For nicht fälschen kann.
const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

function parseTrustProxy(raw) {
  const v = (raw === undefined || raw === null ? '' : String(raw)).trim();
  if (v === '') return DEFAULT_TRUST_PROXY;
  const lower = v.toLowerCase();
  if (lower === 'false' || v === '0') return false;
  if (lower === 'true') {
    console.warn('WARNUNG: TRUST_PROXY=true vertraut X-Forwarded-For von jedem Absender; Client-IPs (Rate-Limits) sind fälschbar.');
    return true;
  }
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

module.exports = { parseTrustProxy, DEFAULT_TRUST_PROXY };
