'use strict';

/**
 * Lapisan database.
 * - Jika DATABASE_URL diisi (produksi/Render) -> memakai Postgres sungguhan lewat "pg".
 * - Jika kosong (lokal/dev) -> memakai Postgres in-memory "pg-mem" agar bisa langsung
 *   dijalankan tanpa memasang database. PERINGATAN: data pada mode ini tidak permanen.
 */

let pool;
let usingMemory = false;

function createPool() {
  const url = process.env.DATABASE_URL;

  if (url) {
    const pg = require('pg');
    // Kembalikan kolom DATE (OID 1082) sebagai string 'YYYY-MM-DD' apa adanya — bukan objek
    // Date yang bisa bergeser zona waktu. Menjaga logika tanggal frontend/backend tetap sama
    // meski tipe kolom kini DATE.
    pg.types.setTypeParser(1082, (v) => v);
    const { Pool } = pg;
    const isLocal = /localhost|127\.0\.0\.1/.test(url);
    // Verifikasi sertifikat server DB dapat diaktifkan (defense-in-depth) via PGSSL_STRICT=1.
    // Default longgar agar tetap tersambung ke Postgres Render (sertifikat self-signed).
    const strictSsl = process.env.PGSSL_STRICT === '1' || process.env.PGSSL_STRICT === 'true';
    const pgPool = new Pool({
      connectionString: url,
      // Render (dan hosting Postgres lain) memerlukan SSL untuk koneksi eksternal.
      ssl: isLocal ? false : { rejectUnauthorized: strictSsl },
      max: 10,
      // Batas waktu agar permintaan GAGAL CEPAT alih-alih menggantung tanpa akhir
      // saat DB baru bangun / ada gangguan jaringan (tanpa ini, connect() menunggu selamanya).
      connectionTimeoutMillis: 10000, // maksimal 10 dtk menunggu koneksi dari pool
      idleTimeoutMillis: 30000, // daur ulang koneksi menganggur >30 dtk (sebelum Render memutusnya)
      keepAlive: true, // TCP keep-alive: kurangi pemutusan koneksi idle di jaringan cloud
    });
    // PENTING: tanpa listener ini, error pada koneksi idle (mis. Postgres Render
    // memutus koneksi menganggur) akan dilempar sebagai 'uncaught' dan MEMATIKAN proses.
    // Dengan listener, error cukup dicatat; koneksi rusak dibuang, pool memulihkan diri.
    pgPool.on('error', (err) => {
      console.error('[db] Koneksi idle bermasalah (diabaikan, pool memulihkan diri):', err.message);
    });
    return pgPool;
  }

  // Fallback dev: Postgres in-memory.
  usingMemory = true;
  console.warn(
    '[db] DATABASE_URL belum diisi — memakai database SEMENTARA di memori (pg-mem).\n' +
      '      Data TIDAK akan tersimpan setelah server dimatikan. Untuk produksi, isi DATABASE_URL.'
  );
  const { newDb } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  // Beberapa fungsi yang dipakai aplikasi perlu didaftarkan agar dikenali pg-mem.
  mem.public.registerFunction({
    name: 'now',
    returns: require('pg-mem').DataType.timestamptz,
    implementation: () => new Date(),
  });
  const adapter = mem.adapters.createPg();
  return new adapter.Pool();
}

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Menjalankan `fn` di dalam satu transaksi database (BEGIN/COMMIT, ROLLBACK bila gagal).
 * `fn` menerima fungsi `q(text, params)` yang HARUS dipakai untuk semua kueri di dalamnya,
 * agar berjalan pada koneksi yang sama.
 *
 * Di mode pg-mem (lokal/dev) pool tidak selalu mendukung .connect(); dalam hal itu
 * kita jalankan `fn` dengan query() biasa (best-effort, tanpa isolasi sungguhan) —
 * cukup untuk pengembangan karena data memori memang tidak permanen.
 */
async function withTransaction(fn) {
  const p = getPool();
  if (usingMemory || typeof p.connect !== 'function') {
    return fn(query);
  }
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* abaikan kegagalan rollback */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Menjalankan beberapa statement DDL satu per satu (kompatibel pg & pg-mem). */
async function run(statements) {
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (trimmed) await query(trimmed);
  }
}

