'use strict';
/*
 * Auslieferung und Lesezugriff auf Datei-Blobs (Phase P2a, docs/Verschluesselung-und-Backup.md 3.3/3.4).
 * Die Entscheidung "verschlüsselt ja/nein" kommt immer aus files.enc_version (Zeile), nie aus einer
 * Magic-Heuristik. Unverschlüsselte Blobs laufen unverändert über res.sendFile/res.download.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const cryptoStore = require('./crypto-store');

/** true, wenn die Datei-Zeile einen verschlüsselten Blob beschreibt. */
const isEncRow = (row) => !!row && Number(row.enc_version) > 0;

/** Thumbnail-Dateien: verschlüsselt genau dann, wenn der Dateiname auf ".enc" endet (nie per Heuristik). */
const isEncThumbnail = (thumbPath) => String(thumbPath).endsWith('.enc');

/* ---------- Semaphor für paralleles Entschlüsseln in Temp-Dateien ---------- */

function makeSemaphore(max) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) { active++; next(); }
  };
  return {
    async run(fn) {
      if (active >= max) await new Promise((resolve) => waiting.push(resolve));
      else active++;
      try { return await fn(); } finally { release(); }
    },
  };
}

const decryptConcurrency = Math.max(1, parseInt(process.env.MYCLOUD_DECRYPT_CONCURRENCY, 10) || 4);
const decryptSemaphore = makeSemaphore(decryptConcurrency);

/**
 * cryptoStore.withPlaintextTempFile mit Semaphor (max. MYCLOUD_DECRYPT_CONCURRENCY parallele
 * Entschlüsselungen). Klartext-Blobs brauchen keine Kopie und belegen keinen Slot.
 * `encrypted` muss ein Boolean aus der DB-Zeile sein.
 */
function withPlaintextTempFile(filePath, fn, { encrypted, ext } = {}) {
  if (typeof encrypted !== 'boolean') throw new TypeError('withPlaintextTempFile: `encrypted` muss aus files.enc_version abgeleitet werden.');
  if (!encrypted) return cryptoStore.withPlaintextTempFile(filePath, fn, { encrypted: false, ext });
  return decryptSemaphore.run(() => cryptoStore.withPlaintextTempFile(filePath, fn, { encrypted: true, ext }));
}

/** Kleine, sichere Endung für Temp-Dateien ([a-z0-9]{1,5}) aus einem Dateinamen, sonst undefined. */
function tempExtFor(name) {
  const e = path.extname(String(name || '')).slice(1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(e) ? e : undefined;
}

/**
 * Lazy Klartext-Stream (für archiver.append): der Blob wird erst geöffnet, wenn der Stream gelesen wird,
 * damit bei großen ZIPs nicht alle Dateien gleichzeitig offen sind.
 */
function lazyPlainStream(filePath, { encrypted }) {
  return Readable.from((async function* () {
    yield* cryptoStore.createDecryptStream(filePath, { encrypted });
  })(), { objectMode: false });
}

/**
 * archiver meldet Fehler (Client-Abbruch, fehlende/defekte/nicht entschlüsselbare Datei) asynchron: ein `throw`
 * im Handler würde den Prozess beenden. Vor dem ersten Byte: 500; danach Verbindung abbrechen statt ein
 * unvollständiges ZIP als erfolgreich zu beenden.
 */
function zipErrorHandler(res, logLabel, message) {
  return (err) => {
    console.error(logLabel, err);
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      res.status(500).type('application/json').send(JSON.stringify({ error: message }));
    } else {
      res.destroy(err);
    }
  };
}

/** Datei ins ZIP: Klartext per Pfad (archiver liest lazy), verschlüsselt als lazy Klartext-Stream. */
function addToZip(zip, physicalPath, archivePath, encrypted) {
  if (!encrypted) return zip.file(physicalPath, { name: archivePath });
  const src = lazyPlainStream(physicalPath, { encrypted: true });
  // archiver pipt die Quelle in einen PassThrough: deren 'error' erreicht archive.on('error') nicht von selbst
  // (sonst uncaughtException). Hier weiterreichen, damit zipErrorHandler die Antwort abbricht.
  src.on('error', (e) => zip.emit('error', e));
  zip.append(src, { name: archivePath });
}

