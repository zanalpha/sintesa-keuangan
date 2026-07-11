'use strict';

const express = require('express');
const { query, withTransaction, audit } = require('./db');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
router.use(requireAuth); // semua route di bawah ini butuh login (baca). Mutasi butuh requireAdmin.

// Validasi parameter :id sekali di sini agar id non-angka (mis. /api/books/abc)
// menghasilkan 400 yang jelas, bukan 500 dari Postgres ("invalid input syntax for integer").
router.param('id', (req, res, next, val) => {
  if (!/^\d+$/.test(val)) return res.status(400).json({ error: 'ID tidak valid.' });
  next();
});

// ---------- Helper ----------
const num = (v) => Number(v); // BIGINT dikembalikan sebagai string oleh pg -> jadikan number

function parseAmount(v) {
  // Terima angka atau string angka (rupiah bulat, tanpa desimal).
  const cleaned = String(v == null ? '' : v).replace(/[^\d-]/g, '');
  if (cleaned === '' || cleaned === '-') return null; // kosong/bukan angka -> tolak
  const n = Number(cleaned);
  if (!Number.isInteger(n) || n < 0 || n > 1e15) return null;
  return n;
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // Date.parse tidak cukup: V8 "menggulung" tanggal mustahil (31 April -> 1 Mei),
  // jadi kita cek komponennya kembali agar 2026-04-31 / 2026-02-30 / 29 Feb non-kabisat ditolak.
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Rentang tanggal untuk filter bulan "YYYY-MM" -> [awal, awalBulanBerikutnya)
function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const end = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
  return { start, end };
}

async function bookExists(id) {
  const { rows } = await query('SELECT id FROM books WHERE id = $1', [id]);
  return rows.length > 0;
}

// ---------- BACKUP ----------
// Unduh seluruh data (semua buku + transaksi + bukti) sebagai JSON v2.
// DI-STREAM per-batch agar tak menahan SEMUA blob bukti di memori sekaligus (cegah OOM).
router.get('/backup', requireAdmin, async (req, res, next) => {
  try {
    res.type('application/json');
    const books = (await query('SELECT id, name, saldo_awal, bank_info, created_at FROM books ORDER BY id')).rows
      .map((b) => ({ ...b, saldo_awal: num(b.saldo_awal) }));
    res.write('{"app":"sintesa-keuangan","version":2,"books":' + JSON.stringify(books) + ',"transactions":[');
    const BATCH = 200;
    let offset = 0, first = true;
    for (;;) {
      const { rows } = await query(
        `SELECT id, book_id, type, tanggal, jumlah, keterangan, kategori, bukti, created_at
           FROM transactions WHERE deleted_at IS NULL ORDER BY id LIMIT $1 OFFSET $2`,
        [BATCH, offset]
      );
      if (rows.length === 0) break;
      for (const t of rows) {
        res.write((first ? '' : ',') + JSON.stringify({ ...t, jumlah: num(t.jumlah) }));
        first = false;
      }
      offset += rows.length;
      if (rows.length < BATCH) break;
    }
    res.write(']}');
    res.end();
  } catch (e) {
    if (res.headersSent) res.end();
    else next(e);
  }
});

