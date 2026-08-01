'use strict';

/* ============================================================
   Sistem Pencatatan Keuangan — PT Sintesa Data Semesta
   Frontend tanpa bundler — ES modules native (script type="module").
   Modul murni: js/format.js (formatter), js/csv.js (impor), js/ledger.js (saldo berjalan).
   ============================================================ */
import { rupiah, BULAN_S, tanggalIndo, labelBulan, todayISO, escapeHtml, slug, csvCell, downloadBlob, isYearMonth, shiftMonth, monthsBetween } from './js/format.js';
import { parseCsv, rowsToTransactions } from './js/csv.js';
import { computeLedger } from './js/ledger.js';

// ---------- Util (DOM) ----------
const $ = (id) => document.getElementById(id);
function formatMoneyInput(e) {
  const el = e.target;
  // Hitung berapa digit ada SEBELUM kursor, agar posisi kursor bisa dipulihkan setelah
  // pemformatan ulang (jika tidak, kursor selalu melompat ke ujung saat mengedit di tengah).
  const caret = el.selectionEnd;
  const digitsBeforeCaret = caret == null ? null : el.value.slice(0, caret).replace(/\D/g, '').length;
  const d = el.value.replace(/\D/g, '');
  el.value = d ? new Intl.NumberFormat('id-ID').format(Number(d)) : '';
  if (digitsBeforeCaret == null) return;
  // Tempatkan kursor tepat setelah digit ke-N pada string terformat yang baru.
  let pos = 0, seen = 0;
  while (pos < el.value.length && seen < digitsBeforeCaret) {
    if (/\d/.test(el.value[pos])) seen++;
    pos++;
  }
  try { el.setSelectionRange(pos, pos); } catch (_) { /* abaikan bila tak didukung */ }
}
let toastTimer;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3400);
}

// ---------- API ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Kunci tombol submit sebuah form selama aksi async berjalan: cegah klik-ganda
// (mis. transfer/rekening ganda saat server lambat) + beri umpan balik "Menyimpan…".
async function withSubmitLock(form, busyText, fn) {
  const btn = form.querySelector('[type="submit"]');
  if (btn && btn.disabled) return; // aksi sebelumnya masih berjalan → abaikan klik ini
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = busyText; }
  try {
    await fn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.setAttribute('aria-busy', 'false');
      if (btn.textContent === busyText) btn.textContent = orig;
    }
  }
}

async function api(method, url, body, timeoutMs = 60000) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  // Batasi waktu tunggu agar permintaan tidak menggantung selamanya (mis. server cold-start
  // di Render). AbortController didukung semua browser modern.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  opts.signal = ctrl.signal;
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Server tidak merespons (mungkin sedang bangun). Coba lagi.');
    throw new Error('Tidak dapat terhubung ke server. Periksa koneksi internet.');
  } finally {
    clearTimeout(timer);
  }
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan (' + res.status + ')');
  return data;
}

// ---------- State ----------
const state = {
  user: null,
  books: [],
  bookId: null,
  transactions: [],       // transaksi rekening terpilih (Catatan/Buku Besar)
  allTransactions: [],    // semua transaksi lintas rekening (Analitik gabungan)
  month: null,            // null = belum diisi; diisi dari localStorage / bulan ini
  kategori: '',
  search: '',
  besarFrom: '',
  besarTo: '',
  anaScope: '',    // '' = gabungan semua rekening; atau id rekening tertentu
  anaRange: '12',  // '12' | '6' | 'all' | 'custom'
  anaFrom: '',     // YYYY-MM (custom / dihitung)
  anaTo: '',       // YYYY-MM
  taxMonth: '',    // YYYY-MM untuk ringkasan pajak
  view: 'catatan', // 'catatan' | 'besar' | 'analitik'
};

// ---------- Tema / densitas / profil cetak ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('theme-btn');
  if (btn) btn.textContent = t === 'light' ? 'Tema gelap' : 'Tema terang';
  try { localStorage.setItem('sintesa_theme', t); } catch (_) {}
}
function initTheme() { applyTheme(localStorage.getItem('sintesa_theme') === 'light' ? 'light' : 'dark'); }
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  if (state.user && state.view === 'analitik') renderAnalytics();
}

function applyDensity(compact) {
  document.body.classList.toggle('density-compact', !!compact);
  const btn = $('density-btn');
  if (btn) btn.textContent = compact ? 'Tabel longgar' : 'Tabel rapat';
  try { localStorage.setItem('sintesa_density', compact ? 'compact' : 'comfy'); } catch (_) {}
}
function initDensity() { applyDensity(localStorage.getItem('sintesa_density') === 'compact'); }
function toggleDensity() { applyDensity(!document.body.classList.contains('density-compact')); }

const COMPANY_DEFAULT = { name: 'PT Sintesa Data Semesta', address: '', npwp: '' };
function loadCompany() {
  try {
    const raw = localStorage.getItem('sintesa_company');
    if (!raw) return { ...COMPANY_DEFAULT };
    const o = JSON.parse(raw);
    return {
      name: (o.name || COMPANY_DEFAULT.name).trim() || COMPANY_DEFAULT.name,
      address: String(o.address || '').trim(),
      npwp: String(o.npwp || '').trim(),
    };
  } catch (_) { return { ...COMPANY_DEFAULT }; }
}
function saveCompany(data) {
  try { localStorage.setItem('sintesa_company', JSON.stringify(data)); } catch (_) {}
}
function openCompanyModal() {
  lastFocused = document.activeElement;
  const c = loadCompany();
  const f = $('company-form');
  f.name.value = c.name;
  f.address.value = c.address;
  f.npwp.value = c.npwp;
  $('company-modal').classList.remove('hidden');
  f.name.focus();
}

const curBook = () => state.books.find((b) => b.id === state.bookId) || null;

// ============================================================
//  AUTH
// ============================================================
async function boot() {
  $('year').textContent = new Date().getFullYear();
  initTheme();
  initDensity();
  wireStaticHandlers();
  const retryBtn = $('boot-retry');
  if (retryBtn) retryBtn.addEventListener('click', bootStatus);
  await bootStatus();
}

// Ambil status auth dengan tahan cold-start: coba beberapa kali sambil memberi tahu
// pengguna bahwa server sedang bangun, dan tawarkan "coba lagi" bila akhirnya gagal —
// alih-alih diam-diam melempar ke layar login (yang menyesatkan saat server yang bermasalah).
async function bootStatus() {
  const msgEl = $('boot-msg');
  const spinner = $('boot-spinner');
  const retryBtn = $('boot-retry');
  if (retryBtn) retryBtn.classList.add('hidden');
  if (spinner) spinner.classList.remove('hidden');
  const attempts = 4;
  for (let i = 1; i <= attempts; i++) {
    if (msgEl) msgEl.textContent = i === 1 ? 'Memuat…' : 'Server sedang bangun, mohon tunggu…';
    try {
      const status = await api('GET', '/api/auth/status');
      if (status.authenticated) { state.user = status.user; await enterApp(); }
      else showAuth();
      $('boot-loading').classList.add('hidden');
      return;
    } catch (_) {
      if (i < attempts) { await sleep(3000); continue; }
      // Semua percobaan gagal → jangan sembunyikan masalah; tampilkan pesan + tombol coba lagi.
      if (spinner) spinner.classList.add('hidden');
      if (msgEl) msgEl.textContent = 'Gagal terhubung ke server. Periksa koneksi Anda lalu coba lagi.';
      if (retryBtn) retryBtn.classList.remove('hidden');
    }
  }
}
function showAuth() { $('app-view').classList.add('hidden'); $('auth-view').classList.remove('hidden'); }

function isAdmin() { return !!(state.user && state.user.role === 'admin'); }
// Sesuaikan UI dengan peran: viewer tak melihat kontrol yang mengubah data.
function applyRole() {
  const viewer = !isAdmin();
  document.body.classList.toggle('role-viewer', viewer);
  $('sr-role').classList.toggle('hidden', !viewer);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('login-error').textContent = '';
  try {
    const { user } = await api('POST', '/api/auth/login', { username: f.username.value, password: f.password.value });
    state.user = user;
    await enterApp();
  } catch (err) { $('login-error').textContent = err.message; }
});

