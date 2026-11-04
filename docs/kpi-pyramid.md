# FE KPI Pyramid — Rancangan Teknis

Status: draft untuk review Koyo (2026-11-04). Belum ada kode yang diubah.

## 1. Tujuan

Menurunkan metric departemen (2026 Q4 ProdDev Metrics) ke metric FE, lalu ke anggota, lalu ke tiket, dalam bentuk piramid per metric. Aplikasi ini adalah perluasan dari `fe-quarter-dashboard`.

```
Metric departemen  ─►  Metric FE  ─►  Anggota (Koyo / Galang / Dendy)  ─►  Tiket
```

## 2. Invarian (tidak boleh dilanggar)

1. **Read-only terhadap Notion.** Tidak ada satu pun write ke Notion. Metric departemen tidak berubah.
2. **Semua penyesuaian FE disimpan di `mapping.json`.** Tiap entri menyimpan alasan, siapa yang membuat, dan tanggalnya. UI menandai data yang berasal dari mapping dengan badge **"mapping FE"**.
3. **Fitur rekap yang sudah ada tidak berubah perilakunya.** KPI ditambahkan sebagai tab baru.
4. **Angka departemen ditampilkan apa adanya.** Kita tidak menghitung ulang `Actual %` departemen, hanya membacanya.

## 3. Sumber data (Notion API, `2022-06-28`)

| Data | Notion | Catatan |
|---|---|---|
| Metric departemen | DB `2026 Q4 ProdDev Metrics` (`2b1c6dc1a8eb80d29457df1a171d4fc3`) | **Satu DB per quarter.** ID-nya disimpan di `mapping.json` per quarter. Kolom: `Name`, `KPI` (Score Card/Rocks), `Target %`, `Actual %` (rollup), relasi `📽️ Epic Development Tracker`. |
| Epic | Epic Development Tracker (DB `d104cd1a15cd4184ad00b7f45615e6a6`) | Hanya dibutuhkan judul dan `Q-Target`. Relasi epic→metric diambil dari sisi metric. |
| Tiket | Dev Tickets (sudah dipakai) | Tambah pembacaan properti `Epic` (relation). |
| Sprint | Sprints Timeline (sudah dipakai) | Tidak berubah. |

**Prasyarat:** integration Notion yang dipakai dashboard harus diberi akses ke halaman *2026 ProdDev Metrics* dan *Epic Development Tracker*. Sekarang aksesnya baru ke Dev Tickets dan Sprints. Memberi akses ke integration tidak mengubah data.

**Jebakan API:**
- Properti relation di objek page dipotong di **25 item**. Metric Platform sekarang punya 20 epic. Kalau `has_more`, ambil sisanya lewat `GET /pages/{id}/properties/{prop_id}` (paginated). Jalur ini dipasang sejak awal, jangan menunggu kasusnya muncul.
- `Actual %` berupa rollup `average` dari formula. API mengembalikan `rollup.number`. Ambil apa adanya. Kalau nilainya null, tampilkan "—", jangan 0.

## 4. `mapping.json`

Lokasinya `api/_mapping.json`. File ini ikut ter-bundle ke function `api/kpi.js` (`includeFiles` di `vercel.json`). Isi folder `api/` tidak disajikan sebagai file statis, jadi mapping tidak bisa dibuka publik. Kalau ditaruh di root, file ini akan terbuka untuk publik.

```json
{
  "version": 1,
  "quarters": {
    "2026-Q4": {
      "metricsDb": "2b1c6dc1a8eb80d29457df1a171d4fc3",
      "metrics": {
        "3f7c6dc1a8eb80328305fc5808981b5a": { "fe": "hidden", "reason": "Uptime: tidak ada kontribusi tiket FE langsung" }
      },
      "extraEpics": [
        {
          "epic": "3f1c6dc1a8eb81e4b943e844281c57fa",
          "metric": "2b1c6dc1a8eb81c4997ed8b61b6a55ff",
          "reason": "Epic Q4 Org map link belum ditautkan ke metric departemen",
          "by": "Koyo",
          "date": "2026-11-04"
        }
      ],
      "excludeEpics": [],
      "rules": [
        {
          "when": { "issueType": "Bug", "noMetric": true },
          "metric": "2b1c6dc1a8eb81f9b201c123d7125bec",
          "reason": "Bug FE tanpa epic dihitung ke Bug Metrics",
          "by": "Koyo",
          "date": "2026-11-04"
        }
      ]
    }
  }
}
```

ID di atas adalah contoh nyata dari data Q4. Isi finalnya kamu yang putuskan.

