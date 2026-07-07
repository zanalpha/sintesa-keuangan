'use strict';

/* ============================================================
   Buku Kas Sintesa — logika frontend (tanpa framework/build)
   ============================================================ */

// ---------- Util ----------
const $ = (id) => document.getElementById(id);
const rupiah = (n) => 'Rp' + new Intl.NumberFormat('id-ID').format(Math.round(n || 0));
const BULAN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

function tanggalIndo(iso) {
  // '2026-07-01' -> '01 Jul 2026'
  const [y, m, d] = iso.split('-');
  const singkat = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  return `${d} ${singkat[Number(m) - 1]} ${y}`;
}
function labelBulan(ym) {
  const [y, m] = ym.split('-');
  return `${BULAN[Number(m) - 1]} ${y}`;
}
function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

let toastTimer;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
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
  transactions: [], // seluruh transaksi buku terpilih
  month: '',        // '' = semua bulan, atau 'YYYY-MM'
  view: 'catatan',  // 'catatan' | 'analitik'
};

// ============================================================
//  AUTH
// ============================================================
async function boot() {
  $('year').textContent = new Date().getFullYear();
  wireStaticHandlers();
  try {
    const status = await api('GET', '/api/auth/status');
    if (status.authenticated) {
      state.user = status.user;
      await enterApp();
    } else {
      showAuth(status.hasUsers);
    }
  } catch (e) {
    showAuth(true);
  }
}

function showAuth(hasUsers) {
  $('app-view').classList.add('hidden');
  $('auth-view').classList.remove('hidden');
  $('login-form').classList.toggle('hidden', !hasUsers);
  $('register-form').classList.toggle('hidden', hasUsers);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('login-error').textContent = '';
  try {
    const { user } = await api('POST', '/api/auth/login', {
      username: f.username.value, password: f.password.value,
    });
    state.user = user;
    await enterApp();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('register-error').textContent = '';
  try {
    const { user } = await api('POST', '/api/auth/register', {
      name: f.name.value, username: f.username.value, password: f.password.value,
    });
    state.user = user;
    await enterApp();
  } catch (err) {
    $('register-error').textContent = err.message;
  }
});

// ============================================================
//  APLIKASI
// ============================================================
async function enterApp() {
  $('auth-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('menu-user').textContent = 'Masuk sebagai ' + state.user.name;
  await loadBooks();
}

async function loadBooks() {
  const { books } = await api('GET', '/api/books');
  state.books = books;

  if (books.length === 0) {
    // Buat buku default otomatis agar pengguna langsung bisa mencatat.
    const { book } = await api('POST', '/api/books', { name: 'Buku Kas Utama' });
    state.books = [book];
  }

  // Pilih buku terakhir dipakai bila masih ada.
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
    o.value = b.id;
    o.textContent = b.name;
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
    o.value = m;
    o.textContent = labelBulan(m);
    sel.appendChild(o);
  }
  // Pertahankan pilihan bila masih tersedia.
  sel.value = months.includes(current) ? current : '';
  state.month = sel.value;
}

// ---------- Render ----------
function visibleTx() {
  if (!state.month) return state.transactions;
  return state.transactions.filter((t) => t.tanggal.slice(0, 7) === state.month);
}

function render() {
  const all = state.transactions;
  const totalMasuk = all.filter((t) => t.type === 'masuk').reduce((s, t) => s + t.jumlah, 0);
  const totalKeluar = all.filter((t) => t.type === 'keluar').reduce((s, t) => s + t.jumlah, 0);

  // Kartu = sepanjang waktu (posisi keseluruhan buku)
  $('sum-masuk').textContent = rupiah(totalMasuk);
  $('sum-keluar').textContent = rupiah(totalKeluar);
  $('sum-sisa').textContent = rupiah(totalMasuk - totalKeluar);

  const rows = visibleTx();
  renderColumn('masuk', rows.filter((t) => t.type === 'masuk'));
  renderColumn('keluar', rows.filter((t) => t.type === 'keluar'));

  const scope = state.month ? labelBulan(state.month) : 'semua waktu';
  $('tx-count').textContent = `${rows.length} transaksi (${scope})`;

  // Judul untuk cetak
  const book = state.books.find((b) => b.id === state.bookId);
  document.querySelector('.print-title').textContent =
    `${book ? book.name : ''} — ${scope}`;

  if (state.view === 'analitik') renderAnalytics();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.vt-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const analitik = view === 'analitik';
  $('ledger-view').classList.toggle('hidden', analitik);
  $('analytics-view').classList.toggle('hidden', !analitik);
  $('ledger-tools').classList.toggle('hidden', analitik);
  render();
}