// ============================================================
//  DATA
// ============================================================
async function enterApp() {
  $('auth-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('menu-user').textContent = 'Masuk sebagai ' + state.user.name + (isAdmin() ? '' : ' (viewer)');
  $('sr-user').textContent = state.user.name;
  applyRole();
  await loadBooks();
}

async function loadBooks() {
  const { books } = await api('GET', '/api/books');
  state.books = books;
  if (books.length === 0) {
    if (!isAdmin()) {
      // Viewer tak berhak membuat rekening — jangan POST (akan 403 & memicu pesan menyesatkan).
      renderBookSelect();
      render();
      toast('Belum ada rekening. Hubungi admin untuk membuatnya.', true);
      return;
    }
    const { book } = await api('POST', '/api/books', { name: 'Rekening Utama' });
    state.books = [book];
  }
  // Hormati pilihan yang sudah diset (mis. rekening baru dibuat); jika tidak, pakai yang terakhir dipakai.
  const wanted = state.bookId || Number(localStorage.getItem('sintesa_book'));
  const found = state.books.find((b) => b.id === wanted);
  state.bookId = found ? found.id : state.books[0].id;
  renderBookSelect();
  await loadData();
}

function renderBookSelect() {
  const sel = $('book-select');
  sel.innerHTML = '';
  for (const b of state.books) {
    const o = document.createElement('option');
    o.value = b.id; o.textContent = b.name;
    if (b.id === state.bookId) o.selected = true;
    sel.appendChild(o);
  }
}

async function loadData() {
  localStorage.setItem('sintesa_book', String(state.bookId));
  // Satu sumber: ambil semua transaksi lintas rekening, lalu saring untuk rekening terpilih.
  const { transactions } = await api('GET', '/api/all-transactions');
  state.allTransactions = transactions;
  state.transactions = transactions.filter((t) => t.book_id === state.bookId);
  buildMonthFilter();
  buildAnaScope();
  render();
}

function buildAnaScope() {
  const sel = $('ana-scope');
  const cur = String(state.anaScope || '');
  sel.innerHTML = '<option value="">Gabungan (Semua Rekening)</option>' +
    state.books.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  const ids = state.books.map((b) => String(b.id));
  sel.value = ids.includes(cur) ? cur : '';
  state.anaScope = sel.value;
}

// Bulan ekstra yang ditambahkan pengguna (bisa kosong / belum ada transaksi).
// Disimpan di localStorage agar bulan ke depan tetap tersedia setelah reload.
const EXTRA_MONTHS_KEY = 'sintesa_extra_months';
const MONTH_KEY = 'sintesa_month'; // pilihan filter bulan terakhir (YYYY-MM atau '' = Semua)
const FUTURE_MONTHS = 6; // otomatis sediakan 6 bulan ke depan dari bulan berjalan

function loadExtraMonths() {
  try {
    const raw = JSON.parse(localStorage.getItem(EXTRA_MONTHS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(isYearMonth) : [];
  } catch (_) { return []; }
}
function saveExtraMonths(list) {
  try { localStorage.setItem(EXTRA_MONTHS_KEY, JSON.stringify([...new Set(list.filter(isYearMonth))])); }
  catch (_) { /* private mode / quota */ }
}
function addExtraMonth(ym) {
  if (!isYearMonth(ym)) return false;
  const list = loadExtraMonths();
  if (!list.includes(ym)) {
    list.push(ym);
    saveExtraMonths(list);
  }
  return true;
}

/** Ambil preferensi bulan: pilihan terakhir, atau bulan berjalan jika belum pernah diset. */
function loadSavedMonth() {
  try {
    const v = localStorage.getItem(MONTH_KEY);
    if (v === null) return todayISO().slice(0, 7); // kunjungan pertama → bulan ini
    if (v === '') return ''; // pengguna memilih "Semua bulan"
    return isYearMonth(v) ? v : todayISO().slice(0, 7);
  } catch (_) {
    return todayISO().slice(0, 7);
  }
}
function saveMonth(ym) {
  try { localStorage.setItem(MONTH_KEY, ym == null ? '' : String(ym)); }
  catch (_) { /* private mode / quota */ }
}

/** Kumpulkan opsi bulan: data transaksi + bulan ini + 6 bulan ke depan + ekstra manual. */
function availableMonths() {
  const fromTx = state.transactions.map((t) => t.tanggal.slice(0, 7)).filter(isYearMonth);
  const nowYm = todayISO().slice(0, 7);
  const horizon = monthsBetween(nowYm, shiftMonth(nowYm, FUTURE_MONTHS));
  return [...new Set([...fromTx, ...horizon, ...loadExtraMonths()])].sort().reverse();
}

function buildMonthFilter() {
  // Isi preferensi sekali: localStorage → bulan ini.
  if (state.month === null) state.month = loadSavedMonth();

  let preferred = state.month;
  // Pastikan bulan tersimpan (mis. bulan lalu tanpa transaksi) tetap muncul di daftar.
  if (isYearMonth(preferred)) addExtraMonth(preferred);

  const months = availableMonths();
  const sel = $('month-filter');
  sel.innerHTML = '<option value="">Semua bulan</option>';
  for (const m of months) {
    const o = document.createElement('option');
    o.value = m; o.textContent = labelBulan(m);
    sel.appendChild(o);
  }

  if (preferred === '' || months.includes(preferred)) {
    sel.value = preferred;
  } else {
    // Cadangan: bulan berjalan (selalu ada di horizon).
    preferred = todayISO().slice(0, 7);
    sel.value = preferred;
  }
  state.month = sel.value;
  saveMonth(state.month);
}

/** Tanggal default saat tambah transaksi: ikuti filter bulan bila aktif. */
function defaultTanggalForNewTx() {
  const today = todayISO();
  if (!state.month || !isYearMonth(state.month)) return today;
  if (today.startsWith(state.month)) return today;
  return `${state.month}-01`;
}

// ============================================================
//  RENDER
// ============================================================
function visibleTx() {
  const q = state.search.trim().toLowerCase();
  return state.transactions.filter((t) => {
    if (state.month && t.tanggal.slice(0, 7) !== state.month) return false;
    if (state.kategori && (t.kategori || '') !== state.kategori) return false;
    if (q && !((t.keterangan || '').toLowerCase().includes(q) || (t.kategori || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

function render() {
  const book = curBook();
  const analitik = state.view === 'analitik';
  // Analitik ikut scope (gabungan / rekening tertentu); tampilan lain ikut rekening terpilih.
  const scopeTx = analitik ? anaTx() : state.transactions;
  const scopeSaldoAwal = analitik ? anaSaldoAwal() : (book ? book.saldo_awal : 0);

  // Kartu masuk/keluar pada Catatan mengikuti filter (bulan/kategori/cari); view lain = seluruh scope.
  const cardTx = state.view === 'catatan' ? visibleTx() : scopeTx;
  const totalMasuk = cardTx.filter((t) => t.type === 'masuk').reduce((s, t) => s + t.jumlah, 0);
  const totalKeluar = cardTx.filter((t) => t.type === 'keluar').reduce((s, t) => s + t.jumlah, 0);

  // Saldo kartu: jangan pernah pakai saldo_awal + total terfilter (salah secara akuntansi).
  // - Catatan + filter bulan saja → saldo akhir periode (computeLedger)
  // - Catatan + kategori/cari → tampilkan saldo rekening penuh (bukan "saldo filter")
  // - Selain itu → saldo rekening / scope penuh
  const filterBits = [];
  if (state.view === 'catatan') {
    if (state.month) filterBits.push(labelBulan(state.month));
    if (state.kategori) filterBits.push('kategori ' + state.kategori);
    if (state.search.trim()) filterBits.push('pencarian');
  }
  const hasSoftFilter = !!(state.kategori || state.search.trim());
  let saldoCard;
  let lblSisa = 'Saldo Rekening';
  let lblMasuk = 'Total Pemasukan';
  let lblKeluar = 'Total Pengeluaran';
  let caption = '';

  if (state.view === 'catatan' && state.month && !hasSoftFilter) {
    const L = computeLedger(state.transactions, book ? book.saldo_awal : 0, `${state.month}-01`, `${state.month}-31`);
    saldoCard = L.saldoAkhir;
    lblSisa = 'Saldo per ' + labelBulan(state.month);
    lblMasuk = 'Pemasukan bulan';
    lblKeluar = 'Pengeluaran bulan';
    caption = 'Kartu mengikuti filter bulan. Saldo dihitung dengan pembuka periode (sama seperti Buku Besar).';
  } else if (state.view === 'catatan' && filterBits.length) {
    saldoCard = bookSisa(book);
    lblSisa = 'Saldo Rekening';
    lblMasuk = 'Pemasukan (filter)';
    lblKeluar = 'Pengeluaran (filter)';
    caption = 'Masuk/keluar mengikuti filter (' + filterBits.join(', ') + '). Saldo Rekening = saldo penuh, tidak terpotong filter.';
  } else {
    saldoCard = analitik
      ? scopeSaldoAwal + totalMasuk - totalKeluar
      : bookSisa(book);
    lblSisa = analitik ? 'Saldo Scope' : 'Saldo Rekening';
    caption = '';
  }

  $('sum-masuk').textContent = rupiah(totalMasuk);
  $('sum-keluar').textContent = rupiah(totalKeluar);
  $('sum-sisa').textContent = rupiah(saldoCard);
  const elLblM = $('lbl-masuk'), elLblK = $('lbl-keluar'), elLblS = $('lbl-sisa'), elCap = $('cards-caption');
  if (elLblM) elLblM.textContent = lblMasuk;
  if (elLblK) elLblK.textContent = lblKeluar;
  if (elLblS) elLblS.textContent = lblSisa;
  if (elCap) elCap.textContent = caption;

  // Kartu ringkasan hanya saat Catatan + ada filter (hindari tumpukan dengan home-dash).
  const cards = $('filter-cards');
  if (cards) {
    const showCards = state.view === 'catatan' && filterBits.length > 0;
    cards.classList.toggle('hidden', !showCards);
  }

  const scopeBook = analitik && anaScopeId() ? state.books.find((b) => b.id === anaScopeId()) : null;
  renderBookInfo({ analitik, book, scopeBook, saldoAwal: scopeSaldoAwal, txCount: scopeTx.length });

  const rows = visibleTx();
  renderColumn('masuk', rows.filter((t) => t.type === 'masuk'));
  renderColumn('keluar', rows.filter((t) => t.type === 'keluar'));
  updateKategoriList();
  renderHomeDash();
  renderLowBalanceAlert();

  if (state.view === 'besar') renderBukuBesar();
  if (state.view === 'analitik') renderAnalytics();
}

/** Saldo rekening dari saldo awal + seluruh transaksi (sumber kebenaran UI). */
function bookSisa(book) {
  if (!book) return 0;
  const tx = state.allTransactions.filter((t) => t.book_id === book.id);
  const masuk = tx.filter((t) => t.type === 'masuk').reduce((s, t) => s + t.jumlah, 0);
  const keluar = tx.filter((t) => t.type === 'keluar').reduce((s, t) => s + t.jumlah, 0);
  return (book.saldo_awal || 0) + masuk - keluar;
}

/** Ringkasan beranda: selalu bulan kalender berjalan (tidak ikut filter Catatan). */
function renderHomeDash() {
  const ym = todayISO().slice(0, 7);
  const elLabel = $('home-month-label');
  if (elLabel) elLabel.textContent = labelBulan(ym);
  const book = curBook();
  const tx = state.transactions.filter((t) => t.tanggal.slice(0, 7) === ym);
  const masuk = tx.filter((t) => t.type === 'masuk').reduce((s, t) => s + t.jumlah, 0);
  const keluar = tx.filter((t) => t.type === 'keluar').reduce((s, t) => s + t.jumlah, 0);
  $('home-masuk').textContent = rupiah(masuk);
  $('home-keluar').textContent = rupiah(keluar);
  $('home-sisa').textContent = rupiah(masuk - keluar);

  const recent = [...state.transactions]
    .sort((a, b) => (a.tanggal < b.tanggal ? 1 : a.tanggal > b.tanggal ? -1 : b.id - a.id))
    .slice(0, 5);
  const list = $('home-recent-list');
  if (!list) return;
  if (!recent.length) {
    list.innerHTML = `<li class="home-recent-empty">Belum ada transaksi di ${escapeHtml(book ? book.name : 'rekening ini')}.</li>`;
    return;
  }
  list.innerHTML = recent.map((t) => {
    const sign = t.type === 'masuk' ? '+' : '−';
    const cls = t.type === 'masuk' ? 'in' : 'out';
    const ket = escapeHtml(t.keterangan) || (t.type === 'masuk' ? 'Pemasukan' : 'Pengeluaran');
    return `<li>
      <span class="hr-date">${tanggalIndo(t.tanggal)}</span>
      <span class="hr-ket">${ket}${t.kategori ? ` <span class="muted">· ${escapeHtml(t.kategori)}</span>` : ''}</span>
      <span class="hr-amt ${cls}">${sign}${rupiah(t.jumlah)}</span>
    </li>`;
  }).join('');
}

/** Banner peringatan bila saldo rekening di bawah ambang — dihitung ulang dari transaksi. */
function renderLowBalanceAlert() {
  const el = $('low-balance-alert');
  if (!el) return;
  const low = state.books
    .map((b) => ({ ...b, sisaLive: bookSisa(b) }))
    .filter((b) => (b.ambang_saldo || 0) > 0 && b.sisaLive < b.ambang_saldo);
  if (!low.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<strong>Saldo rendah</strong>` + low.map((b) =>
    `<div class="alert-item">${escapeHtml(b.name)}: saldo ${rupiah(b.sisaLive)} (ambang ${rupiah(b.ambang_saldo)})</div>`
  ).join('');
}

function renderBookInfo({ analitik, book, scopeBook, saldoAwal, txCount }) {
  const parts = [];
  if (analitik && !scopeBook) {
    parts.push(`<span class="bi-name">Gabungan Semua Rekening</span>`);
    parts.push(`<span class="bi-item"><b>${state.books.length}</b> rekening</span>`);
    parts.push(`<span class="bi-item">Saldo Awal gabungan: <b>${rupiah(saldoAwal)}</b></span>`);
  } else if (analitik && scopeBook) {
    parts.push(`<span class="bi-name">Analitik: ${escapeHtml(scopeBook.name)}</span>`);
    parts.push(`<span class="bi-item">Saldo Awal: <b>${rupiah(saldoAwal)}</b></span>`);
    if (scopeBook.bank_info) parts.push(`<span class="bi-item">No. Rekening: <b>${escapeHtml(scopeBook.bank_info)}</b></span>`);
  } else {
    parts.push(`<span class="bi-name">${escapeHtml(book ? book.name : '')}</span>`);
    parts.push(`<span class="bi-item">Saldo Awal: <b>${rupiah(saldoAwal)}</b></span>`);
    if (book && book.bank_info) parts.push(`<span class="bi-item">No. Rekening: <b>${escapeHtml(book.bank_info)}</b></span>`);
  }
  parts.push(`<span class="bi-item">Jumlah transaksi: <b>${txCount}</b></span>`);
  $('book-info').innerHTML = parts.join('');
}

function renderColumn(type, list) {
  const tbody = $('tbody-' + type);
  tbody.innerHTML = '';
  if (list.length === 0) {
    const cta = isAdmin()
      ? ` <button type="button" class="btn btn-${type === 'masuk' ? 'in' : 'out'} btn-sm empty-cta" data-add="${type}">＋ Tambah ${type === 'masuk' ? 'pemasukan' : 'pengeluaran'}</button>`
      : '';
    const emptyMsg = state.month
      ? `Belum ada data di ${labelBulan(state.month)}.`
      : 'Belum ada data.';
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${emptyMsg}${cta}</td></tr>`;
  } else {
    list.forEach((t, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="c-no">${i + 1}</td>
        <td class="c-date">${tanggalIndo(t.tanggal)}</td>
        <td class="c-amt">${rupiah(t.jumlah)}</td>
        <td>${escapeHtml(t.keterangan) || '<span class="muted">—</span>'}${t.kategori ? ` <span class="muted">· ${escapeHtml(t.kategori)}</span>` : ''}${t.has_bukti ? ` <button type="button" class="bukti-chip" data-bukti="${t.id}" title="Lihat bukti">bukti</button>` : ''}</td>
        <td class="c-act"><div class="row-actions">${isAdmin() ? `
          <button class="icon-btn" title="Ubah" aria-label="Ubah transaksi ${tanggalIndo(t.tanggal)} ${rupiah(t.jumlah)}" data-edit="${t.id}">Ubah</button>
          <button class="icon-btn" title="Hapus" aria-label="Hapus transaksi ${tanggalIndo(t.tanggal)} ${rupiah(t.jumlah)}" data-del="${t.id}">Hapus</button>` : ''}
        </div></td>`;
      tbody.appendChild(tr);
    });
  }
  $('foot-' + type).textContent = rupiah(list.reduce((s, t) => s + t.jumlah, 0));
}

function updateKategoriList() {
  const cats = [...new Set(state.transactions.map((t) => t.kategori).filter(Boolean))].sort();
  $('kategori-list').innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}">`).join('');
  // Dropdown filter kategori (pertahankan pilihan bila masih ada)
  const sel = $('kategori-filter');
  const cur = state.kategori;
  sel.innerHTML = '<option value="">Semua</option>' + cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = cats.includes(cur) ? cur : '';
  state.kategori = sel.value;
}

// ---------- Buku Besar (saldo berjalan) ----------
// Memakai computeLedger (algoritma saldo berjalan yang sama dengan laporan cetak) agar tak ganda.
function computeBesar() {
  const book = curBook();
  const saldoAwal = book ? book.saldo_awal : 0;
  const { besarFrom: from, besarTo: to } = state;
  const L = computeLedger(state.transactions, saldoAwal, from, to);
  const rows = L.rows.map((t) => ({
    id: t.id, has_bukti: t.has_bukti, tanggal: t.tanggal, keterangan: t.keterangan, kategori: t.kategori,
    masuk: t.type === 'masuk' ? t.jumlah : 0, keluar: t.type === 'keluar' ? t.jumlah : 0, saldo: t.saldo,
  }));
  return { saldoAwal, opening: L.opening, rows, tMasuk: L.tMasuk, tKeluar: L.tKeluar, saldoAkhir: L.saldoAkhir, from, to };
}

function renderBukuBesar() {
  const d = computeBesar();
  const tbody = $('tbody-besar');
  const invalidRange = d.from && d.to && d.from > d.to;
  const openLabel = d.from ? `Saldo Awal per ${tanggalIndo(d.from)}` : 'SALDO AWAL';
  let html = `<tr class="opening"><td></td><td></td><td>${openLabel}</td><td class="c-amt"></td><td class="c-amt"></td><td class="c-amt r-saldo">${rupiah(d.opening)}</td></tr>`;
  if (invalidRange) {
    html += `<tr class="empty-row"><td colspan="6">Rentang tanggal tidak valid: "Dari" (${tanggalIndo(d.from)}) melewati "Sampai" (${tanggalIndo(d.to)}).</td></tr>`;
  } else if (d.rows.length === 0) {
    html += `<tr class="empty-row"><td colspan="6">Belum ada transaksi pada rentang ini</td></tr>`;
  } else {
    d.rows.forEach((r, i) => {
      const ket = escapeHtml(r.keterangan) + (r.kategori ? ` <span class="muted">· ${escapeHtml(r.kategori)}</span>` : '')
        + (r.has_bukti ? ` <button type="button" class="bukti-chip" data-bukti="${r.id}" title="Lihat bukti">bukti</button>` : '');
      html += `<tr>
        <td class="c-no">${i + 1}</td>
        <td class="c-date">${tanggalIndo(r.tanggal)}</td>
        <td>${ket || '<span class="muted">—</span>'}</td>
        <td class="c-amt">${r.masuk ? `<span class="r-in">${rupiah(r.masuk)}</span>` : ''}</td>
        <td class="c-amt">${r.keluar ? `<span class="r-out">${rupiah(r.keluar)}</span>` : ''}</td>
        <td class="c-amt r-saldo">${rupiah(r.saldo)}</td></tr>`;
    });
  }
  tbody.innerHTML = html;
  $('besar-tmasuk').textContent = rupiah(d.tMasuk);
  $('besar-tkeluar').textContent = rupiah(d.tKeluar);
  $('besar-saldo').textContent = rupiah(d.saldoAkhir);
  $('besar-range').textContent = d.from || d.to
    ? `${d.from ? tanggalIndo(d.from) : 'awal'} — ${d.to ? tanggalIndo(d.to) : 'kini'}`
    : 'seluruh periode';
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.vt-btn').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const panels = [
    ['ledger-view', 'catatan'],
    ['besar-view', 'besar'],
    ['analytics-view', 'analitik'],
  ];
  panels.forEach(([id, v]) => {
    const el = $(id);
    const show = view === v;
    el.classList.toggle('hidden', !show);
    if (show) {
      el.classList.remove('view-enter');
      void el.offsetWidth;
      el.classList.add('view-enter');
    }
  });
  $('tools-catatan').classList.toggle('hidden', view !== 'catatan');
  $('tools-besar').classList.toggle('hidden', view !== 'besar');
  $('tools-analitik').classList.toggle('hidden', view !== 'analitik');
  // Analitik punya ringkasannya sendiri — sembunyikan beranda.
  const home = $('home-dash');
  if (home) home.classList.toggle('hidden', view === 'analitik');
  const swipeHint = document.querySelector('.ledger-swipe-hint');
  if (swipeHint) swipeHint.classList.toggle('hidden', view !== 'catatan');
  render();
}

// ============================================================
//  BUKTI (lampiran) — kompres di browser, simpan sebagai data URL
// ============================================================
let buktiState = { data: null, changed: false, hasExisting: false, txId: null };

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('Gagal membaca file.'));
    r.readAsDataURL(file);
  });
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Gagal memuat gambar.'));
    i.src = src;
  });
}
async function processBukti(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 2_500_000) throw new Error('PDF terlalu besar (maks ~2,5MB).');
    return fileToDataURL(file);
  }
  if (!file.type.startsWith('image/')) throw new Error('Format tidak didukung. Pilih gambar atau PDF.');
  const img = await loadImage(await fileToDataURL(file));
  const maxDim = 1600;
  let { width, height } = img;
  if (Math.max(width, height) > maxDim) {
    const s = maxDim / Math.max(width, height);
    width = Math.round(width * s); height = Math.round(height * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  let out = canvas.toDataURL('image/jpeg', 0.72);
  if (out.length > 2_800_000) out = canvas.toDataURL('image/jpeg', 0.5); // turunkan bila masih besar
  return out;
}
function updateBuktiStatus() {
  const info = $('bukti-info');
  if (buktiState.data) {
    info.textContent = `📎 Bukti baru dipilih (~${Math.round((buktiState.data.length * 0.75) / 1024)} KB)`;
    $('bukti-status').classList.remove('hidden');
  } else if (buktiState.hasExisting) {
    info.textContent = '📎 Bukti terlampir';
    $('bukti-status').classList.remove('hidden');
  } else {
    $('bukti-status').classList.add('hidden');
  }
}
let buktiLastFocused = null;
function showBukti(dataUrl) {
  buktiLastFocused = document.activeElement; // agar fokus kembali saat penampil bukti ditutup
  const area = $('bukti-view-area'), dl = $('bukti-download');
  dl.href = dataUrl;
  if (dataUrl.startsWith('data:application/pdf')) {
    dl.download = 'bukti.pdf';
    area.innerHTML = `<p class="muted">Bukti berupa dokumen PDF. Klik "Unduh" untuk membukanya.</p>`;
  } else {
    dl.download = 'bukti.jpg';
    // Set src lewat properti (bukan interpolasi innerHTML) agar data URL tak bisa
    // "membocor" jadi markup — aman meski isinya tak terduga.
    area.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Bukti transaksi';
    img.className = 'bukti-img';
    area.appendChild(img);
  }
  $('bukti-modal').classList.remove('hidden');
}
async function openBukti(id) {
  try {
    const { bukti } = await api('GET', `/api/transactions/${id}/bukti`);
    showBukti(bukti);
  } catch (err) { toast(err.message, true); }
}
function closeBukti() {
  $('bukti-modal').classList.add('hidden');
  if (buktiLastFocused && buktiLastFocused.focus) {
    try { buktiLastFocused.focus(); } catch (_) { /* elemen mungkin sudah hilang */ }
  }
  buktiLastFocused = null;
}

// ============================================================
//  MODAL TRANSAKSI
// ============================================================
function openTxModal(type, tx) {
  lastFocused = document.activeElement;
  const f = $('tx-form');
  f.reset();
  $('tx-error').textContent = '';
  $('bukti-file').value = '';
  f.type.value = type;
  f.id.value = tx ? tx.id : '';
  f.tanggal.value = tx ? tx.tanggal : defaultTanggalForNewTx();
  f.jumlah.value = tx ? new Intl.NumberFormat('id-ID').format(tx.jumlah) : '';
  f.keterangan.value = tx ? tx.keterangan : '';
  f.kategori.value = tx ? tx.kategori : '';
  buktiState = { data: null, changed: false, hasExisting: !!(tx && tx.has_bukti), txId: tx ? tx.id : null };
  updateBuktiStatus();
  const label = type === 'masuk' ? 'Pemasukan' : 'Pengeluaran';
  $('tx-modal-title').textContent = (tx ? 'Ubah ' : 'Tambah ') + label;
  $('tx-submit').textContent = tx ? 'Simpan Perubahan' : 'Simpan';
  modalDirty = false;
  $('tx-modal').classList.remove('hidden');
  setTimeout(() => f.jumlah.focus(), 50);
}
$('bukti-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('tx-error').textContent = '';
  try {
    buktiState.data = await processBukti(file);
    buktiState.changed = true;
    updateBuktiStatus();
  } catch (err) { e.target.value = ''; $('tx-error').textContent = err.message; }
});
$('bukti-view').addEventListener('click', () => {
  if (buktiState.data) showBukti(buktiState.data);
  else if (buktiState.hasExisting && buktiState.txId) openBukti(buktiState.txId);
});
$('bukti-remove').addEventListener('click', () => {
  buktiState.data = null; buktiState.changed = true; buktiState.hasExisting = false;
  $('bukti-file').value = '';
  updateBuktiStatus();
  toast('Bukti akan dihapus saat disimpan.');
});
$('tx-form').jumlah.addEventListener('input', formatMoneyInput);
$('tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const submitBtn = $('tx-submit');
  // Cegah submit ganda: bila permintaan sebelumnya masih berjalan, abaikan klik berikutnya.
  // Tanpa ini, request lambat (cold start / upload bukti) membuat pengguna mengira aplikasi
  // "hang" lalu mengklik berulang — menghasilkan transaksi kembar.
  if (submitBtn.disabled) return;
  $('tx-error').textContent = '';
  const payload = {
    type: f.type.value, tanggal: f.tanggal.value,
    jumlah: f.jumlah.value.replace(/\D/g, ''),
    keterangan: f.keterangan.value, kategori: f.kategori.value,
  };
  if (!payload.jumlah) { $('tx-error').textContent = 'Jumlah wajib diisi.'; return; }
  // Sertakan "bukti" hanya bila diubah (data URL baru, atau null bila dihapus).
  if (buktiState.changed) payload.bukti = buktiState.data;

  const isNew = !f.id.value;
  const origText = submitBtn.textContent;
  // Umpan balik visual + kunci tombol selama proses simpan (klik → langsung terlihat responsif).
  submitBtn.disabled = true;
  submitBtn.setAttribute('aria-busy', 'true');
  submitBtn.textContent = 'Menyimpan…';
  try {
    if (isNew) { await api('POST', `/api/books/${state.bookId}/transactions`, payload); toast('Transaksi ditambahkan.'); }
    else { await api('PATCH', `/api/transactions/${f.id.value}`, payload); toast('Transaksi diperbarui.'); }
    const again = isNew && $('tx-again').checked;
    if (again) {
      // Entri cepat berturut-turut: perlu data terbaru sebelum membuka ulang modal.
      await loadData();
      const type = f.type.value, tanggal = f.tanggal.value;
      openTxModal(type);
      $('tx-form').tanggal.value = tanggal;
      $('tx-again').checked = true;
      setTimeout(() => $('tx-form').jumlah.focus(), 60);
    } else {
      // Tutup modal SEKETIKA setelah simpan sukses (terasa instan), lalu segarkan daftar
      // di latar — tak perlu menunggu pengambilan ulang seluruh transaksi selesai.
      closeModals();
      loadData().catch(() => toast('Tersimpan. Gagal memuat ulang daftar — silakan segarkan halaman.', true));
    }
  } catch (err) { $('tx-error').textContent = err.message; }
  finally {
    submitBtn.disabled = false;
    submitBtn.setAttribute('aria-busy', 'false');
    // Untuk kasus "again", openTxModal() sudah menyetel ulang teks tombol; hanya pulihkan
    // bila masih menampilkan status "Menyimpan…".
    if (submitBtn.textContent === 'Menyimpan…') submitBtn.textContent = origText;
  }
});

// ============================================================
//  PENGATURAN / BUKU
// ============================================================
function openBookModal(book) {
  lastFocused = document.activeElement;
  const f = $('book-form');
  f.reset();
  $('book-error').textContent = '';
  f.id.value = book ? book.id : '';
  f.name.value = book ? book.name : '';
  f.saldo_awal.value = book && book.saldo_awal ? new Intl.NumberFormat('id-ID').format(book.saldo_awal) : '';
  f.bank_info.value = book ? book.bank_info || '' : '';
  f.ambang_saldo.value = book && book.ambang_saldo ? new Intl.NumberFormat('id-ID').format(book.ambang_saldo) : '';
  $('book-modal-title').textContent = book ? 'Pengaturan Rekening' : 'Rekening Baru';
  // Tombol hapus hanya saat mengubah rekening yang ada, dan bila lebih dari satu rekening.
  $('book-delete').classList.toggle('hidden', !(book && state.books.length > 1));
  modalDirty = false;
  $('book-modal').classList.remove('hidden');
  setTimeout(() => f.name.focus(), 50);
}
$('book-form').saldo_awal.addEventListener('input', formatMoneyInput);
$('book-form').ambang_saldo.addEventListener('input', formatMoneyInput);
$('book-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('book-error').textContent = '';
  const payload = {
    name: f.name.value,
    saldo_awal: f.saldo_awal.value.replace(/\D/g, ''),
    bank_info: f.bank_info.value,
    ambang_saldo: f.ambang_saldo.value.replace(/\D/g, '') || '0',
  };
  withSubmitLock(f, 'Menyimpan…', async () => {
    try {
      if (f.id.value) { await api('PATCH', `/api/books/${f.id.value}`, payload); toast('Rekening diperbarui.'); }
      else { const { book } = await api('POST', '/api/books', payload); state.bookId = book.id; toast('Rekening dibuat.'); }
      closeModals();
      await loadBooks();
    } catch (err) { $('book-error').textContent = err.message; }
  });
});

async function deleteBook() {
  const id = Number($('book-form').id.value);
  if (!id) return;
  if (state.books.length <= 1) return toast('Minimal harus ada satu rekening.', true);
  const b = state.books.find((x) => x.id === id);
  if (!confirm(`Hapus rekening "${b ? b.name : ''}" beserta transaksinya? Data diarsipkan (tetap tersimpan untuk pemulihan) dan tak lagi muncul di aplikasi.`)) return;
  try {
    await api('DELETE', `/api/books/${id}`);
    if (state.bookId === id) { localStorage.removeItem('sintesa_book'); state.bookId = null; }
    if (String(state.anaScope) === String(id)) state.anaScope = '';
    closeModals();
    await loadBooks();
    toast('Rekening dihapus.');
  } catch (err) { toast(err.message, true); }
}

// ============================================================
//  PENGGUNA
// ============================================================
async function openUsers() {
  lastFocused = document.activeElement;
  closeMenu();
  try {
    const { users } = await api('GET', '/api/auth/users');
    $('users-list').innerHTML = users.map((u) => {
      const self = state.user && u.id === state.user.id;
      const del = self
        ? '<span class="u-self">(Anda)</span>'
        : `<button type="button" class="icon-btn u-del" data-deluser="${u.id}" aria-label="Hapus pengguna ${escapeHtml(u.name)}" title="Hapus pengguna">🗑</button>`;
      const role = `<span class="u-role u-role-${u.role || 'admin'}">${u.role === 'viewer' ? 'viewer' : 'admin'}</span>`;
      return `<li><span class="u-name">${escapeHtml(u.name)}</span><span class="u-username">@${escapeHtml(u.username)}</span>${role}${del}</li>`;
    }).join('');
    $('add-user-error').textContent = '';
    $('add-user-form').reset();
    $('users-modal').classList.remove('hidden');
    setTimeout(() => $('add-user-form').name.focus(), 50);
  } catch (err) { toast(err.message, true); }
}

async function deleteUser(id, name) {
  if (!confirm(`Hapus pengguna "${name}"? Akun ini tidak bisa dipulihkan.`)) return;
  try {
    await api('DELETE', `/api/auth/users/${id}`);
    toast('Pengguna dihapus.');
    await openUsers();
  } catch (err) { toast(err.message, true); }
}
$('add-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('add-user-error').textContent = '';
  withSubmitLock(f, 'Menyimpan…', async () => {
    try {
      await api('POST', '/api/auth/register', { name: f.name.value, username: f.username.value, password: f.password.value, role: f.role.value });
      toast('Pengguna ditambahkan.');
      await openUsers();
    } catch (err) { $('add-user-error').textContent = err.message; }
  });
});