// ---------- RESTORE ----------
// Memulihkan data dari JSON hasil /backup (v1/v2). Hanya admin.
// mode 'replace' menghapus data yang ada lebih dulu; tanpa itu, hanya boleh saat DB masih kosong.
router.post('/restore', requireAdmin, async (req, res, next) => {
  try {
    const data = req.body || {};
    const books = Array.isArray(data.books) ? data.books : null;
    const txs = Array.isArray(data.transactions) ? data.transactions : null;
    if (!books || !txs) return res.status(400).json({ error: 'File cadangan tidak valid (butuh books & transactions).' });
    const mode = data.mode === 'replace' || req.query.mode === 'replace' ? 'replace' : 'empty-only';

    const result = await withTransaction(async (q) => {
      const existing = (await q('SELECT COUNT(*)::int AS n FROM books')).rows[0].n;
      if (existing > 0 && mode !== 'replace') {
        const err = new Error('Database tidak kosong. Gunakan mode "replace" untuk menimpa.');
        err.status = 409;
        throw err;
      }
      if (mode === 'replace') {
        await q('DELETE FROM transactions');
        await q('DELETE FROM books');
      }
      // Petakan id buku lama -> id buku baru (SERIAL memberi id baru).
      const idMap = new Map();
      let nb = 0, nt = 0;
      for (const b of books) {
        const name = String(b.name || '').trim().slice(0, 100) || 'Rekening';
        const saldo = parseAmount(b.saldo_awal) ?? 0;
        const bank = String(b.bank_info || '').trim().slice(0, 200);
        const r = await q(
          'INSERT INTO books (name, saldo_awal, bank_info, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
          [name, saldo, bank, req.session.userId]
        );
        idMap.set(b.id, r.rows[0].id);
        nb++;
      }
      for (const t of txs) {
        const bookId = idMap.get(t.book_id);
        if (!bookId) continue; // transaksi tanpa buku terpetakan -> lewati
        const { type, tanggal, jumlah, keterangan, kategori } = readTxBody(t);
        if (!type || !validDate(tanggal) || jumlah === null) continue;
        const nbk = normBukti(t.bukti);
        await q(
          `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, bukti, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [bookId, type, tanggal, jumlah, keterangan, kategori, nbk.ok ? nbk.value : null, req.session.userId]
        );
        nt++;
      }
      await audit({ userId: req.user.id, username: req.user.username, action: 'restore', entity: 'database', detail: `${nb} rekening, ${nt} transaksi (${mode})` }, q);
      return { books: nb, transactions: nt, mode };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

// ---------- BUKU KAS ----------

router.get('/books', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT b.id, b.name, b.saldo_awal, b.bank_info,
              COALESCE(SUM(CASE WHEN t.type = 'masuk'  THEN t.jumlah END), 0) AS masuk,
              COALESCE(SUM(CASE WHEN t.type = 'keluar' THEN t.jumlah END), 0) AS keluar
         FROM books b
         LEFT JOIN transactions t ON t.book_id = b.id AND t.deleted_at IS NULL
        GROUP BY b.id, b.name, b.saldo_awal, b.bank_info
        ORDER BY b.id`
    );
    const books = rows.map((r) => ({
      id: r.id,
      name: r.name,
      saldo_awal: num(r.saldo_awal),
      bank_info: r.bank_info || '',
      masuk: num(r.masuk),
      keluar: num(r.keluar),
      sisa: num(r.saldo_awal) + num(r.masuk) - num(r.keluar),
    }));
    res.json({ books });
  } catch (e) {
    next(e);
  }
});

function readBookBody(body) {
  const name = String(body.name || '').trim();
  const rawSaldo = body.saldo_awal;
  // Saldo awal boleh kosong -> dianggap 0.
  const saldo_awal =
    rawSaldo == null || String(rawSaldo).trim() === '' ? 0 : parseAmount(rawSaldo);
  const bank_info = String(body.bank_info || '').trim().slice(0, 200);
  return { name, saldo_awal, bank_info };
}

router.post('/books', requireAdmin, async (req, res, next) => {
  try {
    const { name, saldo_awal, bank_info } = readBookBody(req.body);
    if (name.length < 1 || name.length > 100)
      return res.status(400).json({ error: 'Nama buku 1-100 karakter.' });
    if (saldo_awal === null) return res.status(400).json({ error: 'Saldo awal tidak valid.' });
    const { rows } = await query(
      'INSERT INTO books (name, saldo_awal, bank_info, created_by) VALUES ($1, $2, $3, $4) RETURNING id, name, saldo_awal, bank_info',
      [name, saldo_awal, bank_info, req.session.userId]
    );
    const b = rows[0];
    await audit({ userId: req.user.id, username: req.user.username, action: 'create', entity: 'book', entityId: b.id, detail: name });
    res.status(201).json({
      book: { id: b.id, name: b.name, saldo_awal: num(b.saldo_awal), bank_info: b.bank_info || '', masuk: 0, keluar: 0, sisa: num(b.saldo_awal) },
    });
  } catch (e) {
    next(e);
  }
});

router.patch('/books/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, saldo_awal, bank_info } = readBookBody(req.body);
    if (name.length < 1 || name.length > 100)
      return res.status(400).json({ error: 'Nama buku 1-100 karakter.' });
    if (saldo_awal === null) return res.status(400).json({ error: 'Saldo awal tidak valid.' });
    const { rows } = await query(
      'UPDATE books SET name = $1, saldo_awal = $2, bank_info = $3 WHERE id = $4 RETURNING id, name, saldo_awal, bank_info',
      [name, saldo_awal, bank_info, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Buku tidak ditemukan.' });
    const b = rows[0];
    await audit({ userId: req.user.id, username: req.user.username, action: 'update', entity: 'book', entityId: id, detail: name });
    res.json({ book: { id: b.id, name: b.name, saldo_awal: num(b.saldo_awal), bank_info: b.bank_info || '' } });
  } catch (e) {
    next(e);
  }
});

router.delete('/books/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const bk = await query('SELECT name FROM books WHERE id = $1', [id]);
    if (!bk.rows.length) return res.status(404).json({ error: 'Buku tidak ditemukan.' });
    // Atomik: hapus transaksi + rekening dalam satu transaksi DB. Bila gagal di tengah,
    // ROLLBACK memulihkan keduanya (mencegah transaksi hilang sementara rekening tetap ada).
    await withTransaction(async (q) => {
      await q('DELETE FROM transactions WHERE book_id = $1', [id]);
      await q('DELETE FROM books WHERE id = $1', [id]);
      await audit({ userId: req.user.id, username: req.user.username, action: 'delete', entity: 'book', entityId: id, detail: bk.rows[0].name }, q);
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------- TRANSAKSI ----------

// Daftar transaksi sebuah buku, opsional filter bulan (?month=YYYY-MM).
router.get('/books/:id/transactions', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await bookExists(id))) return res.status(404).json({ error: 'Buku tidak ditemukan.' });

    // Catatan: kolom "bukti" (blob) TIDAK diambil di daftar agar respons tetap ringan;
    // hanya penanda has_bukti. Blob diambil terpisah lewat /transactions/:id/bukti.
    let sql = `SELECT id, type, tanggal, jumlah, keterangan, kategori, (bukti IS NOT NULL) AS has_bukti
                 FROM transactions WHERE book_id = $1 AND deleted_at IS NULL`;
    const params = [id];

    if (req.query.month) {
      const range = monthRange(String(req.query.month));
      if (!range) return res.status(400).json({ error: 'Format bulan harus YYYY-MM.' });
      params.push(range.start, range.end);
      sql += ` AND tanggal >= $2 AND tanggal < $3`;
    }
    sql += ' ORDER BY tanggal ASC, id ASC';

    const { rows } = await query(sql, params);
    const transactions = rows.map((r) => ({
      id: r.id,
      type: r.type,
      tanggal: r.tanggal,
      jumlah: num(r.jumlah),
      keterangan: r.keterangan,
      kategori: r.kategori,
      has_bukti: !!r.has_bukti,
    }));
    res.json({ transactions });
  } catch (e) {
    next(e);
  }
});

// Semua transaksi lintas rekening (untuk Analitik gabungan). Tanpa blob bukti.
router.get('/all-transactions', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, book_id, type, tanggal, jumlah, keterangan, kategori, (bukti IS NOT NULL) AS has_bukti
         FROM transactions WHERE deleted_at IS NULL ORDER BY tanggal ASC, id ASC`
    );
    const transactions = rows.map((r) => ({
      id: r.id,
      book_id: r.book_id,
      type: r.type,
      tanggal: r.tanggal,
      jumlah: num(r.jumlah),
      keterangan: r.keterangan,
      kategori: r.kategori,
      has_bukti: !!r.has_bukti,
    }));
    res.json({ transactions });
  } catch (e) {
    next(e);
  }
});

// Ringkasan sepanjang waktu (dipakai untuk kartu Sisa Anggaran).
router.get('/books/:id/summary', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await bookExists(id))) return res.status(404).json({ error: 'Buku tidak ditemukan.' });
    const { rows } = await query(
      `SELECT COALESCE(SUM(CASE WHEN type = 'masuk'  THEN jumlah END), 0) AS masuk,
              COALESCE(SUM(CASE WHEN type = 'keluar' THEN jumlah END), 0) AS keluar
         FROM transactions WHERE book_id = $1 AND deleted_at IS NULL`,
      [id]
    );
    const bk = await query('SELECT saldo_awal FROM books WHERE id = $1', [id]);
    const saldoAwal = num(bk.rows[0] ? bk.rows[0].saldo_awal : 0);
    const masuk = num(rows[0].masuk);
    const keluar = num(rows[0].keluar);
    res.json({ saldo_awal: saldoAwal, masuk, keluar, sisa: saldoAwal + masuk - keluar });
  } catch (e) {
    next(e);
  }
});

function readTxBody(body) {
  const type = body.type === 'masuk' || body.type === 'keluar' ? body.type : null;
  const tanggal = String(body.tanggal || '');
  const jumlah = parseAmount(body.jumlah);
  const keterangan = String(body.keterangan || '').trim().slice(0, 500);
  const kategori = String(body.kategori || '').trim().slice(0, 100);
  return { type, tanggal, jumlah, keterangan, kategori };
}

const BUKTI_MAX = 4_000_000; // ~3MB biner setelah base64
// Validasi bukti: null/'' -> hapus; data URL gambar/pdf -> simpan.
// Regex DIANCHOR di kedua ujung (^...$) dan payload wajib base64 murni, sehingga muatan
// aneh (mis. yang mencoba menyisipkan markup) ditolak, bukan disimpan verbatim.
function normBukti(v) {
  if (v === null || v === '' || v === undefined) return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false };
  if (!/^data:(image\/(png|jpe?g|webp|gif)|application\/pdf);base64,[A-Za-z0-9+/]+={0,2}$/.test(v))
    return { ok: false };
  if (v.length > BUKTI_MAX) return { ok: false, tooBig: true };
  return { ok: true, value: v };
}

router.post('/books/:id/transactions', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await bookExists(id))) return res.status(404).json({ error: 'Buku tidak ditemukan.' });

    const { type, tanggal, jumlah, keterangan, kategori } = readTxBody(req.body);
    if (!type) return res.status(400).json({ error: 'Jenis harus "masuk" atau "keluar".' });
    if (!validDate(tanggal)) return res.status(400).json({ error: 'Tanggal tidak valid.' });
    if (jumlah === null) return res.status(400).json({ error: 'Jumlah tidak valid.' });
    const nb = normBukti(req.body.bukti);
    if (!nb.ok) return res.status(400).json({ error: nb.tooBig ? 'Ukuran bukti terlalu besar (maks ~3MB).' : 'Format bukti tidak didukung (gambar/PDF).' });

    const { rows } = await query(
      `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, bukti, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, type, tanggal, jumlah, keterangan, kategori, (bukti IS NOT NULL) AS has_bukti`,
      [id, type, tanggal, jumlah, keterangan, kategori, nb.value, req.session.userId]
    );
    const t = rows[0];
    await audit({ userId: req.user.id, username: req.user.username, action: 'create', entity: 'transaction', entityId: t.id, detail: `${type} ${num(t.jumlah)} @book:${id}` });
    res.status(201).json({ transaction: { ...t, jumlah: num(t.jumlah), has_bukti: !!t.has_bukti } });
  } catch (e) {
    next(e);
  }
});

// Transfer antar rekening: buat pasangan transaksi (keluar di asal, masuk di tujuan) secara atomik.
router.post('/transfer', requireAdmin, async (req, res, next) => {
  try {
    const fromId = Number(req.body.from_book);
    const toId = Number(req.body.to_book);
    const tanggal = String(req.body.tanggal || '');
    const jumlah = parseAmount(req.body.jumlah);
    const catatan = String(req.body.keterangan || '').trim().slice(0, 300);
    if (!Number.isInteger(fromId) || !Number.isInteger(toId) || fromId === toId)
      return res.status(400).json({ error: 'Pilih dua rekening berbeda.' });
    if (!validDate(tanggal)) return res.status(400).json({ error: 'Tanggal tidak valid.' });
    if (jumlah === null || jumlah <= 0) return res.status(400).json({ error: 'Jumlah tidak valid.' });

    const bk = await query('SELECT id, name FROM books WHERE id IN ($1, $2)', [fromId, toId]);
    if (bk.rows.length !== 2) return res.status(404).json({ error: 'Rekening tidak ditemukan.' });
    const nameOf = (id) => (bk.rows.find((r) => r.id === id) || {}).name || '';

    await withTransaction(async (q) => {
      const ketOut = `Transfer ke ${nameOf(toId)}${catatan ? ' — ' + catatan : ''}`.slice(0, 500);
      const ketIn = `Transfer dari ${nameOf(fromId)}${catatan ? ' — ' + catatan : ''}`.slice(0, 500);
      await q(
        `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, created_by)
         VALUES ($1,'keluar',$2,$3,$4,'Transfer',$5)`,
        [fromId, tanggal, jumlah, ketOut, req.session.userId]
      );
      await q(
        `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, created_by)
         VALUES ($1,'masuk',$2,$3,$4,'Transfer',$5)`,
        [toId, tanggal, jumlah, ketIn, req.session.userId]
      );
      await audit({ userId: req.user.id, username: req.user.username, action: 'transfer', entity: 'transaction', detail: `${jumlah} ${nameOf(fromId)}->${nameOf(toId)}` }, q);
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Import massal (mis. dari file CSV spreadsheet lama).
router.post('/books/:id/transactions/bulk', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await bookExists(id))) return res.status(404).json({ error: 'Buku tidak ditemukan.' });

    const items = Array.isArray(req.body.transactions) ? req.body.transactions : null;
    if (!items) return res.status(400).json({ error: 'Data transaksi tidak valid.' });
    if (items.length === 0) return res.status(400).json({ error: 'Tidak ada baris untuk diimpor.' });
    if (items.length > 5000) return res.status(400).json({ error: 'Maksimal 5000 baris per impor.' });

    // Atomik: semua baris valid masuk sebagai satu transaksi DB. Bila proses gagal di
    // tengah, ROLLBACK membatalkan seluruhnya — sehingga impor ulang tidak menghasilkan
    // separuh data + duplikat. Baris tak valid dilewati (dilaporkan), bukan menggagalkan impor.
    const errors = [];
    const inserted = await withTransaction(async (q) => {
      let ok = 0;
      for (let i = 0; i < items.length; i++) {
        const { type, tanggal, jumlah, keterangan, kategori } = readTxBody(items[i]);
        if (!type || !validDate(tanggal) || jumlah === null) {
          errors.push({ baris: i + 1, alasan: 'jenis/tanggal/jumlah tidak valid' });
          continue;
        }
        await q(
          `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, type, tanggal, jumlah, keterangan, kategori, req.session.userId]
        );
        ok++;
      }
      if (ok > 0) await audit({ userId: req.user.id, username: req.user.username, action: 'import', entity: 'transaction', entityId: id, detail: `${ok} baris @book:${id}` }, q);
      return ok;
    });
    res.status(201).json({ inserted, gagal: errors.length, errors: errors.slice(0, 20) });
  } catch (e) {
    next(e);
  }
});

