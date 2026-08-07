# Cadangan lokal (folder ini)

File di sini adalah salinan JSON database (rekening + transaksi + bukti).

- **Jangan di-commit ke Git** (sudah di `.gitignore`) — berisi data keuangan & lampiran.
- Cadangkan rutin: `npm run backup` (butuh `.env` dengan `ADMIN_*` + `BACKUP_URL`, atau `DATABASE_URL`).
- Salinan terbaru selalu ada di `latest.json`.
- Simpan juga salinan ke Drive / USB secara berkala.
- **Repo privat off-site:** https://github.com/zanalpha/sintesa-keuangan-backups (file `.enc` harian).

Pemulihan:

```bash
npm run restore -- --replace
# atau
node scripts/restore-from-folder.js backups/latest.json --replace
```