// Versi skema saat ini. Naikkan bila menambah langkah migrasi baru.
const SCHEMA_VERSION = 3;

/** Membuat tabel bila belum ada. Aman dipanggil berulang kali. */
async function migrate() {
  await run([
    `CREATE TABLE IF NOT EXISTS users (
       id            SERIAL PRIMARY KEY,
       username      TEXT UNIQUE NOT NULL,
       name          TEXT NOT NULL,
       password_hash TEXT NOT NULL,
       created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS books (
       id         SERIAL PRIMARY KEY,
       name       TEXT NOT NULL,
       created_by INTEGER REFERENCES users(id),
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS transactions (
       id          SERIAL PRIMARY KEY,
       book_id     INTEGER NOT NULL REFERENCES books(id),
       type        TEXT NOT NULL,
       tanggal     TEXT NOT NULL,
       jumlah      BIGINT NOT NULL,
       keterangan  TEXT NOT NULL DEFAULT '',
       kategori    TEXT NOT NULL DEFAULT '',
       created_by  INTEGER REFERENCES users(id),
       created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    // Jejak audit: siapa melakukan apa (buat/ubah/hapus) — penting untuk catatan keuangan.
    `CREATE TABLE IF NOT EXISTS audit_log (
       id        SERIAL PRIMARY KEY,
       at        TIMESTAMPTZ NOT NULL DEFAULT now(),
       user_id   INTEGER,
       username  TEXT,
       action    TEXT NOT NULL,
       entity    TEXT NOT NULL,
       entity_id INTEGER,
       detail    TEXT NOT NULL DEFAULT ''
     )`,
    // Pelacakan versi skema (menggantikan migrasi ad-hoc yang tak tercatat).
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_tx_book ON transactions(book_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tx_tanggal ON transactions(tanggal)`,
    // Index komposit untuk kueri per-rekening per-rentang tanggal.
    `CREATE INDEX IF NOT EXISTS idx_tx_book_tanggal ON transactions(book_id, tanggal)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at)`,
  ]);

  // Kolom tambahan (dijalankan setelah tabel ada; aman diulang di pg & pg-mem).
  await addColumn('books', "saldo_awal BIGINT NOT NULL DEFAULT 0", 'saldo_awal');
  await addColumn('books', "bank_info TEXT NOT NULL DEFAULT ''", 'bank_info');
  await addColumn('transactions', 'bukti TEXT', 'bukti'); // data URL gambar/pdf, boleh kosong
  await addColumn('transactions', 'deleted_at TIMESTAMPTZ', 'deleted_at'); // soft-delete transaksi
  await addColumn('books', 'deleted_at TIMESTAMPTZ', 'deleted_at'); // soft-delete rekening (bisa dipulihkan)
  await addColumn('users', "role TEXT NOT NULL DEFAULT 'admin'", 'role'); // 'admin' | 'viewer'
  // Epoch sesi: dinaikkan saat ganti password untuk mencabut sesi lama (di perangkat lain).
  await addColumn('users', 'session_epoch INTEGER NOT NULL DEFAULT 0', 'session_epoch');

  // Integritas tingkat DB: ubah tanggal TEXT -> DATE (Postgres akan menolak tanggal mustahil).
  // Nilai lama 'YYYY-MM-DD' di-cast mulus; type parser 1082 menjaga hasilnya tetap string.
  // Di pg-mem / information_schema tak lengkap, langkah ini dilewati (TEXT berperilaku setara).
  let dateColOk = true; // apakah kolom tanggal sudah/berhasil menjadi DATE (integritas aktif)?
  try {
    const { rows } = await query(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'tanggal'"
    );
    if (rows[0] && rows[0].data_type === 'text') {
      await query('ALTER TABLE transactions ALTER COLUMN tanggal TYPE DATE USING tanggal::date');
      console.log('[db] Kolom transactions.tanggal dimigrasi TEXT -> DATE.');
    }
  } catch (e) {
    // Mis. ada baris 'YYYY-MM-DD' yang mustahil (peninggalan v1/restore) menolak cast.
    dateColOk = false;
    console.warn('[db] Migrasi tanggal ke DATE GAGAL (kolom tetap TEXT); akan dicoba lagi saat start berikutnya:', e.message);
  }

  // Catat versi skema HANYA bila semua langkah (termasuk DATE) sukses — agar catatan versi tidak
  // "berbohong" dan langkah yang gagal benar-benar dicoba ulang pada start berikutnya.
  // (best-effort; abaikan bila balapan antar-instance).
  if (dateColOk) {
    try {
      await query('INSERT INTO schema_migrations (version) VALUES ($1)', [SCHEMA_VERSION]);
    } catch (_) {
      /* versi sudah tercatat */
    }
  }
}