// ---------- Ganti password ----------
function openPassword() {
  lastFocused = document.activeElement;
  closeMenu();
  $('password-form').reset();
  $('password-error').textContent = '';
  $('password-modal').classList.remove('hidden');
  setTimeout(() => $('password-form').current_password.focus(), 50);
}
$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('password-error').textContent = '';
  if (f.new_password.value !== f.confirm_password.value) {
    $('password-error').textContent = 'Ulangi password baru tidak sama.';
    return;
  }
  try {
    await api('POST', '/api/auth/password', { current_password: f.current_password.value, new_password: f.new_password.value });
    closeModals();
    toast('Password berhasil diganti.');
  } catch (err) { $('password-error').textContent = err.message; }
});

// ---------- Cadangkan data ----------
async function backupData() {
  closeMenu();
  try {
    const data = await api('GET', '/api/backup');
    const stamp = todayISO();
    downloadBlob(JSON.stringify(data, null, 2), `backup-sintesa-keuangan-${stamp}.json`, 'application/json');
    toast('Cadangan data diunduh.');
  } catch (err) { toast(err.message, true); }
}

// ---------- Pulihkan dari cadangan (restore) ----------
function openRestore() { closeMenu(); $('restore-file').click(); }
$('restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm('Pulihkan data dari file cadangan? Ini akan MENIMPA SELURUH data saat ini. Lanjutkan?')) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.books || !data.transactions) throw new Error('File bukan cadangan yang valid.');
    data.mode = 'replace';
    const res = await api('POST', '/api/restore', data);
    state.bookId = null;
    localStorage.removeItem('sintesa_book');
    await loadBooks();
    // Jangan sembunyikan data yang dilewati saat restore — beri tahu pengguna.
    const warn = (res.skipped || res.buktiDropped)
      ? ` (${res.skipped || 0} transaksi dilewati, ${res.buktiDropped || 0} bukti dibuang)`
      : '';
    toast(`Dipulihkan: ${res.books} rekening, ${res.transactions} transaksi${warn}.`, !!warn);
  } catch (err) { toast('Gagal memulihkan: ' + err.message, true); }
});

