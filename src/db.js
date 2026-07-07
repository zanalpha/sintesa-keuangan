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
    const { Pool } = require('pg');
    const isLocal = /localhost|127\.0\.0\.1/.test(url);
    return new Pool({
      connectionString: url,
      // Render (dan hosting Postgres lain) memerlukan SSL untuk koneksi eksternal.
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 10,
    });
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

/** Menjalankan beberapa statement DDL satu per satu (kompatibel pg & pg-mem). */
async function run(statements) {
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (trimmed) await query(trimmed);
  }
}

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
    `CREATE INDEX IF NOT EXISTS idx_tx_book ON transactions(book_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tx_tanggal ON transactions(tanggal)`,
  ]);

  // Kolom tambahan (dijalankan setelah tabel ada; aman diulang di pg & pg-mem).
  await addColumn('books', "saldo_awal BIGINT NOT NULL DEFAULT 0", 'saldo_awal');
  await addColumn('books', "bank_info TEXT NOT NULL DEFAULT ''", 'bank_info');
}

/** Menambah kolom secara idempoten, kompatibel Postgres & pg-mem. */
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
    } catch (_) {
      /* abaikan jika balapan/duplikat */
    }
  }
}

function isMemory() {
  return usingMemory;
}

module.exports = { query, migrate, isMemory };