- `metrics.<id>.fe`: `"shown"` (default), `"hidden"`, atau `"team"`. Metric `hidden` tidak dibuatkan piramid, tapi tetap terlihat di daftar ringkas. Metric `team` hanya punya node tim, tanpa node anggota. Isinya tiket yang judulnya cocok dengan `count.titleRegex`, misalnya hotfix sebagai proxy insiden. Mode ini tidak memengaruhi penetapan tiket ke metric lain.
- `extraEpics`: menautkan epic ke metric tanpa menyentuh Notion. Dipakai juga untuk carry-over, misalnya epic Q3 yang tiketnya masih dikerjakan di Q4.
- `excludeEpics`: kebalikan dari `extraEpics`, dipakai kalau ada epic departemen yang menurut FE bukan kerja FE.
- `rules`: diterapkan **hanya** pada tiket yang belum punya metric dari Notion maupun `extraEpics`.
- Validasi saat load: ID harus 32 hex, metric harus ada di DB quarter itu, dan `reason`, `by`, `date` wajib diisi. Kalau validasi gagal, endpoint mengembalikan error yang jelas, bukan angka diam-diam.

## 5. Algoritma penugasan tiket → metric

Untuk setiap tiket FE di quarter itu (memakai aturan periode, carry-over, dan `NEVER` yang sama dengan rekap):

1. `epics` = relasi `Epic` dari tiket.
2. `fromNotion` = metric yang relasi epic-nya berisi salah satu `epics`, dikurangi `excludeEpics`. Sumber: `notion`.
3. `fromMapping` = metric dari `extraEpics` yang cocok dengan `epics`. Sumber: `mapping`.
4. Kalau 2 dan 3 kosong, cek `rules` sesuai urutan. Rule pertama yang cocok menjadi sumbernya. Sumber: `rule`.
5. Kalau tetap kosong, tiket masuk kolom **Di luar KPI**.

Satu tiket bisa masuk lebih dari satu metric kalau epic-nya memang tertaut ke beberapa metric. Konsekuensinya, angka antar piramid **tidak dijumlahkan** menjadi total. Total FE diambil dari jumlah tiket unik.

## 6. Angka per node

Di setiap node (FE dan anggota):

| Angka | Rumus |
|---|---|
| Tiket | jumlah tiket di metric itu |
| Poin | jumlah `Weight`, dibagi rata antar assignee FE (aturan sama dengan rekap) |
| **Deployed %** | tiket tahap 7 ÷ tiket |
| **Lolos QA %** | tiket tahap ≥ 5 ÷ tiket |
| Sumber | jumlah tiket per sumber: notion / mapping / rule |

Node departemen menampilkan `Target %`, `Actual %` versi departemen, dan jenis KPI (Score Card/Rocks).

Persentase dihitung **per jumlah tiket**, sama dengan rollup `percent_per_group` di departemen. Versi per poin ditampilkan sebagai angka kedua. Lihat keputusan terbuka #1.

## 7. API

`GET /api/kpi?q=2026-Q4`. Auth cookie sama dengan `/api/report`, `Cache-Control: no-store`, cache server 5 menit, dan `refresh=1` untuk memaksa ambil ulang.

- Tiket diambil dengan memakai ulang `buildReport({ q })`. Objek tiket ditambah `epicIds`, perubahan kecil di `_lib.js` yang tidak mengubah output rekap.
- Lalu ambil metric DB dan judul epic, terapkan mapping, dan bangun pohonnya.

```jsonc
{
  "quarter": "2026-Q4", "generatedAt": "…", "mapping": { "version": 1, "entries": 3 },
  "metrics": [{
    "id": "…", "name": "[Deliverable] Platform Improvement Q4 2026", "kind": "Rocks",
    "target": 100, "actualDept": 62.4, "hidden": false,
    "fe": { "tickets": 45, "points": 140, "deployedPct": 40, "qaPct": 71, "bySource": { "notion": 41, "mapping": 4, "rule": 0 } },
    "members": [{ "name": "Galang", "tickets": 18, "points": 60, "deployedPct": 44, "qaPct": 78 }],
    "ticketIds": ["TSP-4815", "…"]
  }],
  "outside": ["TSP-…"],
  "tickets": { "TSP-4815": { "title": "…", "url": "…", "stage": 5, "status": "…", "weight": 3, "members": ["Galang"], "epics": ["…"], "metrics": [{ "id": "…", "source": "mapping" }] } },
  "warnings": ["Metric X: Actual % kosong", "Epic Y di mapping tidak ditemukan"]
}
```

Hanya mode per quarter. Mode rentang sprint tidak dipakai di sini, karena metric departemen terikat ke quarter.

## 8. UI