function renderColumn(type, list) {
  const tbody = $('tbody-' + type);
  tbody.innerHTML = '';
  if (list.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    tr.innerHTML = `<td colspan="5">Belum ada data</td>`;
    tbody.appendChild(tr);
  } else {
    list.forEach((t, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="c-no">${i + 1}</td>
        <td class="c-date">${tanggalIndo(t.tanggal)}</td>
        <td class="c-amt">${rupiah(t.jumlah)}</td>
        <td>${escapeHtml(t.keterangan) || '<span class="muted">—</span>'}${
          t.kategori ? ` <span class="muted">· ${escapeHtml(t.kategori)}</span>` : ''
        }</td>
        <td class="c-act"><div class="row-actions">
          <button class="icon-btn" title="Ubah" data-edit="${t.id}">✎</button>
          <button class="icon-btn" title="Hapus" data-del="${t.id}">🗑</button>
        </div></td>`;
      tbody.appendChild(tr);
    });
  }
  const total = list.reduce((s, t) => s + t.jumlah, 0);
  $('foot-' + type).textContent = rupiah(total);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ============================================================
//  MODAL TRANSAKSI
// ============================================================
function openTxModal(type, tx) {
  const f = $('tx-form');
  f.reset();
  $('tx-error').textContent = '';
  f.type.value = type;
  f.id.value = tx ? tx.id : '';
  f.tanggal.value = tx ? tx.tanggal : todayISO();
  f.jumlah.value = tx ? new Intl.NumberFormat('id-ID').format(tx.jumlah) : '';
  f.keterangan.value = tx ? tx.keterangan : '';
  f.kategori.value = tx ? tx.kategori : '';
  const label = type === 'masuk' ? 'Pemasukan' : 'Pengeluaran';
  $('tx-modal-title').textContent = (tx ? 'Ubah ' : 'Tambah ') + label;
  $('tx-submit').textContent = tx ? 'Simpan Perubahan' : 'Simpan';
  $('tx-modal').classList.remove('hidden');
  setTimeout(() => f.jumlah.focus(), 50);
}

// Format ribuan saat mengetik jumlah
$('tx-form').jumlah.addEventListener('input', (e) => {
  const digits = e.target.value.replace(/\D/g, '');
  e.target.value = digits ? new Intl.NumberFormat('id-ID').format(Number(digits)) : '';
});

$('tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('tx-error').textContent = '';
  const payload = {
    type: f.type.value,
    tanggal: f.tanggal.value,
    jumlah: f.jumlah.value.replace(/\D/g, ''),
    keterangan: f.keterangan.value,
    kategori: f.kategori.value,
  };
  if (!payload.jumlah) { $('tx-error').textContent = 'Jumlah wajib diisi.'; return; }
  try {
    if (f.id.value) {
      await api('PATCH', `/api/transactions/${f.id.value}`, payload);
      toast('Transaksi diperbarui.');
    } else {
      await api('POST', `/api/books/${state.bookId}/transactions`, payload);
      toast('Transaksi ditambahkan.');
    }
    closeModals();
    await loadTransactions();
  } catch (err) {
    $('tx-error').textContent = err.message;
  }
});

// ============================================================
//  AKSI BUKU
// ============================================================
async function newBook() {
  const name = prompt('Nama buku kas baru:', '');
  if (name === null) return;
  if (!name.trim()) return toast('Nama tidak boleh kosong.', true);
  try {
    const { book } = await api('POST', '/api/books', { name: name.trim() });
    state.bookId = book.id;
    await loadBooks();
    toast('Buku dibuat.');
  } catch (err) { toast(err.message, true); }
}

async function renameBook() {
  const book = state.books.find((b) => b.id === state.bookId);
  const name = prompt('Ganti nama buku:', book ? book.name : '');
  if (name === null || !name.trim()) return;
  try {
    await api('PATCH', `/api/books/${state.bookId}`, { name: name.trim() });
    await loadBooks();
    toast('Nama buku diganti.');
  } catch (err) { toast(err.message, true); }
}

async function deleteBook() {
  if (state.books.length <= 1) return toast('Minimal harus ada satu buku.', true);
  const book = state.books.find((b) => b.id === state.bookId);
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
    const ul = $('users-list');
    ul.innerHTML = '';
    for (const u of users) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(u.name)}</span><span class="u-username">@${escapeHtml(u.username)}</span>`;
      ul.appendChild(li);
    }
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
    await api('POST', '/api/auth/register', {
      name: f.name.value, username: f.username.value, password: f.password.value,
    });
    toast('Pengguna ditambahkan.');
    await openUsers();
  } catch (err) {
    $('add-user-error').textContent = err.message;
  }
});

