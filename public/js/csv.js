// Parsing CSV & normalisasi tanggal untuk fitur Impor. Murni (tanpa DOM/state).
import { pad2 } from './format.js';

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function monthNum(name) {
  const map = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, aug: 8, agt: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };
  return map[name.slice(0, 3).toLowerCase()] || 0;
}

export function normDate(s) {
  s = String(s).trim();
  let m;
  // ISO dengan pemisah "-" atau "/", boleh tanpa nol di depan: 2026-07-11, 2026/7/1.
  if ((m = s.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/))) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  if ((m = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/))) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  if ((m = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})$/))) return `20${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  if ((m = s.match(/^(\d{1,2})[\-\s]([A-Za-z]{3,})[\-\s](\d{2,4})$/))) {
    const mo = monthNum(m[2]); if (!mo) return '';
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${pad2(mo)}-${pad2(m[1])}`;
  }
  return '';
}

export function rowsToTransactions(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const hasHeader = header.some((h) => ['jenis', 'tanggal', 'jumlah', 'keterangan', 'kategori', 'type', 'date', 'amount'].includes(h));
  let idx = { jenis: 0, tanggal: 1, jumlah: 2, keterangan: 3, kategori: 4 };
  let data = rows;
  if (hasHeader) {
    const find = (...names) => header.findIndex((h) => names.includes(h));
    idx = {
      jenis: find('jenis', 'type'),
      tanggal: find('tanggal', 'date'),
      jumlah: find('jumlah', 'amount', 'nominal'),
      keterangan: find('keterangan', 'deskripsi', 'uraian', 'description'),
      kategori: find('kategori', 'category'),
    };
    data = rows.slice(1);
  }
  const out = [];
  for (const r of data) {
    const get = (k) => (idx[k] >= 0 && idx[k] < r.length ? String(r[idx[k]]).trim() : '');
    const jenis = get('jenis').toLowerCase();
    let type = null;
    if (/masuk|pemasukan|\bin\b/.test(jenis)) type = 'masuk';
    else if (/keluar|pengeluaran|biaya|\bout\b/.test(jenis)) type = 'keluar';
    const tanggal = normDate(get('tanggal'));
    // Buang dulu gugus sen di akhir (mis. ",00" / ".00") SEBELUM menghapus pemisah ribuan,
    // agar "1.500.000,00" -> 1500000 (bukan 150000000 alias 100x lipat). "1.500.000" tetap utuh.
    const jumlah = get('jumlah').trim().replace(/[.,]\d{1,2}$/, '').replace(/[^\d]/g, '');
    if (!type || !tanggal || !jumlah) continue;
    out.push({ type, tanggal, jumlah, keterangan: get('keterangan'), kategori: get('kategori') });
  }
  return out;
}