- Tab baru **KPI** di samping **Rekap**, memakai komponen dan token Hallmark Coral yang sudah ada.
- **Overview:** satu baris piramid mini, satu per metric yang tampil. Tiap piramid menampilkan nama metric, target, dan actual departemen di puncak, lalu Deployed % / Lolos QA % FE di bawahnya. Metric yang disembunyikan ditaruh di daftar kecil di bawah, lengkap dengan alasannya.
- **Detail** (klik piramid): piramid penuh dengan urutan departemen → FE → 3 anggota → tiket.
  - Node anggota bisa diklik untuk membuka daftar tiket. Tiket menautkan ke Notion.
  - Garis penghubung dibuat dengan SVG inline. Tanpa library chart baru.
  - Badge **mapping FE** dan **rule** muncul di node dan tiket yang terpengaruh.
- **Di luar KPI:** panel terpisah di bawah piramid, berisi daftar tiket dan totalnya.
- **Mobile:** piramid berubah jadi tumpukan vertikal (accordion). Tidak ada scroll horizontal.
- **Penjelasan:** section singkat berisi cara membaca piramid, arti Deployed vs Lolos QA, dan isi mapping yang aktif.

## 9. Repo, deploy, dan Hermes

1. `git init` di folder dashboard, lalu push ke repo GitHub private. Ini syarat agar perubahan `mapping.json` punya jejak audit.
2. Perubahan mapping dilakukan lewat PR yang di-approve Koyo, baru di-deploy. Ini menyusul rule Hermes yang sudah ada: perubahan di luar AC harus disetujui Koyo.
3. `docs/` dan `.hallmark/` masuk `.vercelignore`.
4. Hermes (fase 3, opsional): perintah DM seperti "map epic X ke metric Y" membuat PR yang mengubah `mapping.json`. Skill Python `fe-quarter-report` **tidak** diubah di fase 1–2.

## 10. Verifikasi

- `actualDept` di app harus sama dengan angka `Actual %` di Notion UI untuk keenam metric. Dicek manual satu kali.
- Cakupan Q4 per 2026-11-04 (Sprint 20–22, 92 tiket FE) harus cocok dengan hitungan lewat MCP: Platform 45, Bug 16, Committed 12, Additional 0, epic lain 11, tanpa epic 8. Angka ini **sebelum** mapping diterapkan.
- Setiap tiket FE di quarter itu muncul tepat di ≥1 piramid atau di **Di luar KPI**. Tidak boleh ada yang hilang. Total tiket unik = total di rekap.
- Uji unit untuk algoritma penugasan, dengan fixture: tiket multi-epic, epic yang di-exclude, rule, dan relasi > 25.

## 11. Fase

| Fase | Isi | Hasil |
|---|---|---|
| 1 | Akses integration, git init, `mapping.json` beserta validator, `/api/kpi`, uji unit | JSON bisa diverifikasi terhadap angka di atas |
| 2 | Tab KPI: overview piramid, detail, Di luar KPI, mobile | Deploy ke Vercel |
| 3 | Skill Hermes untuk PR mapping (opsional) | — |

## 12. Keputusan (diputuskan Koyo 2026-11-04: ikuti semua usulan)

1. **Basis persentase:** jumlah tiket (sama dengan departemen) atau poin? Usulan: tiket sebagai angka utama, poin sebagai angka kedua.
2. **Metric Uptime dan Customer Impacting Incident:** disembunyikan, atau diberi metric FE pengganti (misalnya jumlah hotfix FE)? Usulan: Uptime disembunyikan. Incident ditampilkan di level tim saja, tanpa node anggota.
3. **Isi awal `mapping.json`:**
   - Org map link → Platform?
   - LC discount (carry-over Q3) → Committed atau tidak?
   - Bug tanpa epic → Bug Metrics?
4. **Repo GitHub:** di org Chronicle atau akun pribadi?

### Hasil keputusan

- Persentase utama per jumlah tiket, poin sebagai angka kedua.
- Uptime: `hidden`. Customer Impacting Incident: `team`, dengan proxy tiket hotfix FE (regex `hot[\s-]?fix`).
- `extraEpics`: Org map link → Platform Improvement. LC discount (carry-over Q3) → Product Committed.
- `rules`: Bug tanpa epic → Bug Metrics.
- Repo GitHub: belum diputuskan.

## 13. Status fase 1 (2026-11-04)

- `git init` + commit baseline.
- `api/_mapping.json`, `api/_kpi.js` (validasi, penetapan, ringkasan, fetch Notion read-only), `api/kpi.js`.
- `api/_lib.js`: ekspor helper Notion, tiket ditambah `pageId`/`epicIds`/`epicPropId`/`epicHasMore`. Output rekap lain tidak berubah.
- `npm test`: 11 uji lulus. Termasuk fixture data nyata 2026-11-04 (92 tiket). Tanpa mapping: 45/16/12/0, di luar 19. Dengan mapping: Platform 49 (45 notion + 4 mapping), Committed 17, Bug 23 (16 + 7 rule), di luar 3.
- Belum diverifikasi ke Notion live: butuh akses integration ke ProdDev Metrics dan Epic Tracker, plus deploy ber-env.
