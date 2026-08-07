#!/usr/bin/env node
'use strict';
/**
 * Cadangkan database ke folder lokal ./backups/ (JSON v2, sama format /api/backup).
 *
 * Cara A — lewat API (Render Live, tanpa DATABASE_URL):
 *   BACKUP_URL=https://sintesa-keuangan.onrender.com \
 *   ADMIN_USER=... ADMIN_PASSWORD=... \
 *   node scripts/backup-to-folder.js
 *
 * Cara B — langsung Postgres:
 *   DATABASE_URL='postgres://…' node scripts/backup-to-folder.js
 *
 * Env opsional:
 *   BACKUP_DIR   — folder tujuan (default: <repo>/backups)
 *   BACKUP_KEEP  — jumlah file yang dipertahankan (default: 30)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(ROOT, 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 30);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function rotate(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^backup-sintesa-keuangan-.*\.json$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of files.slice(KEEP)) {
    fs.unlinkSync(path.join(dir, old.f));
    console.log(`Hapus cadangan lama: ${old.f}`);
  }
}

function requestJson(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          const setCookie = res.headers['set-cookie'] || [];
          resolve({ status: res.statusCode, headers: res.headers, setCookie, text, json, buf });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(180000, () => {
      req.destroy(new Error('Timeout request'));
    });
    if (body) req.write(body);
    req.end();
  });
}

function cookieHeader(setCookie) {
  if (!setCookie || !setCookie.length) return '';
  return setCookie.map((c) => String(c).split(';')[0]).join('; ');
}

async function backupViaPg(url) {
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  // tanggal::text agar tidak digeser timezone oleh driver Date (UTC).
  const books = (
    await client.query(
      `SELECT id, name, saldo_awal, bank_info, ambang_saldo, created_at
         FROM books WHERE deleted_at IS NULL ORDER BY id`
    )
  ).rows.map((b) => ({
    ...b,
    saldo_awal: Number(b.saldo_awal),
    ambang_saldo: Number(b.ambang_saldo || 0),
  }));

  const txs = [];
  let lastId = 0;
  for (;;) {
    const { rows } = await client.query(
      `SELECT id, book_id, type, tanggal::text AS tanggal, jumlah, keterangan, kategori, bukti, created_at
         FROM transactions WHERE deleted_at IS NULL AND id > $1
         ORDER BY id LIMIT 200`,
      [lastId]
    );
    if (!rows.length) break;
    for (const t of rows) {
      const tanggal = String(t.tanggal || '').slice(0, 10);
      txs.push({ ...t, tanggal, jumlah: Number(t.jumlah) });
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < 200) break;
  }
  await client.end();
  return { app: 'sintesa-keuangan', version: 2, books, transactions: txs };
}

async function backupViaApi(baseUrl, user, pass) {
  const base = baseUrl.replace(/\/$/, '');
  const loginBody = JSON.stringify({ username: user, password: pass });
  const login = await requestJson(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) },
    body: loginBody,
  });
  if (login.status < 200 || login.status >= 300) {
    throw new Error(`Login gagal (${login.status}): ${(login.json && login.json.error) || login.text}`);
  }
  const cookie = cookieHeader(login.setCookie);
  if (!cookie) throw new Error('Login OK tapi cookie sesi tidak diterima.');

  const bak = await requestJson(`${base}/api/backup`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
  });
  if (bak.status < 200 || bak.status >= 300) {
    throw new Error(`Backup API gagal (${bak.status}): ${(bak.json && bak.json.error) || bak.text.slice(0, 200)}`);
  }
  if (!bak.json) throw new Error('Respons backup bukan JSON valid.');
  return bak.json;
}

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dbUrl = process.env.DATABASE_URL;
  const apiUrl = process.env.BACKUP_URL || process.env.APP_URL || '';
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;

  let data;
  if (dbUrl) {
    console.log('Mode: Postgres langsung');
    data = await backupViaPg(dbUrl);
  } else if (apiUrl && user && pass) {
    console.log(`Mode: API ${apiUrl}`);
    data = await backupViaApi(apiUrl, user, pass);
  } else {
    console.error(
      'Set DATABASE_URL, atau BACKUP_URL + ADMIN_USER + ADMIN_PASSWORD (bisa lewat .env).'
    );
    process.exit(1);
  }

  const nBooks = (data.books || []).length;
  const nTx = (data.transactions || []).length;
  const out = path.join(BACKUP_DIR, `backup-sintesa-keuangan-${stamp()}.json`);
  fs.writeFileSync(out, JSON.stringify(data));
  const mb = (fs.statSync(out).size / (1024 * 1024)).toFixed(2);
  rotate(BACKUP_DIR);

  const latest = path.join(BACKUP_DIR, 'latest.json');
  fs.copyFileSync(out, latest);

  console.log(`OK → ${out}`);
  console.log(`latest → ${latest}`);
  console.log(`${nBooks} rekening, ${nTx} transaksi, ${mb} MB`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
