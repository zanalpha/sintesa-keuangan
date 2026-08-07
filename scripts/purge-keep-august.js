#!/usr/bin/env node
'use strict';
/**
 * Hapus transaksi di luar bulan Agustus (tahun berjalan, atau --year=YYYY).
 * Pertahankan HANYA Agustus agar DB lebih kecil (bukti/blob ikut terhapus).
 *
 * Soft-delete UI TIDAK menghemat ruang. Skrip ini HARD DELETE + VACUUM.
 *
 * Pakai:
 *   DATABASE_URL='postgres://…' node scripts/purge-keep-august.js --dry-run
 *   DATABASE_URL='postgres://…' node scripts/purge-keep-august.js --confirm
 *
 * Default tahun = tahun kalender saat ini.
 */
require('dotenv').config();
const { Client } = require('pg');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || !args.includes('--confirm');
const yearArg = args.find((a) => a.startsWith('--year='));
const year = yearArg ? Number(yearArg.split('=')[1]) : new Date().getFullYear();

if (!Number.isInteger(year) || year < 2000 || year > 2100) {
  console.error('Tahun tidak valid.');
  process.exit(1);
}

const keepStart = `${year}-08-01`;
const keepEnd = `${year}-09-01`; // exclusive

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL belum di-set. Ambil Internal/External Database URL dari Render → Postgres → Connections.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows: [stats] } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE tanggal::text >= $1 AND tanggal::text < $2) AS keep_aug,
       COUNT(*) FILTER (WHERE NOT (tanggal::text >= $1 AND tanggal::text < $2)) AS purge,
       COUNT(*) FILTER (WHERE tanggal::text >= $3 AND tanggal::text < $1) AS july,
       pg_size_pretty(pg_database_size(current_database())) AS db_size
     FROM transactions`,
    [keepStart, keepEnd, `${year}-07-01`]
  );

  console.log(`Target: pertahankan ${keepStart} .. < ${keepEnd}`);
  console.log(`Ukuran DB sekarang: ${stats.db_size}`);
  console.log(`Tetap (Agustus ${year}): ${stats.keep_aug}`);
  console.log(`Juli ${year}: ${stats.july}`);
  console.log(`Akan dihapus (semua non-Agustus): ${stats.purge}`);

  if (dryRun) {
    console.log('\n[DRY-RUN] Tidak ada yang dihapus. Jalankan lagi dengan --confirm untuk eksekusi.');
    await client.end();
    return;
  }

  const del = await client.query(
    `DELETE FROM transactions
      WHERE NOT (tanggal::text >= $1 AND tanggal::text < $2)
      RETURNING id`,
    [keepStart, keepEnd]
  );
  console.log(`Dihapus: ${del.rowCount} baris`);

  // Reclaim disk (Postgres free / Render)
  try {
    await client.query('VACUUM (VERBOSE, ANALYZE) transactions');
    console.log('VACUUM selesai.');
  } catch (e) {
    console.warn('VACUUM gagal (izin terbatas?):', e.message);
  }

  const { rows: [after] } = await client.query(
    `SELECT COUNT(*)::int AS left,
            pg_size_pretty(pg_database_size(current_database())) AS db_size
       FROM transactions`
  );
  console.log(`Sisa transaksi: ${after.left}; ukuran DB: ${after.db_size}`);
  await client.end();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