router.patch('/transactions/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { type, tanggal, jumlah, keterangan, kategori } = readTxBody(req.body);
    if (!type) return res.status(400).json({ error: 'Jenis harus "masuk" atau "keluar".' });
    if (!validDate(tanggal)) return res.status(400).json({ error: 'Tanggal tidak valid.' });
    if (jumlah === null) return res.status(400).json({ error: 'Jumlah tidak valid.' });

    const sets = ['type=$1', 'tanggal=$2', 'jumlah=$3', 'keterangan=$4', 'kategori=$5'];
    const params = [type, tanggal, jumlah, keterangan, kategori];
    // "bukti" hanya diubah bila field ini disertakan (biar edit biasa tak menimpa bukti lama).
    if (Object.prototype.hasOwnProperty.call(req.body, 'bukti')) {
      const nb = normBukti(req.body.bukti);
      if (!nb.ok) return res.status(400).json({ error: nb.tooBig ? 'Ukuran bukti terlalu besar (maks ~3MB).' : 'Format bukti tidak didukung (gambar/PDF).' });
      params.push(nb.value);
      sets.push('bukti=$' + params.length);
    }
    params.push(id);
    const { rows } = await query(
      `UPDATE transactions SET ${sets.join(', ')} WHERE id=$${params.length} AND deleted_at IS NULL
        RETURNING id, type, tanggal, jumlah, keterangan, kategori, (bukti IS NOT NULL) AS has_bukti`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    const t = rows[0];
    await audit({ userId: req.user.id, username: req.user.username, action: 'update', entity: 'transaction', entityId: id, detail: `${type} ${num(t.jumlah)}` });
    res.json({ transaction: { ...t, jumlah: num(t.jumlah), has_bukti: !!t.has_bukti } });
  } catch (e) {
    next(e);
  }
});

// Ambil isi bukti (blob) satu transaksi — dipanggil hanya saat dilihat.
router.get('/transactions/:id/bukti', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await query('SELECT bukti FROM transactions WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    if (!rows[0].bukti) return res.status(404).json({ error: 'Tidak ada bukti untuk transaksi ini.' });
    res.json({ bukti: rows[0].bukti });
  } catch (e) {
    next(e);
  }
});

// Hapus transaksi = SOFT-DELETE (set deleted_at). Data tetap ada untuk audit/pemulihan,
// tapi tak lagi muncul di daftar/analitik/laporan.
router.delete('/transactions/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await query(
      'UPDATE transactions SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id, type, jumlah',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    await audit({ userId: req.user.id, username: req.user.username, action: 'delete', entity: 'transaction', entityId: id, detail: `${rows[0].type} ${num(rows[0].jumlah)}` });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