// ---------- Transfer antar rekening ----------
function openTransfer() {
  closeMenu();
  if (state.books.length < 2) return toast('Butuh minimal 2 rekening untuk transfer.', true);
  lastFocused = document.activeElement;
  const f = $('transfer-form');
  f.reset();
  $('transfer-error').textContent = '';
  const opts = state.books.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  f.from_book.innerHTML = opts;
  f.to_book.innerHTML = opts;
  f.from_book.value = String(state.bookId);
  const other = state.books.find((b) => b.id !== state.bookId);
  f.to_book.value = String(other ? other.id : state.bookId);
  f.tanggal.value = todayISO();
  modalDirty = false;
  $('transfer-modal').classList.remove('hidden');
  setTimeout(() => f.jumlah.focus(), 50);
}
$('transfer-form').jumlah.addEventListener('input', formatMoneyInput);
$('transfer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('transfer-error').textContent = '';
  if (f.from_book.value === f.to_book.value) { $('transfer-error').textContent = 'Pilih dua rekening berbeda.'; return; }
  const payload = {
    from_book: Number(f.from_book.value), to_book: Number(f.to_book.value),
    tanggal: f.tanggal.value, jumlah: f.jumlah.value.replace(/\D/g, ''), keterangan: f.keterangan.value,
  };
  if (!payload.jumlah) { $('transfer-error').textContent = 'Jumlah wajib diisi.'; return; }
  withSubmitLock(f, 'Menyimpan…', async () => {
    try {
      await api('POST', '/api/transfer', payload);
      toast('Transfer berhasil dicatat.');
      closeModals();
      loadData().catch(() => toast('Tersimpan. Gagal memuat ulang daftar — silakan segarkan halaman.', true));
    } catch (err) { $('transfer-error').textContent = err.message; }
  });
});

