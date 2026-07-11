# Buku Kas Sintesa 🐙

Aplikasi web untuk mencatat **pemasukan** dan **pengeluaran** usaha — pengganti Google Sheet,
tapi bisa diakses dari HP & laptop mana saja, dengan login.

Dibuat untuk **PT Sintesa Data Semesta**.

## Fitur

- Login akun (aman, password di-hash dengan **bcrypt cost 12**). Registrasi publik **dimatikan**: admin pertama dibuat otomatis dari env `ADMIN_USER`/`ADMIN_PASSWORD`; akun berikutnya ditambah admin lewat **Kelola Pengguna**.
- **Peran pengguna**: **Admin** (bisa mengubah data) & **Viewer** (hanya melihat — semua tombol ubah/hapus disembunyikan).
- **Transfer antar rekening** (membuat pasangan transaksi keluar+masuk otomatis & atomik).
- **Riwayat aktivitas (audit log)**: mencatat siapa membuat/mengubah/menghapus/transfer/memulihkan.
- **Hapus = soft-delete**: transaksi terhapus disembunyikan tapi tetap tersimpan untuk audit/pemulihan.
- **Pulihkan (restore)** dari file cadangan JSON, dan **cadangan otomatis harian** via GitHub Actions.
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
- Pintasan keyboard: `N` pemasukan baru, `K` pengeluaran baru, `/` fokus pencarian.
- **Simpan & tambah lagi** untuk input transaksi beruntun yang cepat.
- Keamanan: header CSP + anti-clickjacking, bcrypt cost 12, kebijakan password (min 10, blokir yang umum), pembatas login per-IP **dan per-akun**, query berparameter, sesi cookie httpOnly.
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
5. Di service → **Environment**, isi **`ADMIN_USER`** dan **`ADMIN_PASSWORD`** (min 6 karakter). Admin pertama dibuat otomatis dari sini saat database masih kosong.
6. Tunggu 2–3 menit sampai status **Live**. Buka URL `https://sintesa-keuangan.onrender.com` → **login** dengan admin yang tadi diisi.

> Registrasi publik dimatikan demi keamanan. Butuh akun lagi? Login sebagai admin → **☰ → Kelola pengguna → Tambah pengguna**.

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
| `ADMIN_USER`     | Ya (deploy baru) | Username admin pertama; dibuat otomatis saat DB kosong. |
| `ADMIN_PASSWORD` | Ya (deploy baru) | Password admin pertama (min 6 karakter). |
| `ADMIN_NAME`     | Tidak          | Nama tampilan admin pertama. Default `Administrator`. |
| `PGSSL_STRICT`   | Tidak          | Set `1` untuk memverifikasi sertifikat SSL server DB (perlu CA yang cocok). |
| `PORT`           | Tidak          | Diisi otomatis oleh Render. Default `3000` saat lokal. |

---

## Menjalankan test

```bash
npm test        # integration test atas seluruh API (pakai database in-memory, tanpa Postgres)
npm run lint    # ESLint
```
Butuh **Node ≥ 18**. Test & lint juga berjalan otomatis di GitHub Actions (`.github/workflows/ci.yml`) setiap push/PR.

## Backup & pemulihan data

Tiga lapis pengaman:

1. **Cadangkan manual** — menu **☰ → Cadangkan data (JSON)**. Berkas berisi semua rekening + transaksi **+ bukti lampiran** (format v2).
2. **Pulihkan** — menu **☰ → Pulihkan dari cadangan**, pilih file JSON. ⚠️ Menimpa seluruh data saat ini.
3. **Cadangan otomatis harian (off-site)** — GitHub Actions (`.github/workflows/backup.yml`) menjalankan `pg_dump` tiap hari dan menyimpannya sebagai artifact (retensi 30 hari).
   Aktifkan dengan menambah **secret `DATABASE_URL`** di repo: **Settings → Secrets and variables → Actions → New repository secret** (isi dengan Database URL dari Render).

> Postgres **paket gratis Render kedaluwarsa** setelah beberapa waktu. Untuk data serius, ubah `plan: free` → `plan: basic` di `render.yaml` agar tidak kedaluwarsa dan mendapat backup terkelola. Cadangan otomatis di atas tetap disarankan sebagai salinan off-site.

## Keamanan

- Password disimpan sebagai hash bcrypt (tidak pernah plaintext).
- Sesi login lewat cookie httpOnly + `secure` di produksi.
- Registrasi terbuka **hanya** untuk akun pertama; setelahnya penambahan user
  harus lewat pengguna yang sudah login (menu **Kelola Pengguna**).
- Ada pembatas percobaan login untuk mengurangi serangan tebak password.
