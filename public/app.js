'use strict';

/* ============================================================
   Sistem Pencatatan Keuangan — PT Sintesa Data Semesta
   Frontend tanpa framework/build.
   ============================================================ */

// ---------- Util ----------
const $ = (id) => document.getElementById(id);
const rupiah = (n) => 'Rp' + new Intl.NumberFormat('id-ID').format(Math.round(n || 0));
const BULAN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const BULAN_S = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];

function tanggalIndo(iso) {
  const [y, m, d] = iso.split('-');
  return `${d} ${BULAN_S[Number(m) - 1]} ${y}`;
}
function labelBulan(ym) { const [y, m] = ym.split('-'); return `${BULAN[Number(m) - 1]} ${y}`; }
function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function pad2(n) { return String(n).padStart(2, '0'); }
function formatMoneyInput(e) {
  const d = e.target.value.replace(/\D/g, '');
  e.target.value = d ? new Intl.NumberFormat('id-ID').format(Number(d)) : '';
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
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
  transactions: [],
  month: '',
  kategori: '',
  search: '',
  besarFrom: '',
  besarTo: '',
  view: 'catatan', // 'catatan' | 'besar' | 'analitik'
};

// ---------- Tema (gelap default = "cyber", terang opsional) ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('theme-btn');
  if (btn) btn.textContent = t === 'light' ? '☀️' : '🌙';
  try { localStorage.setItem('sintesa_theme', t); } catch (_) {}
}
function initTheme() { applyTheme(localStorage.getItem('sintesa_theme') === 'light' ? 'light' : 'dark'); }
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
}
function startClock() {
  const tick = () => {
    const el = $('sr-clock');
    if (el) el.textContent = new Date().toLocaleTimeString('id-ID', { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}
const curBook = () => state.books.find((b) => b.id === state.bookId) || null;

// ============================================================
//  AUTH
// ============================================================
async function boot() {
  $('year').textContent = new Date().getFullYear();
  initTheme();
  startClock();
  wireStaticHandlers();
  try {
    const status = await api('GET', '/api/auth/status');
    if (status.authenticated) { state.user = status.user; await enterApp(); }
    else showAuth();
  } catch (e) { showAuth(); }
}
function showAuth() { $('app-view').classList.add('hidden'); $('auth-view').classList.remove('hidden'); }

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
  $('menu-user').textContent = 'Masuk sebagai ' + state.user.name;
  $('sr-user').textContent = state.user.name.toUpperCase();
  await loadBooks();
}

async function loadBooks() {
  const { books } = await api('GET', '/api/books');
  state.books = books;
  if (books.length === 0) {
    const { book } = await api('POST', '/api/books', { name: 'Kas Utama' });
    state.books = [book];
  }
  const remembered = Number(localStorage.getItem('sintesa_book'));
  const found = state.books.find((b) => b.id === remembered);
  state.bookId = found ? found.id : state.books[0].id;
  renderBookSelect();
  await loadTransactions();
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

async function loadTransactions() {
  localStorage.setItem('sintesa_book', String(state.bookId));
  const { transactions } = await api('GET', `/api/books/${state.bookId}/transactions`);
  state.transactions = transactions;
  buildMonthFilter();
  render();
}

function buildMonthFilter() {
  const months = [...new Set(state.transactions.map((t) => t.tanggal.slice(0, 7)))].sort().reverse();
  const sel = $('month-filter');
  const current = state.month;
  sel.innerHTML = '<option value="">Semua bulan</option>';
  for (const m of months) {
    const o = document.createElement('option');
    o.value = m; o.textContent = labelBulan(m);
    sel.appendChild(o);
  }
  sel.value = months.includes(current) ? current : '';
  state.month = sel.value;
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
  const saldoAwal = book ? book.saldo_awal : 0;
  const totalMasuk = state.transactions.filter((t) => t.type === 'masuk').reduce((s, t) => s + t.jumlah, 0);
  const totalKeluar = state.transactions.filter((t) => t.type === 'keluar').reduce((s, t) => s + t.jumlah, 0);

  $('sum-masuk').textContent = rupiah(totalMasuk);
  $('sum-keluar').textContent = rupiah(totalKeluar);
  $('sum-sisa').textContent = rupiah(saldoAwal + totalMasuk - totalKeluar);
  renderBookInfo(book, saldoAwal);

  const rows = visibleTx();
  renderColumn('masuk', rows.filter((t) => t.type === 'masuk'));
  renderColumn('keluar', rows.filter((t) => t.type === 'keluar'));
  updateKategoriList();

  if (state.view === 'besar') renderBukuBesar();
  if (state.view === 'analitik') renderAnalytics();
  buildPrint(book, saldoAwal, totalMasuk, totalKeluar);
}

function renderBookInfo(book, saldoAwal) {
  const parts = [`<span class="bi-name">${escapeHtml(book ? book.name : '')}</span>`];
  parts.push(`<span class="bi-item">Saldo Awal: <b>${rupiah(saldoAwal)}</b></span>`);
  if (book && book.bank_info) parts.push(`<span class="bi-item">Rekening: <b>${escapeHtml(book.bank_info)}</b></span>`);
  parts.push(`<span class="bi-item">Jumlah transaksi: <b>${state.transactions.length}</b></span>`);
  $('book-info').innerHTML = parts.join('');
}

function renderColumn(type, list) {
  const tbody = $('tbody-' + type);
  tbody.innerHTML = '';
  if (list.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Belum ada data</td></tr>`;
  } else {
    list.forEach((t, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="c-no">${i + 1}</td>
        <td class="c-date">${tanggalIndo(t.tanggal)}</td>
        <td class="c-amt">${rupiah(t.jumlah)}</td>
        <td>${escapeHtml(t.keterangan) || '<span class="muted">—</span>'}${t.kategori ? ` <span class="muted">· ${escapeHtml(t.kategori)}</span>` : ''}${t.has_bukti ? ` <button type="button" class="bukti-chip" data-bukti="${t.id}" title="Lihat bukti">📎 bukti</button>` : ''}</td>
        <td class="c-act"><div class="row-actions">
          <button class="icon-btn" title="Ubah" data-edit="${t.id}">✎</button>
          <button class="icon-btn" title="Hapus" data-del="${t.id}">🗑</button>
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
function computeBesar() {
  const book = curBook();
  const saldoAwal = book ? book.saldo_awal : 0;
  const sorted = [...state.transactions].sort((a, b) =>
    a.tanggal < b.tanggal ? -1 : a.tanggal > b.tanggal ? 1 : a.id - b.id);
  const { besarFrom: from, besarTo: to } = state;
  let opening = saldoAwal;
  for (const t of sorted) if (from && t.tanggal < from) opening += t.type === 'masuk' ? t.jumlah : -t.jumlah;
  let running = opening, tMasuk = 0, tKeluar = 0;
  const rows = [];
  for (const t of sorted) {
    if (from && t.tanggal < from) continue;
    if (to && t.tanggal > to) continue;
    running += t.type === 'masuk' ? t.jumlah : -t.jumlah;
    if (t.type === 'masuk') tMasuk += t.jumlah; else tKeluar += t.jumlah;
    rows.push({ id: t.id, has_bukti: t.has_bukti, tanggal: t.tanggal, keterangan: t.keterangan, kategori: t.kategori,
      masuk: t.type === 'masuk' ? t.jumlah : 0, keluar: t.type === 'keluar' ? t.jumlah : 0, saldo: running });
  }
  return { saldoAwal, opening, rows, tMasuk, tKeluar, saldoAkhir: running, from, to };
}

function renderBukuBesar() {
  const d = computeBesar();
  const tbody = $('tbody-besar');
  const openLabel = d.from ? `Saldo Awal per ${tanggalIndo(d.from)}` : 'SALDO AWAL';
  let html = `<tr class="opening"><td></td><td></td><td>${openLabel}</td><td class="c-amt"></td><td class="c-amt"></td><td class="c-amt r-saldo">${rupiah(d.opening)}</td></tr>`;
  if (d.rows.length === 0) {
    html += `<tr class="empty-row"><td colspan="6">Belum ada transaksi pada rentang ini</td></tr>`;
  } else {
    d.rows.forEach((r, i) => {
      const ket = escapeHtml(r.keterangan) + (r.kategori ? ` <span class="muted">· ${escapeHtml(r.kategori)}</span>` : '')
        + (r.has_bukti ? ` <button type="button" class="bukti-chip" data-bukti="${r.id}" title="Lihat bukti">📎</button>` : '');
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
  document.querySelectorAll('.vt-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('ledger-view').classList.toggle('hidden', view !== 'catatan');
  $('besar-view').classList.toggle('hidden', view !== 'besar');
  $('analytics-view').classList.toggle('hidden', view !== 'analitik');
  $('tools-catatan').classList.toggle('hidden', view !== 'catatan');
  $('tools-besar').classList.toggle('hidden', view !== 'besar');
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
function showBukti(dataUrl) {
  const area = $('bukti-view-area'), dl = $('bukti-download');
  dl.href = dataUrl;
  if (dataUrl.startsWith('data:application/pdf')) {
    dl.download = 'bukti.pdf';
    area.innerHTML = `<p class="muted">Bukti berupa dokumen PDF. Klik "Unduh" untuk membukanya.</p>`;
  } else {
    dl.download = 'bukti.jpg';
    area.innerHTML = `<img src="${dataUrl}" alt="Bukti transaksi" class="bukti-img" />`;
  }
  $('bukti-modal').classList.remove('hidden');
}
async function openBukti(id) {
  try {
    const { bukti } = await api('GET', `/api/transactions/${id}/bukti`);
    showBukti(bukti);
  } catch (err) { toast(err.message, true); }
}
function closeBukti() { $('bukti-modal').classList.add('hidden'); }

// ============================================================
//  MODAL TRANSAKSI
// ============================================================
function openTxModal(type, tx) {
  const f = $('tx-form');
  f.reset();
  $('tx-error').textContent = '';
  $('bukti-file').value = '';
  f.type.value = type;
  f.id.value = tx ? tx.id : '';
  f.tanggal.value = tx ? tx.tanggal : todayISO();
  f.jumlah.value = tx ? new Intl.NumberFormat('id-ID').format(tx.jumlah) : '';
  f.keterangan.value = tx ? tx.keterangan : '';
  f.kategori.value = tx ? tx.kategori : '';
  buktiState = { data: null, changed: false, hasExisting: !!(tx && tx.has_bukti), txId: tx ? tx.id : null };
  updateBuktiStatus();
  const label = type === 'masuk' ? 'Pemasukan' : 'Pengeluaran';
  $('tx-modal-title').textContent = (tx ? 'Ubah ' : 'Tambah ') + label;
  $('tx-submit').textContent = tx ? 'Simpan Perubahan' : 'Simpan';
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
  $('tx-error').textContent = '';
  const payload = {
    type: f.type.value, tanggal: f.tanggal.value,
    jumlah: f.jumlah.value.replace(/\D/g, ''),
    keterangan: f.keterangan.value, kategori: f.kategori.value,
  };
  if (!payload.jumlah) { $('tx-error').textContent = 'Jumlah wajib diisi.'; return; }
  // Sertakan "bukti" hanya bila diubah (data URL baru, atau null bila dihapus).
  if (buktiState.changed) payload.bukti = buktiState.data;
  try {
    if (f.id.value) { await api('PATCH', `/api/transactions/${f.id.value}`, payload); toast('Transaksi diperbarui.'); }
    else { await api('POST', `/api/books/${state.bookId}/transactions`, payload); toast('Transaksi ditambahkan.'); }
    closeModals();
    await loadTransactions();
  } catch (err) { $('tx-error').textContent = err.message; }
});

// ============================================================
//  PENGATURAN / BUKU
// ============================================================
function openBookModal(book) {
  const f = $('book-form');
  f.reset();
  $('book-error').textContent = '';
  f.id.value = book ? book.id : '';
  f.name.value = book ? book.name : '';
  f.saldo_awal.value = book && book.saldo_awal ? new Intl.NumberFormat('id-ID').format(book.saldo_awal) : '';
  f.bank_info.value = book ? book.bank_info || '' : '';
  $('book-modal-title').textContent = book ? 'Pengaturan Buku' : 'Buku Kas Baru';
  $('book-modal').classList.remove('hidden');
  setTimeout(() => f.name.focus(), 50);
}
$('book-form').saldo_awal.addEventListener('input', formatMoneyInput);
$('book-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('book-error').textContent = '';
  const payload = { name: f.name.value, saldo_awal: f.saldo_awal.value.replace(/\D/g, ''), bank_info: f.bank_info.value };
  try {
    if (f.id.value) { await api('PATCH', `/api/books/${f.id.value}`, payload); toast('Buku diperbarui.'); }
    else { const { book } = await api('POST', '/api/books', payload); state.bookId = book.id; toast('Buku dibuat.'); }
    closeModals();
    await loadBooks();
  } catch (err) { $('book-error').textContent = err.message; }
});

async function deleteBook() {
  if (state.books.length <= 1) return toast('Minimal harus ada satu buku.', true);
  const book = curBook();
  if (!confirm(`Hapus buku "${book.name}" beserta SEMUA transaksinya? Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    await api('DELETE', `/api/books/${state.bookId}`);
    localStorage.removeItem('sintesa_book');
    state.bookId = null;
    await loadBooks();
    toast('Buku dihapus.');
  } catch (err) { toast(err.message, true); }
}

// ============================================================
//  PENGGUNA
// ============================================================
async function openUsers() {
  closeMenu();
  try {
    const { users } = await api('GET', '/api/auth/users');
    $('users-list').innerHTML = users.map((u) =>
      `<li><span>${escapeHtml(u.name)}</span><span class="u-username">@${escapeHtml(u.username)}</span></li>`).join('');
    $('add-user-error').textContent = '';
    $('add-user-form').reset();
    $('users-modal').classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
}
$('add-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('add-user-error').textContent = '';
  try {
    await api('POST', '/api/auth/register', { name: f.name.value, username: f.username.value, password: f.password.value });
    toast('Pengguna ditambahkan.');
    await openUsers();
  } catch (err) { $('add-user-error').textContent = err.message; }
});

// ---------- Ganti password ----------
function openPassword() {
  closeMenu();
  $('password-form').reset();
  $('password-error').textContent = '';
  $('password-modal').classList.remove('hidden');
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

// ============================================================
//  IMPOR CSV
// ============================================================
function openImport() {
  closeMenu();
  $('import-error').textContent = '';
  $('import-result').textContent = '';
  $('import-file').value = '';
  $('import-modal').classList.remove('hidden');
}
function parseCsv(text) {
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
function normDate(s) {
  s = String(s).trim();
  let m;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if ((m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/))) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  if ((m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/))) return `20${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  if ((m = s.match(/^(\d{1,2})[\-\s]([A-Za-z]{3,})[\-\s](\d{2,4})$/))) {
    const mo = monthNum(m[2]); if (!mo) return '';
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${pad2(mo)}-${pad2(m[1])}`;
  }
  return '';
}
function rowsToTransactions(rows) {
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
    const jumlah = get('jumlah').replace(/[^\d]/g, '');
    if (!type || !tanggal || !jumlah) continue;
    out.push({ type, tanggal, jumlah, keterangan: get('keterangan'), kategori: get('kategori') });
  }
  return out;
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
    await loadTransactions();
  } catch (err) { $('import-result').textContent = ''; $('import-error').textContent = err.message; }
});
function downloadTemplate() {
  const csv = 'Jenis,Tanggal,Jumlah,Keterangan,Kategori\r\nPemasukan,2026-07-01,8000000,Contoh pemasukan,Proyek\r\nPengeluaran,2026-07-02,1100000,Contoh pengeluaran,Operasional\r\n';
  downloadBlob('﻿' + csv, 'template-impor-kas.csv');
}