// ---------- Riwayat aktivitas (audit) ----------
function fmtWhen(iso) {
  try { return new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }); }
  catch (_) { return String(iso); }
}
async function openAudit() {
  closeMenu();
  lastFocused = document.activeElement;
  try {
    const { events } = await api('GET', '/api/auth/audit');
    $('audit-list').innerHTML = events.length
      ? events.map((ev) => `<tr>
          <td class="a-when">${escapeHtml(fmtWhen(ev.at))}</td>
          <td class="a-who">${escapeHtml(ev.username || '—')}</td>
          <td><span class="a-act a-${escapeHtml(ev.action)}">${escapeHtml(ev.action)}</span> ${escapeHtml(ev.entity)}${ev.detail ? ` <span class="muted">· ${escapeHtml(ev.detail)}</span>` : ''}</td>
        </tr>`).join('')
      : '<tr><td class="muted">Belum ada aktivitas tercatat.</td></tr>';
    $('audit-modal').classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
}

// ============================================================
//  IMPOR CSV
// ============================================================
function openImport() {
  lastFocused = document.activeElement;
  closeMenu();
  $('import-error').textContent = '';
  $('import-result').textContent = '';
  $('import-file').value = '';
  $('import-modal').classList.remove('hidden');
  setTimeout(() => $('import-file').focus(), 50);
}
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('import-error').textContent = '';
  $('import-result').textContent = 'Memproses…';
  try {
    const text = await file.text();
    const txs = rowsToTransactions(parseCsv(text));
    if (!txs.length) throw new Error('Tidak ada baris valid ditemukan. Periksa kolom & format tanggal.');
    const res = await api('POST', `/api/books/${state.bookId}/transactions/bulk`, { transactions: txs });
    $('import-result').textContent = `Berhasil impor ${res.inserted} transaksi${res.gagal ? `, ${res.gagal} baris dilewati` : ''}.`;
    toast(`Impor selesai: ${res.inserted} transaksi.`);
    await loadData();
  } catch (err) { $('import-result').textContent = ''; $('import-error').textContent = err.message; }
});
function downloadTemplate() {
  const csv = 'Jenis,Tanggal,Jumlah,Keterangan,Kategori\r\nPemasukan,2026-07-01,8000000,Contoh pemasukan,Proyek\r\nPengeluaran,2026-07-02,1100000,Contoh pengeluaran,Operasional\r\n';
  downloadBlob('﻿' + csv, 'template-impor-kas.csv');
}

// ============================================================
//  EKSPOR & CETAK
// ============================================================
function exportCsv() {
  const book = curBook();
  const name = slug(book ? book.name : 'buku');
  if (state.view === 'besar') {
    const d = computeBesar();
    const lines = [['Tanggal', 'Keterangan', 'Kategori', 'Masuk', 'Keluar', 'Saldo'].join(',')];
    lines.push(['', d.from ? `Saldo Awal per ${d.from}` : 'Saldo Awal', '', '', '', d.opening].map(csvCell).join(','));
    for (const r of d.rows) lines.push([r.tanggal, r.keterangan, r.kategori, r.masuk || '', r.keluar || '', r.saldo].map(csvCell).join(','));
    lines.push(['', 'SALDO AKHIR', '', d.tMasuk, d.tKeluar, d.saldoAkhir].map(csvCell).join(','));
    return downloadBlob('﻿' + lines.join('\r\n'), `bukubesar-${name}.csv`);
  }
  const rows = visibleTx();
  if (rows.length === 0) return toast('Tidak ada data untuk diekspor.', true);
  const lines = [['Jenis', 'Tanggal', 'Jumlah', 'Keterangan', 'Kategori'].join(',')];
  for (const t of rows) lines.push([t.type === 'masuk' ? 'Pemasukan' : 'Pengeluaran', t.tanggal, t.jumlah, t.keterangan, t.kategori].map(csvCell).join(','));
  downloadBlob('﻿' + lines.join('\r\n'), `kas-${name}-${state.month || 'semua'}.csv`);
}

// ============================================================
//  LAPORAN CETAK / PDF — dokumen resmi lengkap
// ============================================================
function buildPrintReport() {
  const analitik = state.view === 'analitik';
  const company = loadCompany();
  const scopeBook = analitik ? (anaScopeId() ? state.books.find((b) => b.id === anaScopeId()) : null) : curBook();
  const scopeTx = analitik ? anaTxInRange() : state.transactions;
  const saldoAwal = analitik ? anaSaldoAwalForRange() : (scopeBook ? scopeBook.saldo_awal : 0);
  const scopeName = analitik && !scopeBook ? 'Gabungan Semua Rekening' : (scopeBook ? scopeBook.name : '—');
  const bankInfo = scopeBook ? (scopeBook.bank_info || '') : '';

  let from = '', to = '', periodLabel = 'Seluruh periode';
  if (state.view === 'besar' && (state.besarFrom || state.besarTo)) {
    from = state.besarFrom; to = state.besarTo;
    periodLabel = `${from ? tanggalIndo(from) : 'awal'} — ${to ? tanggalIndo(to) : 'kini'}`;
  } else if (state.view === 'catatan' && state.month) {
    from = `${state.month}-01`; to = `${state.month}-31`;
    periodLabel = labelBulan(state.month);
  } else if (analitik) {
    const { fromYm, toYm } = resolveAnaRange();
    if (fromYm && toYm) {
      from = `${fromYm}-01`; to = `${toYm}-31`;
      periodLabel = fromYm === toYm ? labelBulan(fromYm) : `${labelBulan(fromYm)} — ${labelBulan(toYm)}`;
    }
  }

  let filterNote = '';
  if (state.view === 'catatan') {
    const fl = [];
    if (state.kategori) fl.push(`kategori "${state.kategori}"`);
    if (state.search) fl.push(`pencarian "${state.search}"`);
    if (fl.length) filterNote = `Filter layar (${fl.join(', ')}) tidak diterapkan; laporan mencakup seluruh transaksi periode.`;
  }

  const jenis = analitik ? 'Rekapitulasi Keuangan' : state.view === 'besar' ? 'Buku Besar' : 'Buku Kas';
  const L = computeLedger(scopeTx, saldoAwal, from, to);
  const cetakTgl = tanggalIndo(todayISO());
  const docNo = `SDS/LK/${todayISO().replace(/-/g, '')}`;

  const breakdown = (type) => {
    const m = new Map();
    for (const r of L.rows) if (r.type === type) {
      const k = r.kategori || 'Tanpa kategori';
      m.set(k, (m.get(k) || 0) + r.jumlah);
    }
    const arr = [...m.entries()].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
    return { arr, tot: arr.reduce((s, x) => s + x.v, 0) };
  };
  const bdIn = breakdown('masuk'), bdOut = breakdown('keluar');
  const bdRows = (bd) => bd.arr.length
    ? bd.arr.map((x) => `<tr><td>${escapeHtml(x.k)}</td><td class="num">${rupiah(x.v)}</td><td class="num">${bd.tot ? Math.round((x.v / bd.tot) * 100) : 0}%</td></tr>`).join('') +
      `<tr class="total"><td>TOTAL</td><td class="num">${rupiah(bd.tot)}</td><td class="num">100%</td></tr>`
    : `<tr><td colspan="3" style="color:#666;font-style:italic">Tidak ada</td></tr>`;

  const analisisPengeluaran = () => {
    const tK = L.tKeluar, tM = L.tMasuk;
    const nK = L.rows.filter((r) => r.type === 'keluar').length;
    if (tK === 0) return 'Tidak ada pengeluaran yang tercatat pada periode ini, sehingga seluruh pemasukan menjadi saldo bersih tanpa beban belanja.';
    const net = tM - tK;
    const ratio = tM > 0 ? Math.round((tK / tM) * 100) : null;
    const top = bdOut.arr[0];
    const topPct = bdOut.tot ? Math.round((top.v / bdOut.tot) * 100) : 0;
    const kat2 = bdOut.arr[1];
    const kat2Pct = kat2 && bdOut.tot ? Math.round((kat2.v / bdOut.tot) * 100) : 0;
    let big = null;
    for (const r of L.rows) if (r.type === 'keluar' && (!big || r.jumlah > big.jumlah)) big = r;

    let nilai;
    if (ratio === null) nilai = 'Tidak ada pemasukan pada periode ini sebagai pembanding, sehingga seluruh pengeluaran langsung menggerus saldo — arus kas perlu diwaspadai.';
    else if (net < 0) nilai = `Pengeluaran melampaui pemasukan (rasio ${ratio}%) dan menimbulkan defisit ${rupiah(Math.abs(net))}; disarankan mengevaluasi pos belanja terbesar atau menambah pemasukan.`;
    else if (ratio >= 80) nilai = `Rasio belanja tergolong tinggi (${ratio}% dari pemasukan) sehingga margin kas menipis; menekan pos pengeluaran terbesar dapat memperkuat surplus.`;
    else if (ratio >= 50) nilai = `Rasio belanja tergolong wajar (${ratio}% dari pemasukan) dengan surplus ${rupiah(net)}, meski ruang surplus tetap perlu dijaga.`;
    else nilai = `Rasio belanja tergolong sehat (${ratio}% dari pemasukan) dan menyisakan surplus ${rupiah(net)} sebagai penguat kas.`;

    const lead = periodLabel === 'Seluruh periode' ? 'Secara keseluruhan' : `Selama ${periodLabel}`;
    let s = `${lead}, tercatat ${nK} transaksi pengeluaran dengan total ${rupiah(tK)}`;
    s += ratio !== null ? ` — setara ${ratio}% dari pemasukan ${rupiah(tM)}.` : '.';
    s += ` Pos belanja terbesar berasal dari kategori ${escapeHtml(top.k)} sebesar ${rupiah(top.v)} (${topPct}% dari total pengeluaran)`;
    s += kat2 ? `, diikuti ${escapeHtml(kat2.k)} (${kat2Pct}%).` : '.';
    if (big) s += ` Pengeluaran tunggal terbesar ${rupiah(big.jumlah)}${big.keterangan ? ` untuk "${escapeHtml(big.keterangan)}"` : ''}.`;
    return s + ' ' + nilai;
  };

  const coAddr = company.address ? `<div class="pr-co-addr">${escapeHtml(company.address)}</div>` : '';
  const coNpwp = company.npwp ? `<div class="pr-co-npwp">NPWP: ${escapeHtml(company.npwp)}</div>` : '';
  const kop = `
    <div class="pr-watermark" aria-hidden="true"><span>RAHASIA</span></div>
    <header class="pr-head">
      <div class="pr-brand">
        <img class="pr-mark" src="/logo.svg" alt="Logo" width="44" height="44" />
        <div>
          <div class="pr-co-name">${escapeHtml(company.name || 'PT SINTESA DATA SEMESTA').toUpperCase()}</div>
          <div class="pr-co-sub">Sistem Pencatatan Keuangan</div>
          ${coAddr}${coNpwp}
        </div>
      </div>
      <div class="pr-docmeta">
        <div>No. Dokumen: <b>${docNo}</b></div>
        <div>Tanggal Cetak: <b>${cetakTgl}</b></div>
      </div>
    </header>
    <div class="pr-title">Laporan ${jenis}</div>
    <div class="pr-subtitle">${escapeHtml(scopeName)}</div>
    <table class="pr-meta"><tbody>
      <tr><td class="k">Rekening</td><td class="v">: ${escapeHtml(scopeName)}</td></tr>
      ${bankInfo ? `<tr><td class="k">No. Rekening / Bank</td><td class="v">: ${escapeHtml(bankInfo)}</td></tr>` : ''}
      <tr><td class="k">Periode</td><td class="v">: ${periodLabel}</td></tr>
      <tr><td class="k">Jumlah Transaksi</td><td class="v">: ${L.rows.length}</td></tr>
      ${filterNote ? `<tr><td class="k">Catatan</td><td class="v">: ${escapeHtml(filterNote)}</td></tr>` : ''}
    </tbody></table>
    <section class="pr-summary">
      <div class="pr-sum-box"><div class="lbl">Saldo Awal</div><div class="val">${rupiah(L.opening)}</div></div>
      <div class="pr-sum-box pos"><div class="lbl">Total Pemasukan</div><div class="val">${rupiah(L.tMasuk)}</div></div>
      <div class="pr-sum-box neg"><div class="lbl">Total Pengeluaran</div><div class="val">${rupiah(L.tKeluar)}</div></div>
      <div class="pr-sum-box saldo"><div class="lbl">Saldo Akhir</div><div class="val">${rupiah(L.saldoAkhir)}</div></div>
    </section>`;

  const sign = `
    <section class="pr-sign">
      <div class="pr-place">………………………, ${cetakTgl}</div>
      <div class="pr-sign-cols">
        <div class="pr-sign-col">
          <div class="pr-sign-role">Dibuat oleh,</div>
          <div class="pr-sign-name">${escapeHtml(state.user ? state.user.name : '')}</div>
          <div class="pr-sign-sub">Petugas Pencatatan</div>
        </div>
        <div class="pr-sign-col">
          <div class="pr-sign-role">Mengetahui,</div>
          <div class="pr-sign-name">&nbsp;</div>
          <div class="pr-sign-sub">Pimpinan</div>
        </div>
      </div>
    </section>
    <div class="pr-pagefoot">${docNo} · ${escapeHtml(company.name)} — Sistem Pencatatan Keuangan · Dicetak ${cetakTgl}</div>`;

  if (analitik) {
    const chartM = ($('chart-monthly') && $('chart-monthly').innerHTML) || '';
    const chartB = ($('chart-balance') && $('chart-balance').innerHTML) || '';
    const rekRows = state.books.map((b) => {
      const sisa = bookSisa(b);
      const low = (b.ambang_saldo || 0) > 0 && sisa < b.ambang_saldo;
      return `<tr class="${low ? 'low' : ''}"><td>${escapeHtml(b.name)}</td><td class="num">${rupiah(sisa)}</td>
        <td>${low ? 'Di bawah ambang' : ((b.ambang_saldo || 0) > 0 ? rupiah(b.ambang_saldo) : '—')}</td></tr>`;
    }).join('');
    $('print-report').innerHTML = kop + `
      <h4 style="margin:14px 0 6px;font-size:11px">Posisi Rekening</h4>
      <table class="pr-ana-rek"><thead><tr><th>Rekening</th><th class="num">Saldo</th><th>Ambang</th></tr></thead>
      <tbody>${rekRows || '<tr><td colspan="3">—</td></tr>'}</tbody></table>
      <section class="pr-ana-charts">
        <div class="pr-ana-chart"><h4>Pemasukan vs Pengeluaran</h4>${chartM}</div>
        <div class="pr-ana-chart"><h4>Saldo Berjalan</h4>${chartB}</div>
      </section>
      <section class="pr-breakdown">
        <div class="pr-bd"><h4>Rekap Pemasukan per Kategori</h4><table class="pr-bd-table"><tbody>${bdRows(bdIn)}</tbody></table></div>
        <div class="pr-bd"><h4>Rekap Pengeluaran per Kategori</h4><table class="pr-bd-table"><tbody>${bdRows(bdOut)}</tbody></table></div>
      </section>
      <section class="pr-analisis"><h4>Analisis Pengeluaran</h4><p class="pr-analisis-body">${analisisPengeluaran()}</p></section>
      ${sign}`;
    return;
  }

  const openLabel = from ? `Saldo awal per ${tanggalIndo(from)}` : 'SALDO AWAL';
  let ledgerBody = `<tr class="opening"><td class="c-no"></td><td>—</td><td colspan="2">${openLabel}</td><td class="num"></td><td class="num"></td><td class="num">${rupiah(L.opening)}</td></tr>`;
  if (L.rows.length === 0) {
    ledgerBody += `<tr><td colspan="7" class="pr-empty">Tidak ada transaksi pada periode ini.</td></tr>`;
  } else {
    ledgerBody += L.rows.map((r, i) => `<tr>
      <td class="c-no">${i + 1}</td>
      <td>${tanggalIndo(r.tanggal)}</td>
      <td>${escapeHtml(r.keterangan) || '—'}</td>
      <td>${escapeHtml(r.kategori) || '—'}</td>
      <td class="num r-in">${r.type === 'masuk' ? rupiah(r.jumlah) : ''}</td>
      <td class="num r-out">${r.type === 'keluar' ? rupiah(r.jumlah) : ''}</td>
      <td class="num">${rupiah(r.saldo)}</td></tr>`).join('');
  }

  $('print-report').innerHTML = kop + `
    <table class="pr-ledger">
      <thead><tr>
        <th class="c-no">No</th><th>Tanggal</th><th>Keterangan</th><th>Kategori</th>
        <th class="num">Pemasukan</th><th class="num">Pengeluaran</th><th class="num">Saldo</th>
      </tr></thead>
      <tbody>${ledgerBody}</tbody>
      <tfoot><tr>
        <td colspan="4">TOTAL</td>
        <td class="num">${rupiah(L.tMasuk)}</td>
        <td class="num">${rupiah(L.tKeluar)}</td>
        <td class="num">${rupiah(L.saldoAkhir)}</td>
      </tr></tfoot>
    </table>
    <section class="pr-breakdown">
      <div class="pr-bd"><h4>Rekap Pemasukan per Kategori</h4><table class="pr-bd-table"><tbody>${bdRows(bdIn)}</tbody></table></div>
      <div class="pr-bd"><h4>Rekap Pengeluaran per Kategori</h4><table class="pr-bd-table"><tbody>${bdRows(bdOut)}</tbody></table></div>
    </section>
    <section class="pr-analisis"><h4>Analisis Pengeluaran</h4><p class="pr-analisis-body">${analisisPengeluaran()}</p></section>
    ${sign}`;
}