// ============================================================
//  EXPORT & CETAK
// ============================================================
function exportCsv() {
  const rows = visibleTx();
  if (rows.length === 0) return toast('Tidak ada data untuk diekspor.', true);
  const book = state.books.find((b) => b.id === state.bookId);
  const header = ['Jenis', 'Tanggal', 'Jumlah', 'Keterangan', 'Kategori'];
  const lines = [header.join(',')];
  for (const t of rows) {
    const jenis = t.type === 'masuk' ? 'Pemasukan' : 'Pengeluaran';
    const cells = [jenis, t.tanggal, t.jumlah, t.keterangan, t.kategori].map(csvCell);
    lines.push(cells.join(','));
  }
  const scope = state.month || 'semua';
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kas-${slug(book ? book.name : 'buku')}-${scope}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// ============================================================
//  MENU & HANDLER STATIS
// ============================================================
function toggleMenu() { $('menu-dropdown').classList.toggle('hidden'); }
function closeMenu() { $('menu-dropdown').classList.add('hidden'); }
function closeModals() {
  $('tx-modal').classList.add('hidden');
  $('users-modal').classList.add('hidden');
}

function wireStaticHandlers() {
  // Tombol tambah (masuk/keluar)
  document.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', () => openTxModal(btn.dataset.add))
  );

  // Delegasi edit/hapus pada tabel
  document.querySelector('.ledger').addEventListener('click', async (e) => {
    const editId = e.target.dataset.edit;
    const delId = e.target.dataset.del;
    if (editId) {
      const tx = state.transactions.find((t) => t.id === Number(editId));
      if (tx) openTxModal(tx.type, tx);
    } else if (delId) {
      if (!confirm('Hapus transaksi ini?')) return;
      try {
        await api('DELETE', `/api/transactions/${delId}`);
        toast('Transaksi dihapus.');
        await loadTransactions();
      } catch (err) { toast(err.message, true); }
    }
  });

  // Toggle tampilan Catatan / Analitik
  document.querySelectorAll('.vt-btn').forEach((b) =>
    b.addEventListener('click', () => setView(b.dataset.view))
  );

  $('book-select').addEventListener('change', (e) => {
    state.bookId = Number(e.target.value);
    state.month = '';
    loadTransactions();
  });
  $('month-filter').addEventListener('change', (e) => { state.month = e.target.value; render(); });

  $('new-book-btn').addEventListener('click', newBook);
  $('menu-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  $('rename-book-btn').addEventListener('click', () => { closeMenu(); renameBook(); });
  $('delete-book-btn').addEventListener('click', () => { closeMenu(); deleteBook(); });
  $('users-btn').addEventListener('click', openUsers);
  $('logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    location.reload();
  });

  $('export-btn').addEventListener('click', exportCsv);
  $('print-btn').addEventListener('click', () => window.print());

  // Tutup modal & menu
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach((m) =>
    m.addEventListener('click', (e) => { if (e.target === m) closeModals(); })
  );
  document.addEventListener('click', () => closeMenu());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModals(); closeMenu(); } });
}

// ============================================================
//  ANALITIK (grafik SVG buatan sendiri, tanpa library)
// ============================================================
const PALETTE = ['#1e4d8c', '#158a4a', '#d98014', '#7b4fa3', '#0e7c86', '#c2306e', '#c0392b', '#5a6b7b', '#3a7d44', '#8a6d3b'];