// ============================================================
//  EKSPOR & CETAK
// ============================================================
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: (mime || 'text/csv') + ';charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
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
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function buildPrint(book, saldoAwal, totalMasuk, totalKeluar) {
  const viewName = state.view === 'besar' ? 'Buku Besar' : state.view === 'analitik' ? 'Analitik' : 'Catatan Kas';
  let periode = 'Semua periode';
  if (state.view === 'besar') {
    const d = computeBesar();
    if (d.from || d.to) periode = `${d.from ? tanggalIndo(d.from) : 'awal'} — ${d.to ? tanggalIndo(d.to) : 'kini'}`;
  } else if (state.month) periode = labelBulan(state.month);
  $('print-head').innerHTML = `
    <div class="ph-company">PT SINTESA DATA SEMESTA</div>
    <div class="ph-sub">Sistem Pencatatan Keuangan${book && book.bank_info ? ' · ' + escapeHtml(book.bank_info) : ''}</div>
    <div class="ph-title">Laporan ${viewName} — ${escapeHtml(book ? book.name : '')}</div>
    <div class="ph-meta">Periode: ${periode} · Dicetak: ${tanggalIndo(todayISO())}</div>`;
  $('print-foot').innerHTML = `<div class="sign">Mengetahui,<div class="sign-line">${escapeHtml(state.user ? state.user.name : '')}</div></div>`;
}

