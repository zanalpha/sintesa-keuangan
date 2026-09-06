#!/usr/bin/env node
'use strict';
/**
 * Hapus PERMANEN (hard delete) semua transaksi dalam satu bulan YYYY-MM.
 * Soft-delete UI TIDAK menghemat ruang — skrip ini menghapus baris + blob bukti.
 *
 * Pakai:
 *   DATABASE_URL='postgres://…' node scripts/purge-month.js --month=2026-08 --dry-run
 *   DATABASE_URL='postgres://…' node scripts/purge-month.js --month=2026-08 --confirm
 *   DATABASE_URL='postgres://…' node scripts/purge-month.js --month=2026-08 --confirm --vacuum
 *
 * Opsi:
 *   --month=YYYY-MM   wajib
 *   --dry-run         default bila --confirm tidak ada
 *   --confirm         eksekusi hapus
 *   --vacuum          jalankan VACUUM ANALYZE setelah hapus (reclaim disk)
 */
require('dotenv').config();
const { Client } = require('pg');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || !args.includes('--confirm');
const doVacuum = args.includes('--vacuum');
const monthArg = args.find((a) => a.startsWith('--month='));
const month = monthArg ? monthArg.split('=')[1].trim() : '';

function monthRange(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym)) return null;
  const [y, m] = ym.split('-').map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12 || y < 2000 || y > 2100) return null;
  const start = `${ym}-01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const end = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
  return { start, end };
}

async function main() {
  const range = monthRange(month);
  if (!range) {
    console.error('Wajib --month=YYYY-MM (contoh --month=2026-08).');
    process.exit(1);
  }

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
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS soft_deleted,
       COUNT(*) FILTER (WHERE bukti IS NOT NULL AND bukti <> '')::int AS with_bukti,
       pg_size_pretty(pg_database_size(current_database())) AS db_size
     FROM transactions
     WHERE tanggal::text >= $1 AND tanggal::text < $2`,
    [range.start, range.end]
  );

  console.log(`Target hapus: ${range.start} .. < ${range.end} (${month})`);
  console.log(`Ukuran DB sekarang: ${stats.db_size}`);
  console.log(`Akan dihapus: ${stats.total} (soft-deleted: ${stats.soft_deleted}, dengan bukti: ${stats.with_bukti})`);

  if (dryRun) {
    console.log('\n[DRY-RUN] Tidak ada yang dihapus. Jalankan lagi dengan --confirm untuk eksekusi.');
    await client.end();
    return;
  }

  if (stats.total === 0) {
    console.log('Tidak ada baris untuk dihapus.');
    await client.end();
    return;
  }

  const del = await client.query(
    `DELETE FROM transactions
      WHERE tanggal::text >= $1 AND tanggal::text < $2
      RETURNING id`,
    [range.start, range.end]
  );
  console.log(`Dihapus: ${del.rowCount} baris`);

  if (doVacuum) {
    try {
      await client.query('VACUUM (VERBOSE, ANALYZE) transactions');
      console.log('VACUUM selesai.');
    } catch (e) {
      console.warn('VACUUM gagal (izin terbatas?):', e.message);
    }
  } else {
    console.log('Lewati VACUUM (tambah --vacuum bila ingin reclaim disk).');
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
