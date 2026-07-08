# Buku Kas Sintesa 🐙

Aplikasi web untuk mencatat **pemasukan** dan **pengeluaran** usaha — pengganti Google Sheet,
tapi bisa diakses dari HP & laptop mana saja, dengan login.

Dibuat untuk **PT Sintesa Data Semesta**.

## Fitur

- Login akun (aman, password di-hash dengan bcrypt). Registrasi publik dimatikan; akun ditambah oleh admin lewat **Kelola Pengguna**.
- Banyak **Rekening** (mis. BCA, KOPRA MANDIRI) dengan **Saldo Awal** & nomor rekening masing-masing. Pencatatan pemasukan/pengeluaran **terpisah per rekening**, tetapi **Analitik menggabungkan semua rekening** (+ panel Saldo per Rekening).
- Tiga tampilan:
  - **Catatan** — dua kolom Pemasukan / Pengeluaran, total, dan **Saldo Akhir** otomatis.
  - **Buku Besar** — daftar kronologis dengan **Saldo Berjalan** dan filter rentang tanggal (dari–sampai).
  - **Analitik** — grafik pemasukan vs pengeluaran per bulan, saldo berjalan, rincian per kategori, kartu statistik.
- Tambah / ubah / hapus transaksi (tanggal, jumlah, keterangan, kategori dengan saran otomatis).
- **Bukti transaksi (opsional)** — lampirkan foto struk/nota/transfer atau PDF; gambar otomatis dikompres di browser, baris bertanda 📎, bisa dilihat & diunduh. Blob disimpan di DB dan hanya diambil saat dilihat (daftar tetap ringan).
- **Pencarian** keterangan, filter per bulan.
- **Impor CSV** (migrasi dari spreadsheet lama) & **Ekspor CSV**.
- **Cetak** laporan formal berkop PT (periode, tanggal cetak, kolom tanda tangan).
- **Perbandingan bulan ini vs bulan lalu** (naik/turun + persentase) di Analitik.
- **Ganti password** sendiri, **cadangkan seluruh data** ke JSON, **kelola pengguna**.
- Tampilan **"treasury console"** cyber-formal (navy + teal + emas, angka monospace) dengan **toggle terang/gelap**.
- Pintasan keyboard: `N` transaksi baru, `/` fokus pencarian.
- Keamanan: header CSP + anti-clickjacking, password bcrypt, query berparameter, sesi cookie httpOnly.
- Responsif — nyaman di HP maupun desktop.

## Teknologi

- Backend: Node.js + Express
- Database: PostgreSQL (`pg`)
- Login: cookie-session + bcryptjs
- Frontend: HTML/CSS/JavaScript murni (tanpa proses build)

---

## Menjalankan di komputer (lokal)

```bash
npm install
npm start
```

Buka http://localhost:3000

> Tanpa `DATABASE_URL`, aplikasi memakai database **sementara di memori** —
> cocok untuk mencoba, tapi **data hilang** saat server dimatikan.
> Untuk data permanen, isi `DATABASE_URL` (lihat di bawah) atau langsung deploy ke Render.

---

## Deploy ke Render (rekomendasi) — GRATIS

Aplikasi ini sudah menyertakan `render.yaml`, jadi Render otomatis membuat
web service + database Postgres yang saling tersambung.

### Langkah

1. **Naikkan kode ke GitHub** (lihat bagian bawah).
2. Buka https://dashboard.render.com → **New +** → **Blueprint**.
3. Hubungkan akun GitHub, pilih repo **sintesa-keuangan**.
4. Render membaca `render.yaml` → klik **Apply**. Render akan membuat:
   - Database `sintesa-keuangan-db` (Postgres)
   - Web service `sintesa-keuangan` (Node) — `DATABASE_URL` & `SESSION_SECRET` terisi otomatis.
5. Tunggu 2–3 menit sampai status **Live**. Buka URL `https://sintesa-keuangan.onrender.com`.
6. **Buat akun pertama** di layar yang muncul → langsung bisa mencatat.

> Catatan paket gratis:
> - Web service gratis "tidur" saat tidak dipakai; akses pertama butuh ±30 detik untuk bangun.
>   Naikkan ke paket **Starter** agar selalu aktif.
> - Postgres gratis Render **kedaluwarsa** setelah beberapa waktu. Untuk pemakaian serius,
>   ubah `plan: free` → `plan: basic` di `render.yaml`.

### Pakai domain sendiri (opsional)

Punya domain `sintesadatasemesta.com`? Bisa pasang subdomain, mis. `kas.sintesadatasemesta.com`:
Render → service → **Settings → Custom Domains → Add** → ikuti instruksi CNAME di panel DNS Hostinger.

---

## Menaikkan kode ke GitHub

```bash
cd sintesa-keuangan
git init
git add .
git commit -m "Aplikasi Buku Kas Sintesa"
git branch -M main
# buat repo kosong di github.com dulu, lalu:
git remote add origin https://github.com/USERNAME/sintesa-keuangan.git
git push -u origin main
```

Setiap kali ada perubahan: `git add . && git commit -m "..." && git push` →
Render otomatis deploy ulang.

---

## Variabel lingkungan (Environment Variables)

| Nama             | Wajib?         | Keterangan |
|------------------|----------------|------------|
| `DATABASE_URL`   | Ya (produksi)  | Koneksi Postgres. Otomatis terisi oleh `render.yaml`. |
| `SESSION_SECRET` | Ya (produksi)  | Kunci acak pengaman sesi. Otomatis dibuat oleh Render. |
| `PORT`           | Tidak          | Diisi otomatis oleh Render. Default `3000` saat lokal. |

---

## Backup data

Karena data ada di Postgres, backup = dump database (Render menyediakan backup pada paket berbayar).
Untuk salinan cepat: gunakan tombol **Export CSV** di aplikasi untuk tiap buku/bulan.

## Keamanan

- Password disimpan sebagai hash bcrypt (tidak pernah plaintext).
- Sesi login lewat cookie httpOnly + `secure` di produksi.
- Registrasi terbuka **hanya** untuk akun pertama; setelahnya penambahan user
  harus lewat pengguna yang sudah login (menu **Kelola Pengguna**).
- Ada pembatas percobaan login untuk mengurangi serangan tebak password.
