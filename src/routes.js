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
  // Terima HANYA bilangan bulat non-negatif (rupiah, tanpa sen). Penting: TOLAK nilai pecahan
  // alih-alih diam-diam menggabung digitnya — mis. "1.5" JANGAN menjadi 15, dan "1500000,75"
  // JANGAN menjadi 150000075 (100x lipat). Pemisah ribuan (1.500.000 / 1,500,000) tetap diterima.
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 0 && v <= 1e15 ? v : null;
  }
  const s = String(v == null ? '' : v).trim();
  if (s === '' || s.includes('-')) return null; // kosong atau negatif -> tolak
  if (/[.,]\d{1,2}$/.test(s)) return null; // ada bagian desimal (titik/koma + 1-2 digit di akhir)
  const digits = s.replace(/\D/g, ''); // buang pemisah ribuan / simbol mata uang
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isInteger(n) && n <= 1e15 ? n : null;
}

const DANA_NAME = {
  operasional: 'Anggaran Operasional',
  saving: 'Saving',
  gabungan: 'Anggaran Gabungan',
};

const DANA_ALIAS = {
  operasional: 'operasional',
  'anggaran operasional': 'operasional',
  'pemasukan anggaran operasional': 'operasional',
  'pengeluaran anggaran operasional': 'operasional',
  saving: 'saving',
  tabungan: 'saving',
  'pemasukan saving': 'saving',
  'pengeluaran saving': 'saving',
  gabungan: 'gabungan',
  'anggaran gabungan': 'gabungan',
  'pemasukan anggaran gabungan': 'gabungan',
  'pengeluaran anggaran gabungan': 'gabungan',
};

/** Kode kategori dana, atau '' bila tidak dikenali. */
function normDana(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return DANA_ALIAS[s] || '';
}

/**
 * required: form tambah/ubah — kosong atau tidak dikenal ditolak.
 * fallback: impor/pulihkan/transfer lama tanpa kolom — kosong menjadi operasional.
 */
function resolveDana(body, { required, fallback } = {}) {
  const raw = body && body.dana;
  const missing = raw == null || String(raw).trim() === '';
  if (missing) {
    if (required) return { ok: false, error: 'Kategori dana wajib dipilih.' };
    return { ok: true, value: fallback || 'operasional' };
  }
  const value = normDana(raw);
  if (!value) return { ok: false, error: 'Kategori dana tidak valid.' };
  return { ok: true, value };
}