function singkatRp(n) {
  const f = (x) => x.toFixed(x % 1 === 0 ? 0 : 1).replace('.', ',');
  const a = Math.abs(n);
  if (a >= 1e9) return 'Rp' + f(n / 1e9) + ' M';
  if (a >= 1e6) return 'Rp' + f(n / 1e6) + ' jt';
  if (a >= 1e3) return 'Rp' + f(n / 1e3) + ' rb';
  return 'Rp' + Math.round(n);
}
function bulanSingkat(ym) {
  const s = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const [y, m] = ym.split('-');
  return s[Number(m) - 1] + " '" + y.slice(2);
}
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
  const ids = ['stat-tiles', 'chart-monthly', 'chart-balance', 'breakdown-keluar', 'breakdown-masuk'];
  if (!has) { ids.forEach((id) => ($(id).innerHTML = '')); return; }
  const months = monthlyAgg();
  renderTiles(months);
  renderMonthlyChart(months);
  renderBalanceChart(months);
  renderBreakdown('keluar', $('breakdown-keluar'));
  renderBreakdown('masuk', $('breakdown-masuk'));
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
  $('stat-tiles').innerHTML = tiles
    .map((t) => `<div class="tile"><span class="tile-label">${t.label}</span><span class="tile-value ${t.cls}">${t.value}</span><span class="tile-sub">${escapeHtml(t.sub)}</span></div>`)
    .join('');
}

function renderMonthlyChart(months) {
  const H = 280, padL = 58, padR = 12, padT = 12, padB = 34, plotH = H - padT - padB;
  const groupW = Math.max(52, Math.min(120, 640 / months.length));
  const W = Math.round(padL + padR + groupW * months.length);
  const max = Math.max(1, ...months.map((m) => Math.max(m.masuk, m.keluar)));
  const y = (v) => padT + plotH * (1 - v / max);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Grafik pemasukan dan pengeluaran per bulan">`;
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const val = (max / ticks) * i, yy = y(val);
    svg += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="#eef1f6" />`;
    svg += `<text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b7280">${singkatRp(val)}</text>`;
  }
  months.forEach((m, i) => {
    const gx = padL + groupW * i, cx = gx + groupW / 2, bw = groupW * 0.32, gap = groupW * 0.06;
    const inX = cx - bw - gap / 2, outX = cx + gap / 2;
    svg += `<rect x="${inX.toFixed(1)}" y="${y(m.masuk).toFixed(1)}" width="${bw.toFixed(1)}" height="${(plotH * m.masuk / max).toFixed(1)}" rx="3" fill="#158a4a"><title>${bulanSingkat(m.ym)} — Pemasukan ${rupiah(m.masuk)}</title></rect>`;
    svg += `<rect x="${outX.toFixed(1)}" y="${y(m.keluar).toFixed(1)}" width="${bw.toFixed(1)}" height="${(plotH * m.keluar / max).toFixed(1)}" rx="3" fill="#c0392b"><title>${bulanSingkat(m.ym)} — Pengeluaran ${rupiah(m.keluar)}</title></rect>`;
    svg += `<text x="${cx.toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#6b7280">${bulanSingkat(m.ym)}</text>`;
  });
  $('chart-monthly').innerHTML = svg + '</svg>';
}

function renderBalanceChart(months) {
  const H = 240, padL = 58, padR = 34, padT = 16, padB = 30, plotH = H - padT - padB;
  let cum = 0;
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
  svg += `<text x="${padL - 8}" y="${(y0 + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b7280">Rp0</text>`;
  svg += `<text x="${padL - 8}" y="${(y(maxV) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b7280">${singkatRp(maxV)}</text>`;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  svg += `<path d="${line} L${x(pts.length - 1).toFixed(1)},${y0.toFixed(1)} L${x(0).toFixed(1)},${y0.toFixed(1)} Z" fill="#1e4d8c" opacity="0.12" />`;
  svg += `<path d="${line}" fill="none" stroke="#1e4d8c" stroke-width="2.5" stroke-linejoin="round" />`;
  pts.forEach((p, i) => {
    svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" fill="#1e4d8c"><title>${bulanSingkat(p.ym)} — Saldo ${rupiah(p.v)}</title></circle>`;
    svg += `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#6b7280">${bulanSingkat(p.ym)}</text>`;
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
  if (arr.length > 8) {
    const rest = arr.slice(7).reduce((s, x) => s + x.v, 0);
    arr = arr.slice(0, 7).concat({ k: 'Lainnya', v: rest });
  }
  const max = arr[0].v || 1;
  container.innerHTML = arr
    .map((x, i) => {
      const pct = total ? Math.round((x.v / total) * 100) : 0;
      const w = ((x.v / max) * 100).toFixed(1);
      const color = PALETTE[i % PALETTE.length];
      return `<div class="bd-row">
        <div class="bd-top"><span class="bd-name">${escapeHtml(x.k)}</span><span class="bd-amt">${rupiah(x.v)} · ${pct}%</span></div>
        <div class="bd-track"><div class="bd-fill" style="width:${w}%;background:${color}"></div></div>
      </div>`;
    })
    .join('');
}

// Mulai
boot();
