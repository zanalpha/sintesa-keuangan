'use strict';

// Integration test atas seluruh permukaan HTTP, memakai database in-memory (pg-mem) —
// tanpa perlu memasang Postgres. Jalankan: npm test (butuh Node >= 18 untuk node:test).

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-yang-cukup-panjang-1234';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'rahasiakuat123';
// String kosong (bukan delete): dotenv.config() di server.js tidak menimpa nilai yang sudah ada,
// sehingga mode pg-mem tetap terpaksa meski .env lokal punya DATABASE_URL.
process.env.DATABASE_URL = '';

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
        resolve({ status: res.statusCode, json, headers: res.headers, cookie: sc.map((c) => c.split(';')[0]).join('; ') });
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
  r = await req('POST', '/api/books/1/transactions', { cookie: adminCookie, body: { type: 'masuk', tanggal: '2026-07-01', jumlah: 5000000, dana: 'operasional' } });
  assert.equal(r.status, 201);
  r = await req('GET', '/api/books', { cookie: adminCookie });
  assert.equal(r.json.books[0].sisa, 6000000);
});

test('tanggal kalender mustahil ditolak', async () => {
  const r = await req('POST', '/api/books/1/transactions', { cookie: adminCookie, body: { type: 'keluar', tanggal: '2026-02-30', jumlah: 1000, dana: 'operasional' } });
  assert.equal(r.status, 400);
});

test('bukti format salah ditolak', async () => {
  const r = await req('POST', '/api/books/1/transactions', { cookie: adminCookie, body: { type: 'keluar', tanggal: '2026-07-02', jumlah: 1000, dana: 'operasional', bukti: 'data:image/png;base64,not*valid' } });
  assert.equal(r.status, 400);
});

test('soft-delete menyembunyikan transaksi dari daftar', async () => {
  let r = await req('POST', '/api/books/1/transactions', { cookie: adminCookie, body: { type: 'keluar', tanggal: '2026-07-03', jumlah: 200000, dana: 'operasional' } });
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

test('respons /api memakai Cache-Control no-store (data keuangan tak di-cache)', async () => {
  const r = await req('GET', '/api/books', { cookie: adminCookie });
  assert.match(String(r.headers['cache-control'] || ''), /no-store/);
});

test('CSP menyertakan object-src none', async () => {
  const r = await req('GET', '/healthz');
  assert.match(String(r.headers['content-security-policy'] || ''), /object-src 'none'/);
});

test('daftar pengguna hanya untuk admin (viewer 403)', async () => {
  assert.equal((await req('GET', '/api/auth/users', { cookie: viewerCookie })).status, 403);
  assert.equal((await req('GET', '/api/auth/users', { cookie: adminCookie })).status, 200);
});

test('login: username tak dikenal & password salah beri pesan sama (anti-enumerasi)', async () => {
  const a = await req('POST', '/api/auth/login', { body: { username: 'tidakada_zzz', password: 'apa sajakah' } });
  const b = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'passwordSALAH123' } });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.json.error, b.json.error); // pesan identik -> tak membocorkan keberadaan akun
});