// ============================================================
//  MENU & HANDLER
// ============================================================
function toggleMenu() { $('menu-dropdown').classList.toggle('hidden'); }
function closeMenu() { $('menu-dropdown').classList.add('hidden'); }
function closeModals() {
  ['tx-modal', 'book-modal', 'import-modal', 'users-modal', 'password-modal'].forEach((id) => $(id).classList.add('hidden'));
}

function wireStaticHandlers() {
  document.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', () => openTxModal(btn.dataset.add)));

  $('ledger-view').addEventListener('click', async (e) => {
    const buktiId = e.target.dataset.bukti, editId = e.target.dataset.edit, delId = e.target.dataset.del;
    if (buktiId) { openBukti(Number(buktiId)); return; }
    if (editId) {
      const tx = state.transactions.find((t) => t.id === Number(editId));
      if (tx) openTxModal(tx.type, tx);
    } else if (delId) {
      if (!confirm('Hapus transaksi ini?')) return;
      try { await api('DELETE', `/api/transactions/${delId}`); toast('Transaksi dihapus.'); await loadTransactions(); }
      catch (err) { toast(err.message, true); }
    }
  });
  $('besar-view').addEventListener('click', (e) => {
    if (e.target.dataset.bukti) openBukti(Number(e.target.dataset.bukti));
  });

  document.querySelectorAll('.vt-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  $('book-select').addEventListener('change', (e) => {
    state.bookId = Number(e.target.value);
    state.month = ''; state.kategori = ''; state.search = ''; state.besarFrom = ''; state.besarTo = '';
    $('search-input').value = ''; $('besar-from').value = ''; $('besar-to').value = '';
    loadTransactions();
  });
  $('month-filter').addEventListener('change', (e) => { state.month = e.target.value; render(); });
  $('kategori-filter').addEventListener('change', (e) => { state.kategori = e.target.value; render(); });
  $('search-input').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('besar-from').addEventListener('change', (e) => { state.besarFrom = e.target.value; render(); });
  $('besar-to').addEventListener('change', (e) => { state.besarTo = e.target.value; render(); });
  $('besar-reset').addEventListener('click', () => {
    state.besarFrom = ''; state.besarTo = '';
    $('besar-from').value = ''; $('besar-to').value = '';
    render();
  });

  $('new-book-btn').addEventListener('click', () => openBookModal(null));
  $('theme-btn').addEventListener('click', toggleTheme);
  $('menu-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  $('settings-book-btn').addEventListener('click', () => { closeMenu(); openBookModal(curBook()); });
  $('delete-book-btn').addEventListener('click', () => { closeMenu(); deleteBook(); });
  $('users-btn').addEventListener('click', openUsers);
  $('password-btn').addEventListener('click', openPassword);
  $('backup-btn').addEventListener('click', backupData);
  $('logout-btn').addEventListener('click', async () => { await api('POST', '/api/auth/logout'); location.reload(); });

  $('import-btn').addEventListener('click', openImport);
  $('template-btn').addEventListener('click', downloadTemplate);
  $('export-btn').addEventListener('click', exportCsv);
  $('print-btn').addEventListener('click', () => window.print());

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  // Penampil bukti punya tombol tutup sendiri agar tak menutup modal transaksi di baliknya.
  $('bukti-close').addEventListener('click', closeBukti);
  document.querySelectorAll('.modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target !== m) return;
      if (m.id === 'bukti-modal') closeBukti(); else closeModals();
    }));
  document.addEventListener('click', () => closeMenu());

  // Pintasan keyboard: Esc tutup; "n" transaksi baru; "/" fokus pencarian.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('bukti-modal').classList.contains('hidden')) { closeBukti(); return; }
      closeModals(); closeMenu(); return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if ([...document.querySelectorAll('.modal')].some((m) => !m.classList.contains('hidden'))) return;
    if ($('app-view').classList.contains('hidden')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openTxModal('masuk'); }
    else if (e.key === '/' && state.view === 'catatan') { e.preventDefault(); $('search-input').focus(); }
  });
}

