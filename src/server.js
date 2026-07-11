'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const { migrate, seedAdmin, ping, end: dbEnd, isMemory } = require('./db');
const { router: authRouter, loadUser } = require('./auth');
const apiRouter = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.set('trust proxy', 1); // penting di Render agar secure cookie & req.ip benar

// Log ringkas per-request API (timestamp, metode, path, status, durasi) — bisa dicari di log Render.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t0}ms`
    );
  });
  next();
});

// Header keamanan (setara helmet, tanpa dependensi).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; " +
      "form-action 'self'; frame-ancestors 'none'"
  );
  if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '8mb' })); // besar untuk menampung bukti (gambar) yang sudah dikompres

const secret = process.env.SESSION_SECRET;
if (isProd && (!secret || secret.length < 16)) {
  console.error('FATAL: SESSION_SECRET wajib diisi (min 16 karakter) di produksi.');
  process.exit(1);
}
app.use(
  cookieSession({
    name: 'sintesa_kas',
    keys: [secret || 'dev-secret-tidak-aman-ganti-di-produksi'],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 hari
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
  })
);

// Muat user HANYA untuk permintaan /api (jangan jalankan kueri DB untuk tiap aset statis).
app.use('/api', loadUser);

// API
app.use('/api/auth', authRouter);
app.use('/api', apiRouter);

// Cek kesehatan — memverifikasi koneksi DB sungguhan (bukan sekadar proses hidup).
app.get('/healthz', async (req, res) => {
  const ok = await ping();
  res.status(ok ? 200 : 503).json({ ok, db: ok ? 'up' : 'down' });
});

// Frontend statis
app.use(express.static(path.join(__dirname, '..', 'public')));

// 404 khusus API supaya tidak mengembalikan HTML
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

// Penanganan error terpusat — hormati status error yang sudah diset (mis. body-parser
// memberi 413 saat bukti melebihi 8mb, atau 400 saat JSON rusak), jangan paksa semua ke 500.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err); // hanya error server sungguhan yang perlu dicatat
  let message;
  if (status === 413) message = 'Data yang dikirim terlalu besar (mis. bukti melebihi batas ukuran).';
  else if (err.type === 'entity.parse.failed') message = 'Format data (JSON) tidak valid.';
  else if (status < 500) message = err.message || 'Permintaan tidak valid.';
  else message = 'Terjadi kesalahan di server.';
  res.status(status).json({ error: message });
});

// Jangan biarkan promise rejection tak tertangani menjatuhkan proses; cukup catat.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});

let server;

async function start() {
  await migrate();
  await seedAdmin();
  server = app.listen(PORT, () => {
    console.log(`\n  Sintesa Keuangan berjalan di http://localhost:${PORT}`);
    if (isMemory()) console.log('  Mode: database sementara (data tidak permanen).');
    console.log('');
  });
  return server;
}

// Matikan dengan rapi saat deploy (Render mengirim SIGTERM): berhenti terima koneksi baru,
// tunggu request berjalan selesai, tutup pool DB, lalu keluar.
function shutdown(signal) {
  console.log(`[server] ${signal} diterima — mematikan dengan rapi...`);
  const done = () => dbEnd().finally(() => process.exit(0));
  if (server) server.close(done);
  else done();
  setTimeout(() => process.exit(1), 10000).unref(); // paksa keluar bila menggantung
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Hanya jalankan server bila dieksekusi langsung (bukan saat di-import oleh test).
if (require.main === module) {
  start().catch((e) => {
    console.error('Gagal memulai server:', e);
    process.exit(1);
  });
}

module.exports = { app, start };