// ============================================================
//  MENU & HANDLER
// ============================================================
function toggleMenu() { $('menu-dropdown').classList.toggle('hidden'); }
function closeMenu() { $('menu-dropdown').classList.add('hidden'); }

// Fokus terakhir sebelum modal dibuka (untuk dikembalikan saat ditutup) + penanda "ada perubahan".
let lastFocused = null;
let modalDirty = false;

function closeModals() {
  ['tx-modal', 'book-modal', 'import-modal', 'users-modal', 'password-modal', 'transfer-modal', 'audit-modal', 'company-modal'].forEach((id) => $(id).classList.add('hidden'));
  modalDirty = false;
  if (lastFocused && typeof lastFocused.focus === 'function') {
    try { lastFocused.focus(); } catch (_) {}
    lastFocused = null;
  }
}

// Apakah modal yang bisa mengubah data (transaksi/rekening) sedang terbuka dengan perubahan?
function isEditModalDirty() {
  if (!$('tx-modal').classList.contains('hidden')) return modalDirty || buktiState.changed;
  if (!$('book-modal').classList.contains('hidden')) return modalDirty;
  return false;
}

// Penutupan "tak sengaja" (klik latar / Esc): konfirmasi bila ada perubahan belum disimpan.
function requestCloseModals() {
  if (isEditModalDirty() && !confirm('Ada perubahan yang belum disimpan. Tutup dan buang perubahan?')) return;
  closeModals();
}

// Jerat fokus (Tab) di dalam modal yang terbuka agar tidak "bocor" ke belakang.
function trapModalTab(e) {
  const open = [...document.querySelectorAll('.modal')].filter((m) => !m.classList.contains('hidden'));
  const openM = open[open.length - 1]; // modal teratas (mis. penampil bukti di atas modal transaksi)
  if (!openM) return;
  const list = [...openM.querySelectorAll(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
  )].filter((el) => el.offsetParent !== null);
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1];
  if (!openM.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function wireStaticHandlers() {
  // Delegasi: tombol data-add bisa muncul dinamis (empty state).
  document.addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-add]');
    if (!addBtn || addBtn.closest('.modal')) return;
    if (!isAdmin()) return;
    openTxModal(addBtn.dataset.add);
  });

  const taxMonth = $('tax-month');
  if (taxMonth) {
    taxMonth.value = todayISO().slice(0, 7);
    state.taxMonth = taxMonth.value;
    taxMonth.addEventListener('change', (e) => {
      state.taxMonth = e.target.value || todayISO().slice(0, 7);
      if (state.view === 'analitik') renderTaxSummary();
    });
  }

  $('ledger-view').addEventListener('click', async (e) => {
    const buktiId = e.target.dataset.bukti, editId = e.target.dataset.edit, delId = e.target.dataset.del;
    if (buktiId) { openBukti(Number(buktiId)); return; }
    if (editId) {
      const tx = state.transactions.find((t) => t.id === Number(editId));
      if (tx) openTxModal(tx.type, tx);
    } else if (delId) {
      const tx = state.transactions.find((t) => t.id === Number(delId));
      const label = tx
        ? `${tx.type === 'masuk' ? 'pemasukan' : 'pengeluaran'} ${rupiah(tx.jumlah)} tanggal ${tanggalIndo(tx.tanggal)}`
        : 'ini';
      if (!confirm(`Hapus transaksi ${label}? Tindakan ini tidak bisa dibatalkan.`)) return;
      try { await api('DELETE', `/api/transactions/${delId}`); toast('Transaksi dihapus.'); await loadData(); }
      catch (err) { toast(err.message, true); }
    }
  });
  $('besar-view').addEventListener('click', (e) => {
    if (e.target.dataset.bukti) openBukti(Number(e.target.dataset.bukti));
  });

  document.querySelectorAll('.vt-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  $('book-select').addEventListener('change', (e) => {
    state.bookId = Number(e.target.value);
    // Filter bulan dipertahankan antar rekening (disimpan di localStorage).
    state.kategori = ''; state.search = ''; state.besarFrom = ''; state.besarTo = '';
    $('search-input').value = ''; $('besar-from').value = ''; $('besar-to').value = '';
    loadData();
  });
  $('month-filter').addEventListener('change', (e) => {
    state.month = e.target.value;
    saveMonth(state.month);
    render();
  });
  // Tombol "+ Bulan": buka pemilih bulan native, lalu masukkan ke filter (termasuk bulan ke depan).
  const addMonthBtn = $('add-month-btn');
  const addMonthPicker = $('add-month-picker');
  if (addMonthBtn && addMonthPicker) {
    addMonthBtn.addEventListener('click', () => {
      addMonthPicker.value = (isYearMonth(state.month) ? state.month : null) || todayISO().slice(0, 7);
      try { addMonthPicker.showPicker(); }
      catch (_) { addMonthPicker.focus(); addMonthPicker.click(); }
    });
    addMonthPicker.addEventListener('change', () => {
      const ym = addMonthPicker.value;
      if (!addExtraMonth(ym)) return;
      state.month = ym;
      saveMonth(ym);
      buildMonthFilter();
      render();
      toast(`Bulan ${labelBulan(ym)} ditambahkan. Silakan catat transaksi.`);
    });
  }
  $('kategori-filter').addEventListener('change', (e) => { state.kategori = e.target.value; render(); });
  let searchTimer;
  $('search-input').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 120); // debounce agar tak render ulang tiap ketukan
  });
  $('besar-from').addEventListener('change', (e) => { state.besarFrom = e.target.value; render(); });
  $('besar-to').addEventListener('change', (e) => { state.besarTo = e.target.value; render(); });
  $('besar-reset').addEventListener('click', () => {
    state.besarFrom = ''; state.besarTo = '';
    $('besar-from').value = ''; $('besar-to').value = '';
    render();
  });

  $('new-book-btn').addEventListener('click', () => openBookModal(null));
  $('theme-btn').addEventListener('click', () => { closeMenu(); toggleTheme(); });
  $('density-btn').addEventListener('click', () => { closeMenu(); toggleDensity(); });
  $('company-btn').addEventListener('click', () => { closeMenu(); openCompanyModal(); });
  $('company-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    saveCompany({
      name: f.name.value.trim() || COMPANY_DEFAULT.name,
      address: f.address.value.trim(),
      npwp: f.npwp.value.trim(),
    });
    closeModals();
    toast('Profil cetak disimpan.');
  });
  $('menu-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); $('toolbar-more-menu').classList.add('hidden'); });
  $('settings-book-btn').addEventListener('click', () => { closeMenu(); openBookModal(curBook()); });
  $('book-delete').addEventListener('click', deleteBook);
  $('transfer-btn').addEventListener('click', openTransfer);
  $('users-btn').addEventListener('click', openUsers);
  $('password-btn').addEventListener('click', openPassword);
  $('backup-btn').addEventListener('click', backupData);
  $('restore-btn').addEventListener('click', openRestore);
  $('audit-btn').addEventListener('click', openAudit);
  $('logout-btn').addEventListener('click', async () => { await api('POST', '/api/auth/logout'); location.reload(); });

  const doPrint = () => { buildPrintReport(); window.print(); };
  $('import-btn').addEventListener('click', openImport);
  $('template-btn').addEventListener('click', downloadTemplate);
  $('export-btn').addEventListener('click', exportCsv);
  $('print-btn').addEventListener('click', doPrint);
  const moreBtn = $('toolbar-more-btn');
  const moreMenu = $('toolbar-more-menu');
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      moreMenu.classList.toggle('hidden');
    });
    $('import-btn-more').addEventListener('click', () => { moreMenu.classList.add('hidden'); openImport(); });
    $('export-btn-more').addEventListener('click', () => { moreMenu.classList.add('hidden'); exportCsv(); });
    $('print-btn-more').addEventListener('click', () => { moreMenu.classList.add('hidden'); doPrint(); });
  }
  window.addEventListener('beforeprint', () => { if (state.user) buildPrintReport(); });

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  // Penampil bukti punya tombol tutup sendiri agar tak menutup modal transaksi di baliknya.
  $('bukti-close').addEventListener('click', closeBukti);
  document.querySelectorAll('.modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target !== m) return;
      if (m.id === 'bukti-modal') closeBukti(); else requestCloseModals();
    }));
  document.addEventListener('click', () => { closeMenu(); if (moreMenu) moreMenu.classList.add('hidden'); });

  $('ana-scope').addEventListener('change', (e) => { state.anaScope = e.target.value; render(); });
  const anaRange = $('ana-range');
  const anaCustom = $('ana-custom-wrap');
  const syncAnaCustom = () => {
    if (anaCustom) anaCustom.classList.toggle('hidden', state.anaRange !== 'custom');
  };
  if (anaRange) {
    anaRange.value = state.anaRange || '12';
    anaRange.addEventListener('change', (e) => {
      state.anaRange = e.target.value || '12';
      syncAnaCustom();
      if (state.view === 'analitik') renderAnalytics();
    });
    syncAnaCustom();
  }
  const anaFrom = $('ana-from'), anaTo = $('ana-to');
  if (anaFrom) anaFrom.addEventListener('change', (e) => {
    state.anaFrom = e.target.value || '';
    if (state.view === 'analitik') renderAnalytics();
  });
  if (anaTo) anaTo.addEventListener('change', (e) => {
    state.anaTo = e.target.value || '';
    if (state.view === 'analitik') renderAnalytics();
  });

  // Penanda "ada perubahan" untuk modal transaksi & rekening.
  $('tx-form').addEventListener('input', () => { modalDirty = true; });
  $('book-form').addEventListener('input', () => { modalDirty = true; });

  // Hapus pengguna dari daftar Kelola Pengguna.
  $('users-list').addEventListener('click', (e) => {
    const id = e.target.dataset.deluser;
    if (!id) return;
    const li = e.target.closest('li');
    deleteUser(Number(id), li ? li.querySelector('.u-name').textContent : '');
  });

  // Pintasan keyboard: Tab dijerat di modal; Esc tutup; "n"/"k" transaksi baru; "/" fokus pencarian.
  document.addEventListener('keydown', (e) => {
    const modalOpen = [...document.querySelectorAll('.modal')].some((m) => !m.classList.contains('hidden'));
    if (e.key === 'Tab' && modalOpen) { trapModalTab(e); return; }
    if (e.key === 'Escape') {
      if (!$('bukti-modal').classList.contains('hidden')) { closeBukti(); return; }
      requestCloseModals(); closeMenu(); return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (modalOpen) return;
    if ($('app-view').classList.contains('hidden')) return;
    if (e.key === 'n' || e.key === 'N') { if (!isAdmin()) return; e.preventDefault(); openTxModal('masuk'); }
    else if (e.key === 'k' || e.key === 'K') { if (!isAdmin()) return; e.preventDefault(); openTxModal('keluar'); }
    else if (e.key === '/' && state.view === 'catatan') { e.preventDefault(); $('search-input').focus(); }
  });
}