/* ---------- sendFileDecrypted ---------- */

function sendJsonError(res, status, message, headers = {}) {
  res.statusCode = status;
  for (const h of ['Content-Range', 'Content-Length', 'ETag', 'Content-Disposition', 'Accept-Ranges']) res.removeHeader(h);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: message }));
}

function contentDispositionAttachment(name) {
  const fallback = String(name).replace(/[^\x20-\x7e]/g, '?').replace(/[\\"]/g, '\\$&');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"` + (fallback === name ? '' : `; filename*=UTF-8''${encoded}`);
}

/**
 * Range-Header (nur "bytes=") gegen die Klartextgröße. Rückgabe: null (ignorieren, volle Antwort 200),
 * 'unsatisfiable' (416) oder { start, end } (inklusive). Mehrere Bereiche und ungültige Syntax werden wie bei
 * res.sendFile ignoriert.
 */
function parseRange(header, size) {
  const m = /^bytes=(.+)$/i.exec(String(header || '').trim());
  if (!m || m[1].includes(',')) return null;
  const spec = /^(\d*)-(\d*)$/.exec(m[1].trim());
  if (!spec || (spec[1] === '' && spec[2] === '')) return null;
  let start, end;
  if (spec[1] === '') {
    const n = Number(spec[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(spec[1]);
    end = spec[2] === '' ? size - 1 : Number(spec[2]);
    if (spec[2] !== '' && end < start) return null;
    end = Math.min(end, size - 1);
  }
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

const etagMatches = (header, etag) => String(header).split(',').some((t) => { const v = t.trim(); return v === '*' || v.replace(/^W\//, '') === etag; });

// Callback für res.sendFile/res.download: ein nicht erfüllbarer Range wird als 416 beantwortet (ohne Callback
// landete er im globalen Fehler-Handler als 500); alle anderen Fehler bleiben wie bisher ein 500.
function plainDone(res) {
  return (err) => {
    if (!err || err.code === 'ECONNABORTED' || err.syscall === 'write') return;
    // Fehler nach gesendeten Headern: Antwort abbrechen, sonst hängt der Client
    if (res.headersSent) return res.destroy(err);
    if (err.status === 416) {
      for (const [k, v] of Object.entries(err.headers || {})) res.setHeader(k, v);
      return sendJsonError(res, 416, 'Angeforderter Bereich nicht erfüllbar.', err.headers || {});
    }
    console.error('Auslieferung (Klartext) fehlgeschlagen:', err.message);
    sendJsonError(res, 500, 'Internal server error');
  };
}

/**
 * Ersatz für res.sendFile/res.download bei Datei-Blobs.
 *   fileRow: { enc_version, size? } (Zeile aus `files`; bei Thumbnails ein synthetisches Objekt)
 *   opts.filePath   absoluter Pfad des Blobs (Pflicht)
 *   opts.filename   Name für Content-Disposition (optional)
 *   opts.inline     true -> inline, sonst attachment (nur mit filename)
 *   opts.mimeType   Content-Type (Standard bei verschlüsselten Blobs octet-stream; bei Klartext wie bisher
 *                   durch res.sendFile bestimmt)
 *   opts.headersFn  (res) => void, setzt zusätzliche Header (z. B. Cache-Control)
 * Setzt keine Schutz-Header selbst: setFileServeHeaders(res, name) ruft der Aufrufer wie bisher vorher auf.
 */
function sendFileDecrypted(req, res, fileRow, { filePath, filename, inline, mimeType, headersFn } = {}) {
  if (!filePath) throw new TypeError('sendFileDecrypted: filePath fehlt.');
  const encrypted = isEncRow(fileRow);
  const disposition = filename ? (inline ? 'inline; filename="' + encodeURIComponent(filename) + '"' : contentDispositionAttachment(filename)) : null;

  if (!encrypted) {
    if (headersFn) headersFn(res);
    if (filename && !inline) return res.download(filePath, filename, plainDone(res));
    const headers = {};
    if (mimeType) headers['Content-Type'] = mimeType;
    if (disposition) headers['Content-Disposition'] = disposition;
    return res.sendFile(filePath, { headers }, plainDone(res));
  }

  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  let st, plainSize;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    if (e.code === 'ENOENT') return sendJsonError(res, 404, 'Physical file not found');
    console.error('Auslieferung: Blob nicht lesbar:', e.message);
    return sendJsonError(res, 500, 'Die Datei konnte nicht gelesen werden.');
  }
  try {
    plainSize = cryptoStore.plainSizeOf(filePath, { encrypted: true });
  } catch (e) {
    console.error(`Auslieferung: verschlüsselte Datei unlesbar (${e.code || 'Fehler'}): ${e.message}`);
    return sendJsonError(res, 500, 'Die verschlüsselte Datei konnte nicht gelesen werden (beschädigt oder Schlüssel fehlt).');
  }
  if (fileRow.size !== undefined && fileRow.size !== null && Number(fileRow.size) !== plainSize) {
    console.error(`Auslieferung abgebrochen: files.size (${fileRow.size}) weicht von der Klartextgröße im Header (${plainSize}) ab: ${path.basename(filePath)}`);
    return sendJsonError(res, 500, 'Die gespeicherte Dateigröße passt nicht zur verschlüsselten Datei. Auslieferung abgebrochen.');
  }

  const etag = `"${plainSize.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=0');
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  if (disposition) res.setHeader('Content-Disposition', disposition);
  if (headersFn) headersFn(res);

  const inm = req.headers && req.headers['if-none-match'];
  if (inm && etagMatches(inm, etag)) { res.statusCode = 304; return res.end(); }

  let range = null;
  const rangeHeader = req.headers && req.headers.range;
  if (rangeHeader) {
    const ifRange = req.headers['if-range'];
    if (!ifRange || ifRange === etag) range = parseRange(rangeHeader, plainSize);
  }
  if (range === 'unsatisfiable') {
    return sendJsonError(res, 416, 'Angeforderter Bereich nicht erfüllbar.', { 'Content-Range': `bytes */${plainSize}` });
  }
  let start = 0, end = plainSize - 1;
  if (range) {
    ({ start, end } = range);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${plainSize}`);
  } else {
    res.statusCode = 200;
  }
  const length = plainSize === 0 ? 0 : end - start + 1;
  res.setHeader('Content-Length', String(length));
  if (method === 'HEAD' || length === 0) {
    if (length === 0 && method !== 'HEAD') {
      // leere Datei: Segment trotzdem verifizieren (Abschneiden/Manipulation erkennen)
      try { cryptoStore.createDecryptStream(filePath, { encrypted: true }).destroy(); }
      catch (e) { console.error('Auslieferung: leere verschlüsselte Datei ungültig:', e.message); return sendJsonError(res, 500, 'Die verschlüsselte Datei konnte nicht gelesen werden (beschädigt oder Schlüssel fehlt).'); }
    }
    return res.end();
  }

  let stream;
  try {
    stream = cryptoStore.createDecryptStream(filePath, { start, end, encrypted: true });
  } catch (e) {
    console.error(`Auslieferung: Entschlüsselung nicht möglich (${e.code || 'Fehler'}): ${e.message}`);
    return sendJsonError(res, 500, 'Die verschlüsselte Datei konnte nicht gelesen werden (beschädigt oder Schlüssel fehlt).');
  }
  stream.on('error', (err) => {
    console.error(`Auslieferung: Stream-Fehler (${err.code || 'Fehler'}): ${err.message}`);
    // Nach bereits gesendeten Headern nie sauber beenden: Verbindung abbrechen, damit der Client einen Fehler sieht.
    if (res.headersSent) res.destroy(err);
    else sendJsonError(res, 500, 'Die verschlüsselte Datei konnte nicht gelesen werden (beschädigt oder Schlüssel fehlt).');
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

module.exports = {
  isEncRow, isEncThumbnail, withPlaintextTempFile, tempExtFor, lazyPlainStream,
  sendFileDecrypted, parseRange, makeSemaphore, addToZip, zipErrorHandler,
};
