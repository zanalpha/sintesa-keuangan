// Formatter & util murni (tanpa DOM/state). Dipakai lintas modul.

export const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
export const BULAN_S = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

export const rupiah = (n) => 'Rp' + new Intl.NumberFormat('id-ID').format(Math.round(n || 0));

export function tanggalIndo(iso) {
  const [y, m, d] = iso.split('-');
  return `${d} ${BULAN_S[Number(m) - 1]} ${y}`;
}
export function labelBulan(ym) { const [y, m] = ym.split('-'); return `${BULAN[Number(m) - 1]} ${y}`; }
export function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
export function pad2(n) { return String(n).padStart(2, '0'); }

/** Apakah string berbentuk YYYY-MM. */
export function isYearMonth(ym) { return /^\d{4}-\d{2}$/.test(ym); }

/** Geser bulan YYYY-MM sebanyak `delta` bulan (boleh negatif). */
export function shiftMonth(ym, delta) {
  if (!isYearMonth(ym)) return '';
  let [y, m] = ym.split('-').map(Number);
  m += Number(delta) || 0;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return `${y}-${pad2(m)}`;
}

/** Daftar bulan dari `fromYm` sampai `toYm` inklusif (naik). */
export function monthsBetween(fromYm, toYm) {
  if (!isYearMonth(fromYm) || !isYearMonth(toYm) || fromYm > toYm) return [];
  const out = [];
  for (let cur = fromYm; cur <= toYm; cur = shiftMonth(cur, 1)) out.push(cur);
  return out;
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

export function csvCell(v) {
  let s = String(v == null ? '' : v);
  // Cegah injeksi formula (CSV injection): sel yang diawali = + - @ atau tab/CR bisa
  // dieksekusi sebagai rumus saat file dibuka di Excel/Sheets. Beri prefiks kutip tunggal
  // agar diperlakukan sebagai teks biasa.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: (mime || 'text/csv') + ';charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
