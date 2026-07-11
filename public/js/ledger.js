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
