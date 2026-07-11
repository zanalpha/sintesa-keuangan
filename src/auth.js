'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('./db');

const router = express.Router();

// ---- Anti brute-force sederhana (per IP) ----
const attempts = new Map(); // ip -> { count, first }
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}
function noteFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}
function clearFailures(ip) {
  attempts.delete(ip);
}

// ---- Helper ----
function publicUser(row) {
  return { id: row.id, username: row.username, name: row.name };
}

async function countUsers() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM users');
  return rows[0].n;
}

function validUsername(u) {
  return typeof u === 'string' && /^[a-z0-9_.]{3,32}$/.test(u);
}

// ---- Middleware ----
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Silakan login terlebih dahulu.' });
}

async function loadUser(req, res, next) {
  if (req.session && req.session.userId) {
    const { rows } = await query('SELECT id, username, name FROM users WHERE id = $1', [
      req.session.userId,
    ]);
    req.user = rows[0] || null;
    if (!req.user) req.session = null; // user terhapus -> reset sesi
  }
  next();
}

// ---- Routes ----

// Status: apakah sudah ada user (untuk menentukan tampilan daftar/login) & siapa yang login.
router.get('/status', async (req, res, next) => {
  try {
    const n = await countUsers();
    res.json({
      hasUsers: n > 0,
      authenticated: !!req.user,
      user: req.user ? publicUser(req.user) : null,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Registrasi:
// - Jika belum ada user sama sekali -> boleh membuat akun pertama (bootstrap).
// - Jika sudah ada user -> hanya user yang sudah login yang boleh menambah akun baru.
router.post('/register', async (req, res, next) => {
  try {
    const n = await countUsers();
    if (n > 0 && !(req.session && req.session.userId)) {
      return res.status(403).json({ error: 'Hanya pengguna terdaftar yang bisa menambah akun.' });
    }

    const username = String(req.body.username || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');

    if (!validUsername(username)) {
      return res
        .status(400)
        .json({ error: 'Username 3-32 karakter, hanya huruf kecil, angka, titik, garis bawah.' });
    }
    if (name.length < 2) return res.status(400).json({ error: 'Nama minimal 2 karakter.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter.' });

    const exists = await query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username sudah dipakai.' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      'INSERT INTO users (username, name, password_hash) VALUES ($1, $2, $3) RETURNING id, username, name',
      [username, name, hash]
    );
    const user = rows[0];

    // Akun pertama langsung dianggap login.
    if (n === 0) req.session = { userId: user.id };

    res.status(201).json({ user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const ip = req.ip;
    if (tooManyAttempts(ip)) {
      return res
        .status(429)
        .json({ error: 'Terlalu banyak percobaan. Coba lagi dalam beberapa menit.' });
    }

    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password, user.password_hash));

    if (!ok) {
      noteFailure(ip);
      return res.status(401).json({ error: 'Username atau password salah.' });
    }

    clearFailures(ip);
    req.session = { userId: user.id };
    res.json({ user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// Ganti password sendiri.
router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const current = String(req.body.current_password || '');
    const next_ = String(req.body.new_password || '');
    if (next_.length < 6) return res.status(400).json({ error: 'Password baru minimal 6 karakter.' });
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    const ok = rows[0] && (await bcrypt.compare(current, rows[0].password_hash));
    if (!ok) return res.status(401).json({ error: 'Password lama salah.' });
    const hash = await bcrypt.hash(next_, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Daftar pengguna (untuk halaman kelola pengguna).
router.get('/users', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, username, name, created_at FROM users ORDER BY id');
    res.json({ users: rows });
  } catch (e) {
    next(e);
  }
});

// Hapus pengguna. Tidak boleh menghapus diri sendiri atau pengguna terakhir.
// Referensi created_by pada books/transactions di-null-kan agar tidak melanggar foreign key.
router.delete('/users/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID tidak valid.' });
    if (id === req.session.userId) return res.status(400).json({ error: 'Tidak bisa menghapus akun Anda sendiri.' });
    const n = await countUsers();
    if (n <= 1) return res.status(400).json({ error: 'Minimal harus ada satu pengguna.' });
    const { rows } = await query('SELECT id FROM users WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
    await withTransaction(async (q) => {
      await q('UPDATE books SET created_by = NULL WHERE created_by = $1', [id]);
      await q('UPDATE transactions SET created_by = NULL WHERE created_by = $1', [id]);
      await q('DELETE FROM users WHERE id = $1', [id]);
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = { router, requireAuth, loadUser };
