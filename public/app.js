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

// Mulai
boot();
