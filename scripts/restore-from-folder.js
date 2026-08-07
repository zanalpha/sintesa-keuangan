#!/usr/bin/env node
'use strict';
/**
 * Pulihkan dari file JSON di folder backups/ ke instance Live (API).
 *
 *   BACKUP_URL=https://sintesa-keuangan.onrender.com \
 *   ADMIN_USER=... ADMIN_PASSWORD=... \
 *   node scripts/restore-from-folder.js
 *   node scripts/restore-from-folder.js backups/latest.json --replace
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const replace = args.includes('--replace');
const fileArg = args.find((a) => !a.startsWith('--'));
const file = path.resolve(fileArg || path.join(ROOT, 'backups', 'latest.json'));

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
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] || [], text, json });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('Timeout request')));
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const base = (process.env.BACKUP_URL || process.env.APP_URL || '').replace(/\/$/, '');
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;
  if (!base || !user || !pass) {
    console.error('Butuh BACKUP_URL + ADMIN_USER + ADMIN_PASSWORD.');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error('File tidak ada:', file);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.books) || !Array.isArray(data.transactions)) {
    console.error('File bukan cadangan sintesa-keuangan yang valid.');
    process.exit(1);
  }

  const loginBody = JSON.stringify({ username: user, password: pass });
  const login = await requestJson(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) },
    body: loginBody,
  });
  if (login.status < 200 || login.status >= 300) {
    throw new Error(`Login gagal: ${(login.json && login.json.error) || login.status}`);
  }
  const cookie = (login.setCookie || []).map((c) => String(c).split(';')[0]).join('; ');
  if (!cookie) throw new Error('Cookie sesi tidak diterima.');

  const payload = JSON.stringify(replace ? { ...data, mode: 'replace' } : data);
  const url = `${base}/api/restore${replace ? '?mode=replace' : ''}`;
  const res = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Cookie: cookie,
    },
    body: payload,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error((res.json && res.json.error) || `HTTP ${res.status}`);
  }
  console.log('Restore OK:', res.json);
  console.log('Sumber:', file);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