test('hapus bulan: viewer ditolak, format invalid ditolak, admin hard-delete OK', async () => {
  // Siapkan transaksi Agustus (bulan yang akan dihapus) — Juli sudah ada dari tes sebelumnya.
  let r = await req('POST', '/api/books/1/transactions', {
    cookie: adminCookie,
    body: { type: 'masuk', tanggal: '2026-08-10', jumlah: 777000, keterangan: 'tes-purge-aug', dana: 'operasional' },
  });
  assert.equal(r.status, 201);
  const augId = r.json.transaction.id;

  r = await req('GET', '/api/months', { cookie: viewerCookie });
  assert.equal(r.status, 403);

  r = await req('POST', '/api/purge-month', { cookie: viewerCookie, body: { month: '2026-08', confirm: '2026-08' } });
  assert.equal(r.status, 403);

  r = await req('POST', '/api/purge-month', { cookie: adminCookie, body: { month: '2026-13', confirm: '2026-13' } });
  assert.equal(r.status, 400);

  r = await req('POST', '/api/purge-month', { cookie: adminCookie, body: { month: '2026-08', confirm: 'SALAH' } });
  assert.equal(r.status, 400);

  r = await req('GET', '/api/months', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.months.some((m) => m.month === '2026-08' && m.total >= 1));

  r = await req('POST', '/api/purge-month', { cookie: adminCookie, body: { month: '2026-08', confirm: '2026-08' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.deleted >= 1);

  // Transaksi Agustus hilang; Juli tetap ada.
  r = await req('GET', '/api/books/1/transactions?month=2026-08', { cookie: adminCookie });
  assert.ok(!r.json.transactions.some((t) => t.id === augId));
  r = await req('GET', '/api/books/1/transactions?month=2026-07', { cookie: adminCookie });
  assert.ok(r.json.transactions.length >= 1);

  // Soft-deleted Juli (dari tes sebelumnya) tetap ada di DB — purge bulan Agustus tidak menyentuhnya.
  // Audit mencatat aksi purge.
  r = await req('GET', '/api/auth/audit', { cookie: adminCookie });
  assert.ok(r.json.events.some((ev) => ev.action === 'purge' && /2026-08/.test(ev.detail || '')));
});

test('kategori dana: wajib, satu kategori per transaksi, saldo tidak dijumlahkan ganda', async () => {
  const { fundBalances } = await import('../public/js/ledger.js');
  let r = await req('POST', '/api/books', { cookie: adminCookie, body: { name: 'Dana Uji', saldo_awal: 500000 } });
  assert.equal(r.status, 201);
  const bookId = r.json.book.id;

  r = await req('POST', `/api/books/${bookId}/transactions`, {
    cookie: adminCookie,
    body: { type: 'masuk', tanggal: '2026-09-01', jumlah: 100000 },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /dana/i);

  r = await req('POST', `/api/books/${bookId}/transactions`, {
    cookie: adminCookie,
    body: { type: 'masuk', tanggal: '2026-09-01', jumlah: 100000, dana: 'setengah-setengah' },
  });
  assert.equal(r.status, 400);

  const created = [];
  const seed = [
    { type: 'masuk', jumlah: 100000, dana: 'operasional' },
    { type: 'masuk', jumlah: 40000, dana: 'saving' },
    { type: 'masuk', jumlah: 25000, dana: 'gabungan' },
    { type: 'keluar', jumlah: 10000, dana: 'operasional' },
    { type: 'keluar', jumlah: 5000, dana: 'gabungan' },
  ];
  for (const item of seed) {
    r = await req('POST', `/api/books/${bookId}/transactions`, {
      cookie: adminCookie,
      body: { type: item.type, tanggal: '2026-09-02', jumlah: item.jumlah, dana: item.dana, keterangan: item.dana },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.transaction.dana, item.dana);
    assert.equal(r.json.transaction.jumlah, item.jumlah);
    created.push(r.json.transaction);
  }

  r = await req('GET', `/api/books/${bookId}/transactions`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  const txs = r.json.transactions;
  assert.equal(txs.length, 5);
  const bal = fundBalances(txs);
  assert.equal(bal.operasional, 90000);
  assert.equal(bal.saving, 40000);
  assert.equal(bal.gabungan, 20000);
  assert.equal(bal.operasionalDanGabungan, 110000);
  assert.equal(bal.total, 150000);
  assert.notEqual(bal.gabungan, bal.operasional + bal.saving);

  const books = (await req('GET', '/api/books', { cookie: adminCookie })).json.books;
  const book = books.find((b) => b.id === bookId);
  assert.equal(book.sisa, 650000);

  const saving = created.find((t) => t.dana === 'saving');
  r = await req('PATCH', `/api/transactions/${saving.id}`, {
    cookie: adminCookie,
    body: { type: 'masuk', tanggal: '2026-09-02', jumlah: 40000, keterangan: 'pindah', kategori: '', dana: 'gabungan' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.transaction.dana, 'gabungan');

  r = await req('GET', `/api/books/${bookId}/transactions`, { cookie: adminCookie });
  const afterEdit = fundBalances(r.json.transactions);
  assert.equal(afterEdit.saving, 0);
  assert.equal(afterEdit.gabungan, 60000);
  assert.equal(afterEdit.operasional, 90000);
  assert.equal(afterEdit.total, 150000);

  const keluarOp = created.find((t) => t.type === 'keluar' && t.dana === 'operasional');
  r = await req('DELETE', `/api/transactions/${keluarOp.id}`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  r = await req('GET', `/api/books/${bookId}/transactions`, { cookie: adminCookie });
  const afterDel = fundBalances(r.json.transactions);
  assert.equal(afterDel.operasional, 100000);
  assert.equal(afterDel.total, 160000);
  assert.equal(r.json.transactions.length, 4);
});
