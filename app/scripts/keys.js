#!/usr/bin/env node
'use strict';
// Master-Key-Verwaltung (siehe docs/Verschluesselung-und-Backup.md, Abschnitt 5).
//   node scripts/keys.js init --out <pfad>     neuen Key erzeugen (Datei 0400) + Recovery-Code ausgeben
//   node scripts/keys.js show-recovery <datei> Recovery-Code einer vorhandenen Key-Datei erneut ausgeben
//   node scripts/keys.js check <datei>         Format und Länge prüfen
const crypto = require('crypto');
const fs = require('fs');
const { parseKeyFile, formatRecoveryCode } = require('../crypto-store');

function die(msg) { console.error(`Fehler: ${msg}`); process.exit(1); }

const [cmd, ...args] = process.argv.slice(2);

function readKeys(file) {
  if (!file) die('Pfad zur Key-Datei fehlt.');
  try { return parseKeyFile(fs.readFileSync(file, 'utf8')); }
  catch (e) { die(e.code === 'ENOENT' ? `Datei "${file}" nicht gefunden.` : e.message); }
}

function printRecovery(cfg) {
  for (const [id, key] of cfg.keys) console.log(`Recovery-Code (Key ${id}${id === cfg.current ? ', aktuell' : ''}): ${formatRecoveryCode(key)}`);
}

if (cmd === 'init') {
  const i = args.indexOf('--out');
  const out = i === -1 ? null : args[i + 1];
  if (!out) die('--out <pfad> ist verpflichtend (z. B. im Container: --out /out/master_key mit gemountetem Volume).');
  const key = crypto.randomBytes(32);
  try { fs.writeFileSync(out, key.toString('hex') + '\n', { flag: 'wx', mode: 0o400 }); }
  catch (e) { die(e.code === 'EEXIST' ? `"${out}" existiert bereits, wird nicht überschrieben.` : `Schreiben von "${out}" fehlgeschlagen: ${e.message}`); }
  console.log(`Key-Datei geschrieben: ${out} (Modus 0400)`);
  console.log('');
  printRecovery({ current: 1, keys: new Map([[1, key]]) });
  console.log('');
  console.log('WICHTIG: Recovery-Code jetzt offline sichern (z. B. Passwortmanager). Ohne Master-Key');
  console.log('sind verschlüsselte Daten unwiederbringlich verloren. Er wird nicht gespeichert.');
  console.log('Diese Ausgabe nicht in CI-Logs, Terminal-Mitschnitten oder Tickets ablegen.');
} else if (cmd === 'show-recovery') {
  printRecovery(readKeys(args[0]));
} else if (cmd === 'check') {
  const cfg = readKeys(args[0]);
  console.log(`OK: ${cfg.keys.size} Key(s), aktuell keyId ${cfg.current}.`);
} else {
  console.error('Aufruf: node scripts/keys.js init --out <pfad> | show-recovery <datei> | check <datei>');
  process.exit(cmd ? 1 : 0);
}