function txOut(r) {
  const out = {
    id: r.id,
    type: r.type,
    tanggal: r.tanggal,
    jumlah: num(r.jumlah),
    keterangan: r.keterangan,
    kategori: r.kategori,
    dana: r.dana || 'operasional',
    has_bukti: !!r.has_bukti,
  };
  if (r.book_id != null) out.book_id = r.book_id;
  return out;
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
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12 || y < 2000 || y > 2100) return null;
  const start = `${month}-01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const end = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
  return { start, end };
}

async function bookExists(id) {
  const { rows } = await query('SELECT id FROM books WHERE id = $1 AND deleted_at IS NULL', [id]);
  return rows.length > 0;
}

// ---------- BACKUP ----------
// Unduh seluruh data (semua buku + transaksi + bukti) sebagai JSON v2.
// DI-STREAM per-batch agar tak menahan SEMUA blob bukti di memori sekaligus (cegah OOM).
router.get('/backup', requireAdmin, async (req, res, next) => {
  try {
    res.type('application/json');
    const books = (await query('SELECT id, name, saldo_awal, bank_info, ambang_saldo, created_at FROM books WHERE deleted_at IS NULL ORDER BY id')).rows
      .map((b) => ({ ...b, saldo_awal: num(b.saldo_awal), ambang_saldo: num(b.ambang_saldo) }));
    res.write('{"app":"sintesa-keuangan","version":2,"books":' + JSON.stringify(books) + ',"transactions":[');
    const BATCH = 200;
    // Keyset pagination (WHERE id > lastId), BUKAN OFFSET: kebal terhadap penghapusan baris
    // yang belum terbaca saat backup berjalan — OFFSET akan menggeser & MELEWATI baris diam-diam.
    let lastId = 0, first = true;
    for (;;) {
      const { rows } = await query(
        `SELECT id, book_id, type, tanggal, jumlah, keterangan, kategori, dana, bukti, created_at
           FROM transactions WHERE deleted_at IS NULL AND id > $2 ORDER BY id LIMIT $1`,
        [BATCH, lastId]
      );
      if (rows.length === 0) break;
      for (const t of rows) {
        res.write((first ? '' : ',') + JSON.stringify({ ...t, jumlah: num(t.jumlah), dana: t.dana || 'operasional' }));
        first = false;
      }
      lastId = rows[rows.length - 1].id;
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
        const ambang = parseAmount(b.ambang_saldo) ?? 0;
        const r = await q(
          'INSERT INTO books (name, saldo_awal, bank_info, ambang_saldo, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [name, saldo, bank, ambang, req.session.userId]
        );
        idMap.set(b.id, r.rows[0].id);
        nb++;
      }
      let skipped = 0, buktiDropped = 0; // jangan buang data diam-diam — hitung & laporkan
      for (const t of txs) {
        const bookId = idMap.get(t.book_id);
        if (!bookId) { skipped++; continue; } // transaksi tanpa buku terpetakan
        const { type, tanggal, jumlah, keterangan, kategori } = readTxBody(t);
        if (!type || !validDate(tanggal) || jumlah === null) { skipped++; continue; } // data tak valid
        const danaRes = resolveDana(t, { required: false, fallback: 'operasional' });
        if (!danaRes.ok) { skipped++; continue; }
        const nbk = normBukti(t.bukti);
        if (t.bukti && !nbk.ok) buktiDropped++; // bukti lama tak lolos validasi -> dibuang (dicatat)
        await q(
          `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, dana, bukti, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [bookId, type, tanggal, jumlah, keterangan, kategori, danaRes.value, nbk.ok ? nbk.value : null, req.session.userId]
        );
        nt++;
      }
      const extra = skipped || buktiDropped ? ` — ${skipped} transaksi dilewati, ${buktiDropped} bukti dibuang` : '';
      await audit({ userId: req.user.id, username: req.user.username, action: 'restore', entity: 'database', detail: `${nb} rekening, ${nt} transaksi (${mode})${extra}` }, q);
      return { books: nb, transactions: nt, mode, skipped, buktiDropped };
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
      `SELECT b.id, b.name, b.saldo_awal, b.bank_info, b.ambang_saldo,
              COALESCE(SUM(CASE WHEN t.type = 'masuk'  THEN t.jumlah END), 0) AS masuk,
              COALESCE(SUM(CASE WHEN t.type = 'keluar' THEN t.jumlah END), 0) AS keluar
         FROM books b
         LEFT JOIN transactions t ON t.book_id = b.id AND t.deleted_at IS NULL
        WHERE b.deleted_at IS NULL
        GROUP BY b.id, b.name, b.saldo_awal, b.bank_info, b.ambang_saldo
        ORDER BY b.id`
    );
    const books = rows.map((r) => ({
      id: r.id,
      name: r.name,
      saldo_awal: num(r.saldo_awal),
      bank_info: r.bank_info || '',
      ambang_saldo: num(r.ambang_saldo),
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
  const rawAmbang = body.ambang_saldo;
  const ambang_saldo =
    rawAmbang == null || String(rawAmbang).trim() === '' ? 0 : parseAmount(rawAmbang);
  const bank_info = String(body.bank_info || '').trim().slice(0, 200);
  return { name, saldo_awal, bank_info, ambang_saldo };
}

router.post('/books', requireAdmin, async (req, res, next) => {
  try {
    const { name, saldo_awal, bank_info, ambang_saldo } = readBookBody(req.body);
    if (name.length < 1 || name.length > 100)
      return res.status(400).json({ error: 'Nama buku 1-100 karakter.' });
    if (saldo_awal === null) return res.status(400).json({ error: 'Saldo awal tidak valid.' });
    if (ambang_saldo === null) return res.status(400).json({ error: 'Ambang saldo tidak valid.' });
    const { rows } = await query(
      'INSERT INTO books (name, saldo_awal, bank_info, ambang_saldo, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, saldo_awal, bank_info, ambang_saldo',
      [name, saldo_awal, bank_info, ambang_saldo, req.session.userId]
    );
    const b = rows[0];
    await audit({ userId: req.user.id, username: req.user.username, action: 'create', entity: 'book', entityId: b.id, detail: name });
    res.status(201).json({
      book: {
        id: b.id, name: b.name, saldo_awal: num(b.saldo_awal), bank_info: b.bank_info || '',
        ambang_saldo: num(b.ambang_saldo), masuk: 0, keluar: 0, sisa: num(b.saldo_awal),
      },
    });
  } catch (e) {
    next(e);
  }
});

router.patch('/books/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, saldo_awal, bank_info, ambang_saldo } = readBookBody(req.body);
    if (name.length < 1 || name.length > 100)
      return res.status(400).json({ error: 'Nama buku 1-100 karakter.' });
    if (saldo_awal === null) return res.status(400).json({ error: 'Saldo awal tidak valid.' });
    if (ambang_saldo === null) return res.status(400).json({ error: 'Ambang saldo tidak valid.' });
    const { rows } = await query(
      'UPDATE books SET name = $1, saldo_awal = $2, bank_info = $3, ambang_saldo = $4 WHERE id = $5 AND deleted_at IS NULL RETURNING id, name, saldo_awal, bank_info, ambang_saldo',
      [name, saldo_awal, bank_info, ambang_saldo, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Buku tidak ditemukan.' });
    const b = rows[0];
    await audit({ userId: req.user.id, username: req.user.username, action: 'update', entity: 'book', entityId: id, detail: name });
    res.json({
      book: {
        id: b.id, name: b.name, saldo_awal: num(b.saldo_awal), bank_info: b.bank_info || '',
        ambang_saldo: num(b.ambang_saldo),
      },
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/books/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const bk = await query('SELECT name FROM books WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!bk.rows.length) return res.status(404).json({ error: 'Buku tidak ditemukan.' });
    // SOFT-DELETE (konsisten dengan penghapusan transaksi): tandai rekening + semua transaksinya
    // sebagai terhapus alih-alih menghancurkannya. Data & bukti tetap tersimpan (bisa dipulihkan),
    // tak lagi muncul di daftar/laporan. Atomik: ROLLBACK bila gagal di tengah.
    const archived = await withTransaction(async (q) => {
      const tx = await q('UPDATE transactions SET deleted_at = now() WHERE book_id = $1 AND deleted_at IS NULL', [id]);
      await q('UPDATE books SET deleted_at = now() WHERE id = $1', [id]);
      const n = tx.rowCount || 0;
      await audit({ userId: req.user.id, username: req.user.username, action: 'delete', entity: 'book', entityId: id, detail: `${bk.rows[0].name} (+${n} transaksi diarsipkan)` }, q);
      return n;
    });
    res.json({ ok: true, archivedTransactions: archived });
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
    let sql = `SELECT id, type, tanggal, jumlah, keterangan, kategori, dana, (bukti IS NOT NULL) AS has_bukti
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
    res.json({ transactions: rows.map(txOut) });
  } catch (e) {
    next(e);
  }
});

// Semua transaksi lintas rekening (untuk Analitik gabungan). Tanpa blob bukti.
router.get('/all-transactions', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, book_id, type, tanggal, jumlah, keterangan, kategori, dana, (bukti IS NOT NULL) AS has_bukti
         FROM transactions WHERE deleted_at IS NULL ORDER BY tanggal ASC, id ASC`
    );
    res.json({ transactions: rows.map(txOut) });
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
    const bk = await query('SELECT saldo_awal FROM books WHERE id = $1 AND deleted_at IS NULL', [id]);
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
    const danaRes = resolveDana(req.body, { required: true });
    if (!danaRes.ok) return res.status(400).json({ error: danaRes.error });
    const nb = normBukti(req.body.bukti);
    if (!nb.ok) return res.status(400).json({ error: nb.tooBig ? 'Ukuran bukti terlalu besar (maks ~3MB).' : 'Format bukti tidak didukung (gambar/PDF).' });

    const { rows } = await query(
      `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, dana, bukti, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, type, tanggal, jumlah, keterangan, kategori, dana, (bukti IS NOT NULL) AS has_bukti`,
      [id, type, tanggal, jumlah, keterangan, kategori, danaRes.value, nb.value, req.session.userId]
    );
    const t = rows[0];
    await audit({ userId: req.user.id, username: req.user.username, action: 'create', entity: 'transaction', entityId: t.id, detail: `${type} ${num(t.jumlah)} dana:${danaRes.value} @book:${id}` });
    res.status(201).json({ transaction: txOut(t) });
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
    const danaRes = resolveDana(req.body, { required: false, fallback: 'operasional' });
    if (!danaRes.ok) return res.status(400).json({ error: danaRes.error });

    const bk = await query('SELECT id, name FROM books WHERE id IN ($1, $2) AND deleted_at IS NULL', [fromId, toId]);
    if (bk.rows.length !== 2) return res.status(404).json({ error: 'Rekening tidak ditemukan.' });
    const nameOf = (id) => (bk.rows.find((r) => r.id === id) || {}).name || '';

    await withTransaction(async (q) => {
      const ketOut = `Transfer ke ${nameOf(toId)}${catatan ? ' — ' + catatan : ''}`.slice(0, 500);
      const ketIn = `Transfer dari ${nameOf(fromId)}${catatan ? ' — ' + catatan : ''}`.slice(0, 500);
      await q(
        `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, dana, created_by)
         VALUES ($1,'keluar',$2,$3,$4,'Transfer',$5,$6)`,
        [fromId, tanggal, jumlah, ketOut, danaRes.value, req.session.userId]
      );
      await q(
        `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, dana, created_by)
         VALUES ($1,'masuk',$2,$3,$4,'Transfer',$5,$6)`,
        [toId, tanggal, jumlah, ketIn, danaRes.value, req.session.userId]
      );
      await audit({ userId: req.user.id, username: req.user.username, action: 'transfer', entity: 'transaction', detail: `${jumlah} ${nameOf(fromId)}->${nameOf(toId)} dana:${danaRes.value}` }, q);
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Pindah antar kategori dana pada rekening yang sama.
// Sepasang transaksi (keluar di asal, masuk di tujuan) saling menghapus di saldo rekening,
// tetapi saldo kategori berubah. Total seluruh dana tetap.
router.post('/pindah-dana', requireAdmin, async (req, res, next) => {
  try {
    const bookId = Number(req.body.book_id);
    const tanggal = String(req.body.tanggal || '');
    const jumlah = parseAmount(req.body.jumlah);
    const catatan = String(req.body.keterangan || '').trim().slice(0, 300);
    const fromDana = normDana(req.body.from_dana);
    const toDana = normDana(req.body.to_dana);
    if (!Number.isInteger(bookId) || !(await bookExists(bookId)))
      return res.status(404).json({ error: 'Rekening tidak ditemukan.' });
    if (!fromDana || !toDana) return res.status(400).json({ error: 'Kategori dana tidak valid.' });
    if (fromDana === toDana) return res.status(400).json({ error: 'Pilih dua anggaran yang berbeda.' });
    if (!validDate(tanggal)) return res.status(400).json({ error: 'Tanggal tidak valid.' });
    if (jumlah === null || jumlah <= 0) return res.status(400).json({ error: 'Jumlah tidak valid.' });

    const fromName = DANA_NAME[fromDana];
    const toName = DANA_NAME[toDana];
    await withTransaction(async (q) => {
      const ketOut = `Pindah ke ${toName}${catatan ? ' — ' + catatan : ''}`.slice(0, 500);
      const ketIn = `Pindah dari ${fromName}${catatan ? ' — ' + catatan : ''}`.slice(0, 500);
      await q(
        `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, dana, created_by)
         VALUES ($1,'keluar',$2,$3,$4,'Pindah Anggaran',$5,$6)`,
        [bookId, tanggal, jumlah, ketOut, fromDana, req.session.userId]
      );
      await q(
        `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, dana, created_by)
         VALUES ($1,'masuk',$2,$3,$4,'Pindah Anggaran',$5,$6)`,
        [bookId, tanggal, jumlah, ketIn, toDana, req.session.userId]
      );
      await audit({
        userId: req.user.id,
        username: req.user.username,
        action: 'pindah',
        entity: 'transaction',
        detail: `${jumlah} ${fromDana}->${toDana} @book:${bookId}`,
      }, q);
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
        const danaRes = resolveDana(items[i], { required: false, fallback: 'operasional' });
        if (!danaRes.ok) {
          errors.push({ baris: i + 1, alasan: danaRes.error });
          continue;
        }
        await q(
          `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, dana, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, type, tanggal, jumlah, keterangan, kategori, danaRes.value, req.session.userId]
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
    const danaRes = resolveDana(req.body, { required: true });
    if (!danaRes.ok) return res.status(400).json({ error: danaRes.error });

    const sets = ['type=$1', 'tanggal=$2', 'jumlah=$3', 'keterangan=$4', 'kategori=$5', 'dana=$6'];
    const params = [type, tanggal, jumlah, keterangan, kategori, danaRes.value];
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
        RETURNING id, type, tanggal, jumlah, keterangan, kategori, dana, (bukti IS NOT NULL) AS has_bukti`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    const t = rows[0];
    await audit({ userId: req.user.id, username: req.user.username, action: 'update', entity: 'transaction', entityId: id, detail: `${type} ${num(t.jumlah)} dana:${t.dana}` });
    res.json({ transaction: txOut(t) });
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

// ---------- RINGKASAN PER BULAN (admin) ----------
// Dipakai UI "Hapus bulan" agar admin melihat jumlah baris sebelum menghapus permanen.
/** Normalisasi nilai tanggal (DATE/string/Date) ke "YYYY-MM". */
function yearMonthOf(tanggal) {
  if (tanggal instanceof Date && !Number.isNaN(tanggal.getTime())) {
    const y = tanggal.getUTCFullYear();
    const m = String(tanggal.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }
  const s = String(tanggal == null ? '' : tanggal).slice(0, 10);
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : '';
}

router.get('/months', requireAdmin, async (req, res, next) => {
  try {
    // Agregasi di JS agar kompatibel pg-mem (tanpa to_char) dan volume transaksi tipikal kecil.
    const { rows } = await query(
      `SELECT tanggal, type, jumlah, deleted_at, bukti FROM transactions`
    );
    const map = new Map();
    for (const r of rows) {
      const month = yearMonthOf(r.tanggal);
      if (!month) continue;
      let bucket = map.get(month);
      if (!bucket) {
        bucket = {
          month,
          total: 0,
          aktif: 0,
          soft_deleted: 0,
          masuk_n: 0,
          masuk_sum: 0,
          keluar_n: 0,
          keluar_sum: 0,
        };
        map.set(month, bucket);
      }
      bucket.total += 1;
      const soft = r.deleted_at != null;
      if (soft) bucket.soft_deleted += 1;
      else {
        bucket.aktif += 1;
        const j = num(r.jumlah);
        if (r.type === 'masuk') {
          bucket.masuk_n += 1;
          bucket.masuk_sum += j;
        } else if (r.type === 'keluar') {
          bucket.keluar_n += 1;
          bucket.keluar_sum += j;
        }
      }
    }
    const months = [...map.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
    res.json({ months });
  } catch (e) {
    next(e);
  }
});

// Soft-delete UI TIDAK menghemat ruang (bukti/blob tetap). Hard-delete permanen semua
// transaksi (aktif + soft-deleted) dalam bulan YYYY-MM. VACUUM tidak di HTTP — pakai CLI.
async function hardDeleteMonth(month, user) {
  const range = monthRange(month);
  if (!range) {
    const err = new Error('Bulan tidak valid. Gunakan format YYYY-MM (contoh 2026-08).');
    err.status = 400;
    throw err;
  }
  return withTransaction(async (q) => {
    const { rows: list } = await q(
      `SELECT id, deleted_at, bukti FROM transactions WHERE tanggal >= $1 AND tanggal < $2`,
      [range.start, range.end]
    );
    const total = list.length;
    const soft_deleted = list.filter((r) => r.deleted_at != null).length;
    const with_bukti = list.filter((r) => r.bukti != null && r.bukti !== '').length;
    if (total === 0) {
      const err = new Error(`Tidak ada transaksi untuk bulan ${month}.`);
      err.status = 404;
      throw err;
    }
    const del = await q(
      `DELETE FROM transactions
        WHERE tanggal >= $1 AND tanggal < $2
        RETURNING id`,
      [range.start, range.end]
    );
    await audit(
      {
        userId: user.id,
        username: user.username,
        action: 'purge',
        entity: 'month',
        detail: `${month}: ${del.rowCount} transaksi dihapus permanen (${soft_deleted} soft-deleted, ${with_bukti} bukti)`,
      },
      q
    );
    return {
      month,
      deleted: del.rowCount,
      soft_deleted,
      with_bukti,
    };
  });
}

function requireMonthConfirm(month, confirm) {
  if (confirm !== month) {
    const err = new Error(
      `Konfirmasi tidak cocok. Ketik ulang "${month}" di kolom konfirmasi untuk menghapus permanen.`
    );
    err.status = 400;
    throw err;
  }
}

// ---------- HAPUS BULAN (HARD DELETE) ----------
router.post('/purge-month', requireAdmin, async (req, res, next) => {
  try {
    const month = String((req.body && req.body.month) || '').trim();
    const confirm = String((req.body && req.body.confirm) || '').trim();
    if (!monthRange(month)) {
      return res.status(400).json({ error: 'Bulan tidak valid. Gunakan format YYYY-MM (contoh 2026-08).' });
    }
    requireMonthConfirm(month, confirm);
    const result = await hardDeleteMonth(month, req.user);
    res.json({
      ok: true,
      ...result,
      note: 'Data dihapus permanen. Untuk reclaim disk Postgres, jalankan scripts/purge-month.js --vacuum setelahnya bila perlu.',
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Alternatif REST — path /month/:ym harus sebelum /transactions/:id agar tak bentrok.
router.delete('/transactions/month/:ym', requireAdmin, async (req, res, next) => {
  try {
    const month = String(req.params.ym || '').trim();
    const confirm = String((req.body && req.body.confirm) || '').trim();
    if (!monthRange(month)) {
      return res.status(400).json({ error: 'Bulan tidak valid. Gunakan format YYYY-MM (contoh 2026-08).' });
    }
    requireMonthConfirm(month, confirm);
    const result = await hardDeleteMonth(month, req.user);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
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