// ============================================================
//  ANALITIK (grafik SVG buatan sendiri, tanpa library)
// ============================================================
const PALETTE = ['#1b4b78', '#0f7a4d', '#c2984a', '#7b4fa3', '#0e7c86', '#b3261e', '#5a6b7b', '#3a7d44', '#8a6d3b', '#4a5a8a'];
const C_IN = '#0f7a4d', C_OUT = '#b3261e', C_BAL = '#1b4b78';

function singkatRp(n) {
  const f = (x) => x.toFixed(x % 1 === 0 ? 0 : 1).replace('.', ',');
  const a = Math.abs(n);
  if (a >= 1e9) return 'Rp' + f(n / 1e9) + ' M';
  if (a >= 1e6) return 'Rp' + f(n / 1e6) + ' jt';
  if (a >= 1e3) return 'Rp' + f(n / 1e3) + ' rb';
  return 'Rp' + Math.round(n);
}
function bulanChart(ym) { const [y, m] = ym.split('-'); return BULAN_S[Number(m) - 1] + " '" + y.slice(2); }
function monthlyAgg() {
  const map = new Map();
  for (const t of state.transactions) {
    const ym = t.tanggal.slice(0, 7);
    if (!map.has(ym)) map.set(ym, { ym, masuk: 0, keluar: 0 });
    map.get(ym)[t.type] += t.jumlah;
  }
  return [...map.values()].sort((a, b) => (a.ym < b.ym ? -1 : 1));
}

