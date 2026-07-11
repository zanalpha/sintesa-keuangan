'use strict';

// Integration test atas seluruh permukaan HTTP, memakai database in-memory (pg-mem) —
// tanpa perlu memasang Postgres. Jalankan: npm test (butuh Node >= 18 untuk node:test).

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-yang-cukup-panjang-1234';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'rahasiakuat123';
delete process.env.DATABASE_URL; // paksa mode pg-mem

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { app } = require('../src/server');
const db = require('../src/db');

let base;
let server;
let adminCookie = '';
let viewerCookie = '';

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.Cookie = cookie;
    const r = http.request(base + path, { method, headers }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* non-JSON */ }
        const sc = res.headers['set-cookie'] || [];
        resolve({ status: res.statusCode, json, cookie: sc.map((c) => c.split(';')[0]).join('; ') });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  await db.migrate();
  await db.seedAdmin();
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((res) => server.close(res));
  await db.end();
});

test('healthz melaporkan DB up', async () => {
  const r = await req('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.json.db, 'up');
});

test('registrasi publik ditolak (tanpa login)', async () => {
  const r = await req('POST', '/api/auth/register', { body: { username: 'x', name: 'X', password: 'passwordkuat10' } });
  assert.equal(r.status, 401);
});

test('login admin berhasil dan berperan admin', async () => {
  const r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'rahasiakuat123' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'admin');
  adminCookie = r.cookie;
  assert.ok(adminCookie.length > 0);
});

test('lockout per-akun setelah percobaan gagal beruntun', async () => {
  let last = 0;
  for (let i = 0; i < 9; i++) {
    const r = await req('POST', '/api/auth/login', { body: { username: 'ghost', password: 'salahsalah' } });
    last = r.status;
  }
  assert.equal(last, 429); // sudah terkunci
});

test('buat rekening & transaksi, saldo terhitung', async () => {
  let r = await req('POST', '/api/books', { cookie: adminCookie, body: { name: 'BCA', saldo_awal: 1000000 } });
  assert.equal(r.status, 201);
  r = await req('POST', '/api/books/1/transactions', { cookie: adminCookie, body: { type: 'masuk', tanggal: '2026-07-01', jumlah: 5000000 } });
  assert.equal(r.status, 201);
  r = await req('GET', '/api/books', { cookie: adminCookie });
  assert.equal(r.json.books[0].sisa, 6000000);
});

test('tanggal kalender mustahil ditolak', async () => {
  const r = await req('POST', '/api/books/1/transactions', { cookie: adminCookie, body: { type: 'keluar', tanggal: '2026-02-30', jumlah: 1000 } });
  assert.equal(r.status, 400);
});

test('bukti format salah ditolak', async () => {
  const r = await req('POST', '/api/books/1/transactions', { cookie: adminCookie, body: { type: 'keluar', tanggal: '2026-07-02', jumlah: 1000, bukti: 'data:image/png;base64,not*valid' } });
  assert.equal(r.status, 400);
});

test('soft-delete menyembunyikan transaksi dari daftar', async () => {
  let r = await req('POST', '/api/books/1/transactions', { cookie: adminCookie, body: { type: 'keluar', tanggal: '2026-07-03', jumlah: 200000 } });
  const id = r.json.transaction.id;
  r = await req('DELETE', `/api/transactions/${id}`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  r = await req('GET', '/api/books/1/transactions', { cookie: adminCookie });
  assert.ok(!r.json.transactions.some((t) => t.id === id));
});

test('impor massal: valid masuk, tanggal invalid dilewati', async () => {
  const r = await req('POST', '/api/books/1/transactions/bulk', {
    cookie: adminCookie,
    body: { transactions: [
      { type: 'masuk', tanggal: '2026-07-05', jumlah: '1500000' },
      { type: 'keluar', tanggal: '2026-04-31', jumlah: '999' },
    ] },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.inserted, 1);
  assert.equal(r.json.gagal, 1);
});

test('transfer antar rekening membuat pasangan transaksi', async () => {
  await req('POST', '/api/books', { cookie: adminCookie, body: { name: 'Kas Kecil' } });
  const before = (await req('GET', '/api/books', { cookie: adminCookie })).json.books;
  const bca = before.find((b) => b.name === 'BCA');
  const kas = before.find((b) => b.name === 'Kas Kecil');
  const r = await req('POST', '/api/transfer', { cookie: adminCookie, body: { from_book: bca.id, to_book: kas.id, tanggal: '2026-07-06', jumlah: 300000 } });
  assert.equal(r.status, 201);
  const after = (await req('GET', '/api/books', { cookie: adminCookie })).json.books;
  assert.equal(after.find((b) => b.name === 'Kas Kecil').sisa, 300000);
});

test('backup adalah JSON v2 dan memuat kolom bukti', async () => {
  const r = await req('GET', '/api/backup', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 2);
  assert.ok(Array.isArray(r.json.transactions));
  assert.ok('bukti' in r.json.transactions[0]);
});

test(':id non-angka menghasilkan 400, bukan 500', async () => {
  const r = await req('GET', '/api/books/abc/transactions', { cookie: adminCookie });
  assert.equal(r.status, 400);
});

test('viewer bisa membaca tapi tak bisa mengubah', async () => {
  let r = await req('POST', '/api/auth/register', { cookie: adminCookie, body: { username: 'viewer1', name: 'Viewer', password: 'lihatsaja123', role: 'viewer' } });
  assert.equal(r.status, 201);
  r = await req('POST', '/api/auth/login', { body: { username: 'viewer1', password: 'lihatsaja123' } });
  viewerCookie = r.cookie;
  assert.equal((await req('GET', '/api/books', { cookie: viewerCookie })).status, 200);
  r = await req('POST', '/api/books/1/transactions', { cookie: viewerCookie, body: { type: 'masuk', tanggal: '2026-07-07', jumlah: 1000 } });
  assert.equal(r.status, 403);
});

test('audit log mencatat aktivitas', async () => {
  const r = await req('GET', '/api/auth/audit', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.events.length > 0);
});
