// Helpers for the EuroOffice/OnlyOffice save path, kept free of Express/DB so they can be tested
// with plain node:test (see tests/office-save.test.js).
const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

// Document-server cache key: must change after every save (otherwise the document server keeps
// serving its cached old version) but be identical for everyone editing the same version.
// Derived from the stored content_hash, which the callback rewrites on every successful save.
// Allowed chars: a-zA-Z0-9_-=. and max 128 length.
function buildDocumentKey(fileId, contentHash) {
  const short = String(contentHash || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) || 'v0';
  return `file_${parseInt(fileId, 10)}_${short}`;
}

function defaultGet(url) {
  const client = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    client.get(url, (res) => resolve({ statusCode: res.statusCode, stream: res })).on('error', reject);
  });
}

// Downloads `url` into a temp file next to targetPath and renames it over targetPath only after
// the download completed fully. On any failure the temp file is removed and targetPath is left
// untouched. Resolves { size, hash } of the new file; rejects otherwise.
async function saveDownloadedFile(url, targetPath, get = defaultGet) {
  const tmpPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  try {
    const { statusCode, stream } = await get(url);
    if (statusCode !== 200) {
      stream.resume?.();
      throw new Error(`Download failed with status ${statusCode}`);
    }
    const hash = crypto.createHash('sha256');
    stream.on('data', (chunk) => hash.update(chunk));
    await pipeline(stream, fs.createWriteStream(tmpPath));
    if (stream.aborted || stream.complete === false) throw new Error('Download aborted');
    const size = fs.statSync(tmpPath).size;
    fs.renameSync(tmpPath, targetPath);
    return { size, hash: hash.digest('hex') };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
    throw err;
  }
}

// Copy-on-Write-Variante für aktive Verschlüsselung: streamt den Download direkt in einen NEUEN Blob
// (`write(newPath, stream)` -> { plainSize, sha256 }, z. B. cryptoStore.writeEncrypted), ruft danach
// `commit({ size, hash })` auf (DB-Transaktion, die files.path auf den neuen Blob umhängt und { oldPath }
// liefert) und löscht erst NACH erfolgreichem Commit den alten Blob (`discard(oldPath)`). Bei jedem Fehler
// (Download-Abbruch, Status != 200, Commit-Fehler) wird der neue Blob verworfen; alter Blob und Zeile bleiben
// unverändert. Resolves { size, hash } des neuen Blobs.
async function saveDownloadedFileCow(url, newPath, { write, commit, discard, get = defaultGet }) {
  let written = false;
  try {
    const { statusCode, stream } = await get(url);
    if (statusCode !== 200) {
      stream.resume?.();
      throw new Error(`Download failed with status ${statusCode}`);
    }
    const r = await write(newPath, stream);
    written = true;
    if (stream.aborted || stream.complete === false) throw new Error('Download aborted');
    const saved = { size: r.plainSize, hash: r.sha256 };
    const { oldPath } = await commit(saved);
    try { discard(oldPath); } catch (e) { console.error('Alter Blob konnte nicht gelöscht werden:', e.message); }
    return saved;
  } catch (err) {
    if (written) { try { discard(newPath); } catch { /* best-effort */ } }
    throw err;
  }
}

module.exports = { buildDocumentKey, saveDownloadedFile, saveDownloadedFileCow };
