// Perhitungan ledger/saldo berjalan. Murni (tanpa DOM/state) — dipakai Buku Besar & laporan cetak.

// Hitung ledger kronologis (saldo berjalan) untuk kumpulan transaksi & periode apa pun.
// Transaksi sebelum `from` dilipat ke dalam saldo pembuka agar saldo berjalan tetap kontinu.
export function computeLedger(scopeTx, saldoAwal, from, to) {
  const sorted = [...scopeTx].sort((a, b) =>
    a.tanggal < b.tanggal ? -1 : a.tanggal > b.tanggal ? 1 : a.id - b.id);
  let opening = saldoAwal;
  for (const t of sorted) if (from && t.tanggal < from) opening += t.type === 'masuk' ? t.jumlah : -t.jumlah;
  let running = opening, tMasuk = 0, tKeluar = 0;
  const rows = [];
  for (const t of sorted) {
    if (from && t.tanggal < from) continue;
    if (to && t.tanggal > to) continue;
    running += t.type === 'masuk' ? t.jumlah : -t.jumlah;
    if (t.type === 'masuk') tMasuk += t.jumlah; else tKeluar += t.jumlah;
    rows.push({ ...t, saldo: running });
  }
  return { opening, rows, tMasuk, tKeluar, saldoAkhir: running };
}

// Kategori dana. Satu transaksi = satu kategori. Anggaran Gabungan bukan jumlah kategori lain.
export const DANA = {
  operasional: {
    id: 'operasional',
    name: 'Anggaran Operasional',
    masuk: 'Pemasukan Anggaran Operasional',
    keluar: 'Pengeluaran Anggaran Operasional',
  },
  saving: {
    id: 'saving',
    name: 'Saving',
    masuk: 'Pemasukan Saving',
    keluar: 'Pengeluaran Saving',
  },
  gabungan: {
    id: 'gabungan',
    name: 'Anggaran Gabungan',
    masuk: 'Pemasukan Anggaran Gabungan',
    keluar: 'Pengeluaran Anggaran Gabungan',
  },
};

export const DANA_IDS = ['operasional', 'saving', 'gabungan'];

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

/** Kode kategori dana. Kosong (transaksi lama) dihitung sebagai Anggaran Operasional. */
export function fundKey(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return DANA_ALIAS[s] || 'operasional';
}

export function danaChoices(type) {
  const field = type === 'keluar' ? 'keluar' : 'masuk';
  return DANA_IDS.map((id) => ({ id, label: DANA[id][field] }));
}

/**
 * Saldo bersih tiap kategori dari satu daftar transaksi.
 * Pemasukan menambah, pengeluaran mengurangi. Setiap baris dihitung sekali.
 * Saldo awal rekening tidak masuk ke rumus ini.
 */
export function fundBalances(transactions) {
  const saldo = { operasional: 0, saving: 0, gabungan: 0 };
  for (const t of transactions || []) {
    const key = fundKey(t && t.dana);
    const jumlah = Number(t && t.jumlah) || 0;
    saldo[key] += t && t.type === 'keluar' ? -jumlah : jumlah;
  }
  const operasionalDanGabungan = saldo.operasional + saldo.gabungan;
  return {
    operasional: saldo.operasional,
    saving: saldo.saving,
    gabungan: saldo.gabungan,
    operasionalDanGabungan,
    total: operasionalDanGabungan + saldo.saving,
  };
}

/** Cakupan kartu utama: Operasional dan Gabungan, tanpa Saving. */
export function inOperasionalGabungan(tx) {
  const key = fundKey(tx && tx.dana);
  return key === 'operasional' || key === 'gabungan';
}