function renderAnalytics() {
  const has = state.transactions.length > 0;
  $('analytics-empty').classList.toggle('hidden', has);
  const ids = ['compare', 'stat-tiles', 'chart-monthly', 'chart-balance', 'breakdown-keluar', 'breakdown-masuk'];
  if (!has) { ids.forEach((id) => ($(id).innerHTML = '')); return; }
  const months = monthlyAgg();
  renderCompare();
  renderTiles(months);
  renderMonthlyChart(months);
  renderBalanceChart(months);
  renderBreakdown('keluar', $('breakdown-keluar'));
  renderBreakdown('masuk', $('breakdown-masuk'));
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
    for (const t of state.transactions) if (t.tanggal.slice(0, 7) === ym) { if (t.type === 'masuk') masuk += t.jumlah; else keluar += t.jumlah; }
    return { masuk, keluar };
  };
  const a = agg(now), b = agg(prev);
  const items = [
    { label: 'Pemasukan', now: a.masuk, prev: b.masuk, goodUp: true },
    { label: 'Pengeluaran', now: a.keluar, prev: b.keluar, goodUp: false },
    { label: 'Selisih (Net)', now: a.masuk - a.keluar, prev: b.masuk - b.keluar, goodUp: true },
  ];
  const title = document.querySelector('.compare-wrap h3');
  if (title) title.textContent = `Bulan Ini (${labelBulan(now)}) vs Bulan Lalu (${labelBulan(prev)})`;
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
  const n = months.length;
  const totalMasuk = months.reduce((s, m) => s + m.masuk, 0);
  const totalKeluar = months.reduce((s, m) => s + m.keluar, 0);
  const avgMasuk = totalMasuk / n, avgKeluar = totalKeluar / n, avgNet = avgMasuk - avgKeluar;
  let big = state.transactions[0];
  for (const t of state.transactions) if (t.jumlah > big.jumlah) big = t;
  const bigSub = (big.type === 'masuk' ? 'Pemasukan' : 'Pengeluaran') + (big.keterangan ? ' · ' + big.keterangan : '');
  const tiles = [
    { label: 'Rata-rata Pemasukan / bulan', value: rupiah(avgMasuk), sub: `dari ${n} bulan aktif`, cls: 'pos' },
    { label: 'Rata-rata Pengeluaran / bulan', value: rupiah(avgKeluar), sub: `dari ${n} bulan aktif`, cls: 'neg' },
    { label: 'Rata-rata Sisa / bulan', value: rupiah(avgNet), sub: avgNet >= 0 ? 'surplus' : 'defisit', cls: avgNet >= 0 ? 'pos' : 'neg' },
    { label: 'Transaksi Terbesar', value: rupiah(big.jumlah), sub: bigSub, cls: big.type === 'masuk' ? 'pos' : 'neg' },
  ];
  $('stat-tiles').innerHTML = tiles.map((t) =>
    `<div class="tile"><span class="tile-label">${t.label}</span><span class="tile-value ${t.cls}">${t.value}</span><span class="tile-sub">${escapeHtml(t.sub)}</span></div>`).join('');
}
function renderMonthlyChart(months) {
  const H = 280, padL = 58, padR = 12, padT = 12, padB = 34, plotH = H - padT - padB;
  const groupW = Math.max(52, Math.min(120, 640 / months.length));
  const W = Math.round(padL + padR + groupW * months.length);
  const max = Math.max(1, ...months.map((m) => Math.max(m.masuk, m.keluar)));
  const y = (v) => padT + plotH * (1 - v / max);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Grafik pemasukan dan pengeluaran per bulan">`;
  for (let i = 0; i <= 4; i++) {
    const val = (max / 4) * i, yy = y(val);
    svg += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="#eef1f6" />`;
    svg += `<text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#667085">${singkatRp(val)}</text>`;
  }
  months.forEach((m, i) => {
    const cx = padL + groupW * i + groupW / 2, bw = groupW * 0.32, gap = groupW * 0.06;
    svg += `<rect x="${(cx - bw - gap / 2).toFixed(1)}" y="${y(m.masuk).toFixed(1)}" width="${bw.toFixed(1)}" height="${(plotH * m.masuk / max).toFixed(1)}" rx="3" fill="${C_IN}"><title>${bulanChart(m.ym)} — Pemasukan ${rupiah(m.masuk)}</title></rect>`;
    svg += `<rect x="${(cx + gap / 2).toFixed(1)}" y="${y(m.keluar).toFixed(1)}" width="${bw.toFixed(1)}" height="${(plotH * m.keluar / max).toFixed(1)}" rx="3" fill="${C_OUT}"><title>${bulanChart(m.ym)} — Pengeluaran ${rupiah(m.keluar)}</title></rect>`;
    svg += `<text x="${cx.toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#667085">${bulanChart(m.ym)}</text>`;
  });
  $('chart-monthly').innerHTML = svg + '</svg>';
}
function renderBalanceChart(months) {
  const H = 240, padL = 58, padR = 34, padT = 16, padB = 30, plotH = H - padT - padB;
  const saldoAwal = curBook() ? curBook().saldo_awal : 0;
  let cum = saldoAwal;
  const pts = months.map((m) => ({ ym: m.ym, v: (cum += m.masuk - m.keluar) }));
  const step = pts.length > 1 ? Math.max(50, Math.min(120, 620 / (pts.length - 1))) : 0;
  const innerW = pts.length > 1 ? step * (pts.length - 1) : 360;
  const W = Math.round(padL + padR + innerW);
  const vals = pts.map((p) => p.v);
  const minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals, 1), range = maxV - minV || 1;
  const x = (i) => (pts.length > 1 ? padL + step * i : padL + innerW / 2);
  const y = (v) => padT + plotH * (1 - (v - minV) / range);
  const y0 = y(0);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Grafik saldo berjalan">`;
  svg += `<line x1="${padL}" y1="${y0.toFixed(1)}" x2="${W - padR}" y2="${y0.toFixed(1)}" stroke="#cbd5e1" stroke-dasharray="4 4" />`;
  svg += `<text x="${padL - 8}" y="${(y0 + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#667085">Rp0</text>`;
  svg += `<text x="${padL - 8}" y="${(y(maxV) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#667085">${singkatRp(maxV)}</text>`;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  svg += `<path d="${line} L${x(pts.length - 1).toFixed(1)},${y0.toFixed(1)} L${x(0).toFixed(1)},${y0.toFixed(1)} Z" fill="${C_BAL}" opacity="0.12" />`;
  svg += `<path d="${line}" fill="none" stroke="${C_BAL}" stroke-width="2.5" stroke-linejoin="round" />`;
  pts.forEach((p, i) => {
    svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" fill="${C_BAL}"><title>${bulanChart(p.ym)} — Saldo ${rupiah(p.v)}</title></circle>`;
    svg += `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#667085">${bulanChart(p.ym)}</text>`;
  });
  $('chart-balance').innerHTML = svg + '</svg>';
}
function renderBreakdown(type, container) {
  const map = new Map();
  for (const t of state.transactions) {
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