// ============================================================
//  ANALITIK (grafik SVG buatan sendiri, tanpa library)
// ============================================================
const PALETTE = ['#1b4b78', '#0f7a4d', '#c2984a', '#7b4fa3', '#0e7c86', '#b3261e', '#5a6b7b', '#3a7d44', '#8a6d3b', '#4a5a8a'];
// Warna grafik mengikuti variabel tema (adaptif gelap/terang), dengan fallback aman.
let C_IN = '#0f7a4d', C_OUT = '#b3261e', C_BAL = '#1b4b78', C_GRID = '#22406a', C_AXIS = '#8ba3c4';
function refreshChartColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  C_IN = v('--in', C_IN);
  C_OUT = v('--out', C_OUT);
  C_BAL = v('--teal', C_BAL);     // garis saldo pakai teal merek
  C_GRID = v('--line-soft', C_GRID);
  C_AXIS = v('--muted', C_AXIS);
}

function singkatRp(n) {
  const f = (x) => x.toFixed(x % 1 === 0 ? 0 : 1).replace('.', ',');
  const a = Math.abs(n);
  if (a >= 1e9) return 'Rp' + f(n / 1e9) + ' M';
  if (a >= 1e6) return 'Rp' + f(n / 1e6) + ' jt';
  if (a >= 1e3) return 'Rp' + f(n / 1e3) + ' rb';
  return 'Rp' + Math.round(n);
}
function bulanChart(ym) { const [y, m] = ym.split('-'); return BULAN_S[Number(m) - 1] + " '" + y.slice(2); }

// Analitik: scope Gabungan (semua rekening) atau satu rekening tertentu (state.anaScope).
function anaScopeId() { return state.anaScope ? Number(state.anaScope) : null; }
function anaTx() {
  const id = anaScopeId();
  return id ? state.allTransactions.filter((t) => t.book_id === id) : state.allTransactions;
}
function anaSaldoAwal() {
  const id = anaScopeId();
  if (id) { const b = state.books.find((x) => x.id === id); return b ? (b.saldo_awal || 0) : 0; }
  return state.books.reduce((s, b) => s + (b.saldo_awal || 0), 0);
}

/** Resolve YYYY-MM from/to dari preset periode analitik. */
function resolveAnaRange() {
  const now = todayISO().slice(0, 7);
  const mode = state.anaRange || '12';
  if (mode === 'all') return { fromYm: '', toYm: '' };
  if (mode === 'custom') {
    let fromYm = state.anaFrom || '';
    let toYm = state.anaTo || '';
    if (fromYm && toYm && fromYm > toYm) { const t = fromYm; fromYm = toYm; toYm = t; }
    return { fromYm, toYm: toYm || fromYm || now };
  }
  const n = mode === '6' ? 6 : 12;
  return { fromYm: shiftMonth(now, -(n - 1)), toYm: now };
}

function anaTxInRange() {
  const { fromYm, toYm } = resolveAnaRange();
  const all = anaTx();
  if (!fromYm && !toYm) return all;
  return all.filter((t) => {
    const ym = t.tanggal.slice(0, 7);
    if (fromYm && ym < fromYm) return false;
    if (toYm && ym > toYm) return false;
    return true;
  });
}

/** Saldo awal efektif untuk grafik saldo: saldo awal buku + transaksi sebelum fromYm. */
function anaSaldoAwalForRange() {
  const base = anaSaldoAwal();
  const { fromYm } = resolveAnaRange();
  if (!fromYm) return base;
  let adj = 0;
  for (const t of anaTx()) {
    if (t.tanggal.slice(0, 7) < fromYm) adj += t.type === 'masuk' ? t.jumlah : -t.jumlah;
  }
  return base + adj;
}

function monthlyAgg() {
  const map = new Map();
  const { fromYm, toYm } = resolveAnaRange();
  // Isi bulan kosong dalam rentang agar grafik kontinu.
  if (fromYm && toYm) {
    for (const ym of monthsBetween(fromYm, toYm)) map.set(ym, { ym, masuk: 0, keluar: 0 });
  }
  for (const t of anaTxInRange()) {
    const ym = t.tanggal.slice(0, 7);
    if (!map.has(ym)) map.set(ym, { ym, masuk: 0, keluar: 0 });
    map.get(ym)[t.type] += t.jumlah;
  }
  return [...map.values()].sort((a, b) => (a.ym < b.ym ? -1 : 1));
}

function renderAnalytics() {
  refreshChartColors();
  const scoped = anaTx();
  const has = scoped.length > 0;
  const emptyEl = $('analytics-empty');
  if (emptyEl) emptyEl.classList.toggle('hidden', has);
  const body = $('analytics-body');
  if (body) body.classList.toggle('hidden', !has);
  // Sinkron input custom
  const wrap = $('ana-custom-wrap');
  if (wrap) wrap.classList.toggle('hidden', state.anaRange !== 'custom');
  const { fromYm, toYm } = resolveAnaRange();
  const af = $('ana-from'), at = $('ana-to');
  if (af && state.anaRange === 'custom' && !af.value && fromYm) af.value = fromYm;
  if (at && state.anaRange === 'custom' && !at.value && toYm) at.value = toYm;

  const periodText = (!fromYm && !toYm) ? 'Seluruh periode'
    : (fromYm === toYm ? labelBulan(fromYm) : `${labelBulan(fromYm)} — ${labelBulan(toYm)}`);
  document.querySelectorAll('.ana-period-label').forEach((el) => { el.textContent = periodText; });

  if (!has) {
    ['compare', 'rekening-summary', 'stat-tiles', 'chart-monthly', 'chart-balance', 'breakdown-keluar', 'breakdown-masuk', 'tax-summary']
      .forEach((id) => { if ($(id)) $(id).innerHTML = ''; });
    return;
  }
  const months = monthlyAgg();
  renderCompare();
  renderRekeningSummary();
  renderTiles(months);
  renderMonthlyChart(months);
  renderBalanceChart(months);
  renderBreakdown('keluar', $('breakdown-keluar'));
  renderBreakdown('masuk', $('breakdown-masuk'));
  ensureTaxMonth();
  renderTaxSummary();
}

const PPN_RATE = 0.11;       // PPN 11%
const PPH_UMKM_RATE = 0.005; // PPh final UMKM 0,5% (perkiraan)

function ensureTaxMonth() {
  const inp = $('tax-month');
  if (!inp) return;
  if (!state.taxMonth) state.taxMonth = todayISO().slice(0, 7);
  if (inp.value !== state.taxMonth) inp.value = state.taxMonth;
}

