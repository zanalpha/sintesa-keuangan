'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const { migrate, isMemory } = require('./db');
const { router: authRouter, loadUser } = require('./auth');
const apiRouter = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.set('trust proxy', 1); // penting di Render agar secure cookie & req.ip benar

app.use(express.json({ limit: '256kb' }));

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

app.use(loadUser);

// API
app.use('/api/auth', authRouter);
app.use('/api', apiRouter);

// Cek kesehatan (untuk Render health check)
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Frontend statis
app.use(express.static(path.join(__dirname, '..', 'public')));

// 404 khusus API supaya tidak mengembalikan HTML
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

// Penanganan error terpusat
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan di server.' });
});

async function start() {
  await migrate();
  app.listen(PORT, () => {
    console.log(`\n  Sintesa Keuangan berjalan di http://localhost:${PORT}`);
    if (isMemory()) {
      console.log('  Mode: database sementara (data tidak permanen).');
    }
    console.log('');
  });
}

start().catch((e) => {
  console.error('Gagal memulai server:', e);
  process.exit(1);
});
