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
  const n = Math.round(Number(String(v).replace(/[^\d-]/g, '')));
  if (!Number.isFinite(n) || n < 0 || n > 1e15) return null;
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
      `SELECT b.id, b.name,
              COALESCE(SUM(CASE WHEN t.type = 'masuk'  THEN t.jumlah END), 0) AS masuk,
              COALESCE(SUM(CASE WHEN t.type = 'keluar' THEN t.jumlah END), 0) AS keluar
         FROM books b
         LEFT JOIN transactions t ON t.book_id = b.id
        GROUP BY b.id, b.name
        ORDER BY b.id`
    );
    const books = rows.map((r) => ({
      id: r.id,
      name: r.name,
      masuk: num(r.masuk),
      keluar: num(r.keluar),
      sisa: num(r.masuk) - num(r.keluar),
    }));
    res.json({ books });
  } catch (e) {
    next(e);
  }
});

router.post('/books', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (name.length < 1 || name.length > 100)
      return res.status(400).json({ error: 'Nama buku 1-100 karakter.' });
    const { rows } = await query(
      'INSERT INTO books (name, created_by) VALUES ($1, $2) RETURNING id, name',
      [name, req.session.userId]
    );
    res.status(201).json({ book: { ...rows[0], masuk: 0, keluar: 0, sisa: 0 } });
  } catch (e) {
    next(e);
  }
});

router.patch('/books/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    if (name.length < 1 || name.length > 100)
      return res.status(400).json({ error: 'Nama buku 1-100 karakter.' });
    const { rows } = await query(
      'UPDATE books SET name = $1 WHERE id = $2 RETURNING id, name',
      [name, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Buku tidak ditemukan.' });
    res.json({ book: rows[0] });
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
    const masuk = num(rows[0].masuk);
    const keluar = num(rows[0].keluar);
    res.json({ masuk, keluar, sisa: masuk - keluar });
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