/** Ringkasan pajak sederhana (bukan e-filing) untuk bulan terpilih di scope analitik. */
function renderTaxSummary() {
  const box = $('tax-summary');
  if (!box) return;
  const ym = state.taxMonth || todayISO().slice(0, 7);
  const tx = anaTx().filter((t) => t.tanggal.slice(0, 7) === ym);
  const dpp = tx.filter((t) => t.type === 'masuk').reduce((s, t) => s + t.jumlah, 0);
  const keluar = tx.filter((t) => t.type === 'keluar').reduce((s, t) => s + t.jumlah, 0);
  // PPN masukan: pengeluaran berkategori mengandung "ppn" / "pajak masuk"
  const ppnMasukan = tx.filter((t) => {
    if (t.type !== 'keluar') return false;
    const k = (t.kategori || '').toLowerCase();
    return /ppn|pajak\s*masuk/.test(k);
  }).reduce((s, t) => s + t.jumlah, 0);
  const ppnKeluaran = Math.round(dpp * PPN_RATE);
  const ppnNet = ppnKeluaran - ppnMasukan;
  const pph = Math.round(dpp * PPH_UMKM_RATE);

  box.innerHTML = `
    <div class="tax-box"><div class="tb-label">DPP / Omzet (pemasukan)</div><div class="tb-value">${rupiah(dpp)}</div>
      <div class="tb-note">${labelBulan(ym)}</div></div>
    <div class="tax-box"><div class="tb-label">Total Pengeluaran</div><div class="tb-value">${rupiah(keluar)}</div></div>
    <div class="tax-box"><div class="tb-label">Estimasi PPN Keluaran 11%</div><div class="tb-value">${rupiah(ppnKeluaran)}</div>
      <div class="tb-note">11% × DPP</div></div>
    <div class="tax-box"><div class="tb-label">PPN Masukan (kategori PPN)</div><div class="tb-value">${rupiah(ppnMasukan)}</div>
      <div class="tb-note">Dari kategori berisi “PPN” / “Pajak Masuk”</div></div>
    <div class="tax-box"><div class="tb-label">PPN Kurang / Lebih Bayar</div><div class="tb-value">${rupiah(ppnNet)}</div>
      <div class="tb-note">${ppnNet >= 0 ? 'Kurang bayar (perkiraan)' : 'Lebih bayar (perkiraan)'}</div></div>
    <div class="tax-box"><div class="tb-label">Estimasi PPh Final 0,5%</div><div class="tb-value">${rupiah(pph)}</div>
      <div class="tb-note">Skema UMKM — sesuaikan bila tarif berbeda</div></div>
    <div class="tax-box wide"><div class="tb-label">Catatan</div>
      <div class="tb-note">Angka ini ringkasan internal dari buku kas. Bukan SPT, bukan e-filing, dan tidak menggantikan perhitungan resmi konsultan pajak.</div></div>`;
}

function renderRekeningSummary() {
  const rows = state.books.map((b) => {
    const tx = state.allTransactions.filter((t) => t.book_id === b.id);
    const masuk = tx.filter((t) => t.type === 'masuk').reduce((s, t) => s + t.jumlah, 0);
    const keluar = tx.filter((t) => t.type === 'keluar').reduce((s, t) => s + t.jumlah, 0);
    const saldo = (b.saldo_awal || 0) + masuk - keluar;
    const ambang = b.ambang_saldo || 0;
    const low = ambang > 0 && saldo < ambang;
    return { name: b.name, bank: b.bank_info, saldo, masuk, keluar, ambang, low };
  });
  $('rekening-summary').innerHTML = rows.map((r) => `
    <div class="rek-row${r.low ? ' rek-low' : ''}">
      <div class="rek-name">${escapeHtml(r.name)}${r.bank ? ` <span class="muted">· ${escapeHtml(r.bank)}</span>` : ''}${r.low ? '<span class="rek-badge">Saldo rendah</span>' : ''}</div>
      <div class="rek-nums">
        <span class="rek-in">+${rupiah(r.masuk)}</span>
        <span class="rek-out">−${rupiah(r.keluar)}</span>
        <span class="rek-saldo">${rupiah(r.saldo)}</span>
      </div>
    </div>`).join('');
}

function prevMonth(ym) {
  let [y, m] = ym.split('-').map(Number);
  m--; if (m < 1) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
function renderCompare() {
  const now = todayISO().slice(0, 7), prev = prevMonth(now);
  const agg = (ym) => {
    let masuk = 0, keluar = 0;
    for (const t of anaTx()) if (t.tanggal.slice(0, 7) === ym) { if (t.type === 'masuk') masuk += t.jumlah; else keluar += t.jumlah; }
    return { masuk, keluar };
  };
  const a = agg(now), b = agg(prev);
  const items = [
    { label: 'Pemasukan', now: a.masuk, prev: b.masuk, goodUp: true },
    { label: 'Pengeluaran', now: a.keluar, prev: b.keluar, goodUp: false },
    { label: 'Selisih (Net)', now: a.masuk - a.keluar, prev: b.masuk - b.keluar, goodUp: true },
  ];
  const title = $('compare-title');
  if (title) title.textContent = `${labelBulan(now)} vs ${labelBulan(prev)}`;
  $('compare').innerHTML = items.map((it) => {
    const diff = it.now - it.prev;
    const pct = it.prev !== 0 ? Math.round((diff / Math.abs(it.prev)) * 100) : (it.now !== 0 ? 100 : 0);
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '→';
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
    const cls = diff === 0 ? 'cmp-flat' : (diff > 0) === it.goodUp ? 'cmp-up' : 'cmp-down';
    const delta = `${arrow} ${sign}${rupiah(Math.abs(diff))}${it.prev !== 0 ? ` (${sign}${Math.abs(pct)}%)` : ''}`;
    return `<div class="cmp"><div class="cmp-label">${it.label}</div><div class="cmp-value">${rupiah(it.now)}</div><div class="cmp-delta ${cls}">${delta}</div></div>`;
  }).join('');
}
function renderTiles(months) {
  const active = months.filter((m) => m.masuk || m.keluar);
  const n = active.length || 1;
  const totalMasuk = months.reduce((s, m) => s + m.masuk, 0);
  const totalKeluar = months.reduce((s, m) => s + m.keluar, 0);
  const avgMasuk = totalMasuk / n, avgKeluar = totalKeluar / n, avgNet = avgMasuk - avgKeluar;
  const ranged = anaTxInRange();
  let big = ranged[0];
  for (const t of ranged) if (t.jumlah > big.jumlah) big = t;
  const bigSub = big
    ? ((big.type === 'masuk' ? 'Pemasukan' : 'Pengeluaran') + (big.keterangan ? ' · ' + big.keterangan : ''))
    : '—';
  const tiles = [
    { label: 'Rata-rata Pemasukan / bulan', value: rupiah(avgMasuk), sub: `dari ${active.length} bulan aktif`, cls: 'pos' },
    { label: 'Rata-rata Pengeluaran / bulan', value: rupiah(avgKeluar), sub: `dari ${active.length} bulan aktif`, cls: 'neg' },
    { label: 'Rata-rata Sisa / bulan', value: rupiah(avgNet), sub: avgNet >= 0 ? 'surplus' : 'defisit', cls: avgNet >= 0 ? 'pos' : 'neg' },
    { label: 'Transaksi Terbesar', value: big ? rupiah(big.jumlah) : 'Rp0', sub: bigSub, cls: big && big.type === 'masuk' ? 'pos' : 'neg' },
  ];
  $('stat-tiles').innerHTML = tiles.map((t) =>
    `<div class="tile"><span class="tile-label">${t.label}</span><span class="tile-value ${t.cls}">${t.value}</span><span class="tile-sub">${escapeHtml(t.sub)}</span></div>`).join('');
}
function renderMonthlyChart(months) {
  if (!months.length) { $('chart-monthly').innerHTML = '<p class="breakdown-empty">Belum ada data periode.</p>'; return; }
  const H = 280, padL = 58, padR = 12, padT = 12, padB = 34, plotH = H - padT - padB;
  const groupW = Math.max(52, Math.min(120, 640 / months.length));
  const W = Math.round(padL + padR + groupW * months.length);
  const max = Math.max(1, ...months.map((m) => Math.max(m.masuk, m.keluar)));
  const y = (v) => padT + plotH * (1 - v / max);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Grafik pemasukan dan pengeluaran per bulan">`;
  for (let i = 0; i <= 4; i++) {
    const val = (max / 4) * i, yy = y(val);
    svg += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="${C_GRID}" />`;
    svg += `<text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${C_AXIS}">${singkatRp(val)}</text>`;
  }
  months.forEach((m, i) => {
    const cx = padL + groupW * i + groupW / 2, bw = groupW * 0.32, gap = groupW * 0.06;
    svg += `<rect x="${(cx - bw - gap / 2).toFixed(1)}" y="${y(m.masuk).toFixed(1)}" width="${bw.toFixed(1)}" height="${(plotH * m.masuk / max).toFixed(1)}" rx="3" fill="${C_IN}"><title>${bulanChart(m.ym)} — Pemasukan ${rupiah(m.masuk)}</title></rect>`;
    svg += `<rect x="${(cx + gap / 2).toFixed(1)}" y="${y(m.keluar).toFixed(1)}" width="${bw.toFixed(1)}" height="${(plotH * m.keluar / max).toFixed(1)}" rx="3" fill="${C_OUT}"><title>${bulanChart(m.ym)} — Pengeluaran ${rupiah(m.keluar)}</title></rect>`;
    svg += `<text x="${cx.toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="${C_AXIS}">${bulanChart(m.ym)}</text>`;
  });
  $('chart-monthly').innerHTML = svg + '</svg>';
}
function renderBalanceChart(months) {
  if (!months.length) { $('chart-balance').innerHTML = '<p class="breakdown-empty">Belum ada data periode.</p>'; return; }
  const H = 240, padL = 58, padR = 34, padT = 16, padB = 30, plotH = H - padT - padB;
  let cum = anaSaldoAwalForRange();
  const pts = months.map((m) => ({ ym: m.ym, v: (cum += m.masuk - m.keluar) }));
  const step = pts.length > 1 ? Math.max(50, Math.min(120, 620 / (pts.length - 1))) : 0;
  const innerW = pts.length > 1 ? step * (pts.length - 1) : 360;
  const W = Math.round(padL + padR + innerW);
  const vals = pts.map((p) => p.v);
  const minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals, 1), range = maxV - minV || 1;
  const x = (i) => (pts.length > 1 ? padL + step * i : padL + innerW / 2);
  const y = (v) => padT + plotH * (1 - (v - minV) / range);
  const y0 = y(0);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Grafik saldo berjalan">`;
  svg += `<line x1="${padL}" y1="${y0.toFixed(1)}" x2="${W - padR}" y2="${y0.toFixed(1)}" stroke="${C_GRID}" stroke-dasharray="4 4" />`;
  svg += `<text x="${padL - 8}" y="${(y0 + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${C_AXIS}">Rp0</text>`;
  svg += `<text x="${padL - 8}" y="${(y(maxV) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${C_AXIS}">${singkatRp(maxV)}</text>`;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  svg += `<path d="${line} L${x(pts.length - 1).toFixed(1)},${y0.toFixed(1)} L${x(0).toFixed(1)},${y0.toFixed(1)} Z" fill="${C_BAL}" opacity="0.12" />`;
  svg += `<path d="${line}" fill="none" stroke="${C_BAL}" stroke-width="2.5" stroke-linejoin="round" />`;
  pts.forEach((p, i) => {
    svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" fill="${C_BAL}"><title>${bulanChart(p.ym)} — Saldo ${rupiah(p.v)}</title></circle>`;
    svg += `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="${C_AXIS}">${bulanChart(p.ym)}</text>`;
  });
  $('chart-balance').innerHTML = svg + '</svg>';
}
function renderBreakdown(type, container) {
  const map = new Map();
  for (const t of anaTxInRange()) {
    if (t.type !== type) continue;
    const k = t.kategori || 'Tanpa kategori';
    map.set(k, (map.get(k) || 0) + t.jumlah);
  }
  let arr = [...map.entries()].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
  if (arr.length === 0) { container.innerHTML = `<p class="breakdown-empty">Belum ada data.</p>`; return; }
  const total = arr.reduce((s, x) => s + x.v, 0);
  if (arr.length > 8) { const rest = arr.slice(7).reduce((s, x) => s + x.v, 0); arr = arr.slice(0, 7).concat({ k: 'Lainnya', v: rest }); }
  const max = arr[0].v || 1;
  container.innerHTML = arr.map((x, i) => {
    const pct = total ? Math.round((x.v / total) * 100) : 0;
    const w = ((x.v / max) * 100).toFixed(1);
    return `<div class="bd-row"><div class="bd-top"><span class="bd-name">${escapeHtml(x.k)}</span><span class="bd-amt">${rupiah(x.v)} · ${pct}%</span></div><div class="bd-track"><div class="bd-fill" style="width:${w}%;background:${PALETTE[i % PALETTE.length]}"></div></div></div>`;
  }).join('');
}

// Mulai
boot();