/**
 * Menambah kolom secara idempoten, kompatibel Postgres & pg-mem.
 * Bila semua upaya gagal karena alasan tak terduga (bukan "kolom sudah ada"),
 * error dicatat alih-alih ditelan diam-diam.
 */
async function addColumn(table, coldef, colname) {
  try {
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${coldef}`);
    return; // Postgres modern
  } catch (_) {
    /* pg-mem mungkin tak mendukung IF NOT EXISTS -> lanjut fallback */
  }
  try {
    await query(`SELECT ${colname} FROM ${table} LIMIT 1`);
    return; // kolom sudah ada
  } catch (_) {
    try {
      await query(`ALTER TABLE ${table} ADD COLUMN ${coldef}`);
    } catch (e) {
      console.error(`[db] Gagal menambah kolom ${table}.${colname}:`, e.message);
    }
  }
}

/**
 * Membuat akun admin pertama dari variabel lingkungan ADMIN_USER/ADMIN_PASSWORD
 * bila tabel users masih kosong. Menutup celah "pengunjung pertama jadi admin"
 * pada instance baru / DB yang di-provision ulang, dan membuat aplikasi langsung
 * bisa dipakai tanpa registrasi publik.
 */
async function seedAdmin() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  const username = String(process.env.ADMIN_USER || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  const name = String(process.env.ADMIN_NAME || 'Administrator').trim();
  // Akun admin pertama = paling berkuasa. Samakan dengan kebijakan aplikasi (min 10 karakter),
  // jangan izinkan password lemah 6-karakter yang mudah ditebak.
  if (!username || password.length < 10) {
    console.warn(
      '[db] Belum ada pengguna dan ADMIN_USER/ADMIN_PASSWORD belum diisi (atau password < 10 karakter).\n' +
        '      Set env ADMIN_USER & ADMIN_PASSWORD (min 10 karakter) lalu restart untuk membuat admin pertama.'
    );
    return;
  }
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(password, 12);
  try {
    await query(
      "INSERT INTO users (username, name, password_hash, role) VALUES ($1, $2, $3, 'admin')",
      [username, name, hash]
    );
    console.log(`[db] Admin pertama '${username}' dibuat dari environment.`);
  } catch (e) {
    // Bila dua instance melakukan seed bersamaan, UNIQUE(username) menolak yang kedua.
    // Itu bukan kegagalan fatal — admin sudah ada — jadi cukup dicatat, jangan matikan startup.
    console.warn('[db] Seed admin dilewati (kemungkinan sudah dibuat instance lain):', e.message);
  }
}

/** Cek konektivitas DB untuk health check. */
async function ping() {
  try {
    await query('SELECT 1');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Mencatat satu baris jejak audit (best-effort — kegagalan audit tak menggagalkan operasi).
 * `q` opsional: berikan fungsi kueri dari withTransaction agar audit ikut dalam transaksi.
 */
async function audit(entry, q) {
  const run_ = q || query;
  try {
    await run_(
      `INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.userId ?? null,
        entry.username ?? null,
        entry.action,
        entry.entity,
        entry.entityId ?? null,
        entry.detail ?? '',
      ]
    );
  } catch (e) {
    console.error('[db] Gagal menulis audit_log:', e.message);
  }
}

function isMemory() {
  return usingMemory;
}

/** Menutup pool koneksi (untuk graceful shutdown). */
async function end() {
  if (pool && typeof pool.end === 'function') {
    try { await pool.end(); } catch (_) { /* abaikan */ }
  }
}

module.exports = { query, withTransaction, migrate, seedAdmin, ping, audit, isMemory, end };
