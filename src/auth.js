'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, withTransaction, audit } = require('./db');

const router = express.Router();

const BCRYPT_COST = 12; // di atas anjuran OWASP (>=12); untuk sedikit user, biayanya tak terasa.

// ---- Anti brute-force: dibatasi per-IP DAN per-akun ----
const WINDOW_MS = 15 * 60 * 1000;
const IP_MAX = 20; // satu IP kantor bisa dipakai banyak orang -> longgar
const USER_MAX = 8; // per username -> ketat, mencegah tebak sandi satu akun
const ipAttempts = new Map(); // ip -> { count, first }
const userAttempts = new Map(); // username -> { count, first }

function tooMany(map, key, max) {
  const rec = map.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    map.delete(key);
    return false;
  }
  return rec.count >= max;
}
function noteFailure(map, key) {
  const rec = map.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) map.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
}

// ---- Helper ----
function publicUser(row) {
  return { id: row.id, username: row.username, name: row.name, role: row.role || 'admin' };
}

async function countUsers() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM users');
  return rows[0].n;
}

function validUsername(u) {
  return typeof u === 'string' && /^[a-z0-9_.]{3,32}$/.test(u);
}

// Kebijakan password: cukup panjang, bukan yang umum, dan tak sama dengan username.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', '12345678', '123456789', '1234567890', 'qwerty123',
  'admin123', 'sintesa123', 'keuangan123', 'rahasia123', 'iloveyou', 'letmein',
]);
function passwordError(pw, username) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password minimal 10 karakter.';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'Password terlalu umum — pilih yang lebih sulit ditebak.';
  if (username && pw.toLowerCase() === String(username).toLowerCase())
    return 'Password tidak boleh sama dengan username.';
  return null;
}

// ---- Middleware ----
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Silakan login terlebih dahulu.' });
}

// Hanya admin yang boleh mengubah data / mengelola pengguna (peran 'viewer' = baca saja).
function requireAdmin(req, res, next) {
  if (!(req.session && req.session.userId)) return res.status(401).json({ error: 'Silakan login terlebih dahulu.' });
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Hanya admin yang dapat melakukan tindakan ini.' });
}

async function loadUser(req, res, next) {
  try {
    if (req.session && req.session.userId) {
      const { rows } = await query('SELECT id, username, name, role FROM users WHERE id = $1', [
        req.session.userId,
      ]);
      req.user = rows[0] || null;
      if (!req.user) req.session = null; // user terhapus -> reset sesi
    }
    next();
  } catch (e) {
    next(e);
  }
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

// Menambah pengguna — hanya admin. Akun admin PERTAMA dibuat lewat env (lihat db.seedAdmin),
// bukan registrasi publik, sehingga tak ada celah "pengunjung pertama jadi admin".
router.post('/register', requireAdmin, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');
    const role = req.body.role === 'viewer' ? 'viewer' : 'admin';

    if (!validUsername(username)) {
      return res
        .status(400)
        .json({ error: 'Username 3-32 karakter, hanya huruf kecil, angka, titik, garis bawah.' });
    }
    if (name.length < 2) return res.status(400).json({ error: 'Nama minimal 2 karakter.' });
    const pwErr = passwordError(password, username);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const exists = await query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username sudah dipakai.' });

    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const { rows } = await query(
      'INSERT INTO users (username, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, name, role',
      [username, name, hash, role]
    );
    const user = rows[0];
    await audit({ userId: req.user.id, username: req.user.username, action: 'create', entity: 'user', entityId: user.id, detail: `${username} (${role})` });
    res.status(201).json({ user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const ip = req.ip;
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (tooMany(ipAttempts, ip, IP_MAX) || tooMany(userAttempts, username, USER_MAX)) {
      return res
        .status(429)
        .json({ error: 'Terlalu banyak percobaan. Coba lagi dalam beberapa menit.' });
    }

    const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password, user.password_hash));

    if (!ok) {
      noteFailure(ipAttempts, ip);
      noteFailure(userAttempts, username);
      return res.status(401).json({ error: 'Username atau password salah.' });
    }

    ipAttempts.delete(ip);
    userAttempts.delete(username);
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
    const pwErr = passwordError(next_, req.user && req.user.username);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    const ok = rows[0] && (await bcrypt.compare(current, rows[0].password_hash));
    if (!ok) return res.status(401).json({ error: 'Password lama salah.' });
    const hash = await bcrypt.hash(next_, BCRYPT_COST);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
    await audit({ userId: req.user.id, username: req.user.username, action: 'password_change', entity: 'user', entityId: req.user.id });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Daftar pengguna (untuk halaman kelola pengguna).
router.get('/users', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, username, name, role, created_at FROM users ORDER BY id');
    res.json({ users: rows });
  } catch (e) {
    next(e);
  }
});

// Riwayat audit (hanya admin) — 200 kejadian terakhir.
router.get('/audit', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT at, username, action, entity, entity_id, detail FROM audit_log ORDER BY id DESC LIMIT 200'
    );
    res.json({ events: rows });
  } catch (e) {
    next(e);
  }
});

// Hapus pengguna (hanya admin). Tidak boleh menghapus diri sendiri atau pengguna terakhir.
// Referensi created_by pada books/transactions di-null-kan agar tidak melanggar foreign key.
router.delete('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID tidak valid.' });
    if (id === req.session.userId) return res.status(400).json({ error: 'Tidak bisa menghapus akun Anda sendiri.' });
    const n = await countUsers();
    if (n <= 1) return res.status(400).json({ error: 'Minimal harus ada satu pengguna.' });
    const { rows } = await query('SELECT id, username FROM users WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
    await withTransaction(async (q) => {
      await q('UPDATE books SET created_by = NULL WHERE created_by = $1', [id]);
      await q('UPDATE transactions SET created_by = NULL WHERE created_by = $1', [id]);
      await q('DELETE FROM users WHERE id = $1', [id]);
      await audit({ userId: req.user.id, username: req.user.username, action: 'delete', entity: 'user', entityId: id, detail: rows[0].username }, q);
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = { router, requireAuth, requireAdmin, loadUser };
