'use strict';

const express = require('express');
const { query } = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth); // semua route di bawah ini butuh login

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
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
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

// ---------- BUKU KAS ----------

router.get('/books', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT b.id, b.name, b.saldo_awal, b.bank_info,
              COALESCE(SUM(CASE WHEN t.type = 'masuk'  THEN t.jumlah END), 0) AS masuk,
              COALESCE(SUM(CASE WHEN t.type = 'keluar' THEN t.jumlah END), 0) AS keluar
         FROM books b
         LEFT JOIN transactions t ON t.book_id = b.id
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

router.post('/books', async (req, res, next) => {
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
    res.status(201).json({
      book: { id: b.id, name: b.name, saldo_awal: num(b.saldo_awal), bank_info: b.bank_info || '', masuk: 0, keluar: 0, sisa: num(b.saldo_awal) },
    });
  } catch (e) {
    next(e);
  }
});

router.patch('/books/:id', async (req, res, next) => {
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
    res.json({ book: { id: b.id, name: b.name, saldo_awal: num(b.saldo_awal), bank_info: b.bank_info || '' } });
  } catch (e) {
    next(e);
  }
});

router.delete('/books/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await bookExists(id))) return res.status(404).json({ error: 'Buku tidak ditemukan.' });
    await query('DELETE FROM transactions WHERE book_id = $1', [id]);
    await query('DELETE FROM books WHERE id = $1', [id]);
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

    let sql = `SELECT id, type, tanggal, jumlah, keterangan, kategori
                 FROM transactions WHERE book_id = $1`;
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
         FROM transactions WHERE book_id = $1`,
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

router.post('/books/:id/transactions', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await bookExists(id))) return res.status(404).json({ error: 'Buku tidak ditemukan.' });

    const { type, tanggal, jumlah, keterangan, kategori } = readTxBody(req.body);
    if (!type) return res.status(400).json({ error: 'Jenis harus "masuk" atau "keluar".' });
    if (!validDate(tanggal)) return res.status(400).json({ error: 'Tanggal tidak valid.' });
    if (jumlah === null) return res.status(400).json({ error: 'Jumlah tidak valid.' });

    const { rows } = await query(
      `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, type, tanggal, jumlah, keterangan, kategori`,
      [id, type, tanggal, jumlah, keterangan, kategori, req.session.userId]
    );
    const t = rows[0];
    res.status(201).json({ transaction: { ...t, jumlah: num(t.jumlah) } });
  } catch (e) {
    next(e);
  }
});

// Import massal (mis. dari file CSV spreadsheet lama).
router.post('/books/:id/transactions/bulk', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await bookExists(id))) return res.status(404).json({ error: 'Buku tidak ditemukan.' });

    const items = Array.isArray(req.body.transactions) ? req.body.transactions : null;
    if (!items) return res.status(400).json({ error: 'Data transaksi tidak valid.' });
    if (items.length === 0) return res.status(400).json({ error: 'Tidak ada baris untuk diimpor.' });
    if (items.length > 5000) return res.status(400).json({ error: 'Maksimal 5000 baris per impor.' });

    let inserted = 0;
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      const { type, tanggal, jumlah, keterangan, kategori } = readTxBody(items[i]);
      if (!type || !validDate(tanggal) || jumlah === null) {
        errors.push({ baris: i + 1, alasan: 'jenis/tanggal/jumlah tidak valid' });
        continue;
      }
      await query(
        `INSERT INTO transactions (book_id, type, tanggal, jumlah, keterangan, kategori, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, type, tanggal, jumlah, keterangan, kategori, req.session.userId]
      );
      inserted++;
    }
    res.status(201).json({ inserted, gagal: errors.length, errors: errors.slice(0, 20) });
  } catch (e) {
    next(e);
  }
});

router.patch('/transactions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { type, tanggal, jumlah, keterangan, kategori } = readTxBody(req.body);
    if (!type) return res.status(400).json({ error: 'Jenis harus "masuk" atau "keluar".' });
    if (!validDate(tanggal)) return res.status(400).json({ error: 'Tanggal tidak valid.' });
    if (jumlah === null) return res.status(400).json({ error: 'Jumlah tidak valid.' });

    const { rows } = await query(
      `UPDATE transactions SET type=$1, tanggal=$2, jumlah=$3, keterangan=$4, kategori=$5
        WHERE id=$6
        RETURNING id, type, tanggal, jumlah, keterangan, kategori`,
      [type, tanggal, jumlah, keterangan, kategori, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    const t = rows[0];
    res.json({ transaction: { ...t, jumlah: num(t.jumlah) } });
  } catch (e) {
    next(e);
  }
});

router.delete('/transactions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await query('DELETE FROM transactions WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
