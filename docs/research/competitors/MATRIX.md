# Capabilities Matrix

Synthesized 2026-08-26 from the per-competitor research files in this folder (collected by AGY, sources cited per file).

Legend: ● full · ◐ partial · — none. "E2EE" = zero-knowledge / end-to-end encryption of health data (server or vendor cannot read it). "Self" = self-hostable. Meds column requires schedule+reminders; inventory noted separately below.

| Product | Meds | BP | Wt | Workout | Sleep | Vitals | Food | Diary | Web/PWA | Self | E2EE | OSS | Export | Price |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Us (MedTracker cloud)** | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● JSON (age-encrypted) | free/self-host |
| *— medication trackers —* |
| Medisafe | ● | ● | ● | — | — | ◐ | — | ◐ | — | — | — | — | CSV/XLSX/PDF | freemium $40/y, ads |
| MyTherapy | ● | ● | ● | — | — | ◐ | — | ● | — | — | — | — | PDF only | free (pharma-funded) |
| Dosecast | ● | — | — | — | — | — | — | ◐ | — | — | — | — | none | freemium $20/y |
| Round Health | ● | — | — | — | — | ◐ | — | — | — | — | — | — | none | **dead** (acquired 2020) |
| MedM Health | ● | ● | ● | ● | ● | ● | ◐ | ● | ● | — | — | — | CSV/XLSX + CSV import | freemium ~$30/y |
| *— platform ecosystems —* |
| Apple Health | ● | ● | ● | ● | ● | ● | ◐ | ◐ | — | — | ● (iCloud 2FA) | — | XML zip | free, iOS-only |
| Google Health Connect | ◐ | ● | ● | ● | ● | ● | ● | ◐ | — | — | ◐ (local store) | — | via Takeout/API | free, Android-only |
| Samsung Health | ● | ● | ● | ● | ● | ● | ● | ◐ | — | — | — | — | JSON/HTML zip | free, Galaxy lock-in |
| *— OSS / self-hosted —* |
| wger | — | ◐ | ● | ● | — | — | ● | ● | ● | ● | — | ● AGPL | CSV/JSON + API | free |
| openScale | — | ◐ | ● | — | — | ◐ | — | ● | — | — | ● (local-only) | ● GPL | CSV + SQLite | free |
| Waistline | — | — | ● | ◐ | — | — | ● | ● | — | — | ● (local-only) | ● GPL | JSON/CSV | free |
| Gadgetbridge | — | ◐ | ◐ | ● | ● | ● | — | ◐ | — | — | ● (no INTERNET perm) | ● AGPL | SQLite/GPX | free |
| Loop Habit Tracker | ◐ | — | ◐ | ◐ | ◐ | — | ◐ | ● | — | — | ● (local-only) | ● GPL | CSV/SQLite | free |
| Drip | ◐ | — | — | — | ◐ | ◐ | — | ● | — | — | ● (local-only) | ● GPL | CSV/JSON | free |
| Nightscout | ● (insulin) | — | — | ◐ | — | ◐ (CGM) | ◐ (carbs) | ● | ● | ● | — | ● AGPL | API/CSV/mongodump | free |
| Fasten Health | ◐ (records, no reminders) | ● | ● | — | — | ◐ | — | ◐ | ● | ● | — | ● GPL | FHIR/SQL | free |
| Home Assistant | ◐ (DIY) | ● | ● | ◐ | ● | ● | ◐ | ◐ | ● | ● | — | ● Apache | DB/CSV/API | free |
| GNU Health | ● (clinical) | ● | ● | ◐ | ◐ | ● | ● | ● | ◐ | ● | — | ● GPL | CSV/XML/SQL | free (hospital-grade) |
| *— multi-metric SaaS —* |
| Bearable | ◐ | ● | ● | ● | ● | ● | ◐ | ● | — | — | ◐ (client-enc, not ZK) | — | CSV (no import) | freemium $35/y |
| Guava Health | ● | ● | ● | ● | ● | ● | ● | ● | ● | — | — | — | CSV/PDF/FHIR API | freemium $78/y |
| Exist.io | ◐ | ◐ | ● | ● | ● | ● | ◐ | ● | ● | — | — | — | JSON/CSV + API | $63/y, no free tier |
| Cronometer | ◐ | ● | ● | ● | ● | ● | ● (best) | ● | ● | — | — | — | CSV | freemium $50/y, ads |

## Axis observations

- **Nobody else has the full row.** The only ● column sweep besides ours is Guava Health on features — but Guava is closed SaaS, server-side plaintext (required for its AI), US cloud.
- **E2EE column is nearly empty.** Apple (iOS lock-in, no web) and the local-only Android apps (no sync at all — privacy by amputation). No product combines E2EE *with* multi-device sync *and* self-hosting.
- **Med inventory/restock** (our rule-of-thumb differentiator inside meds): only Medisafe, MedM, Guava, GNU Health have it; Apple/Samsung explicitly lack stock tracking.
- **Self-host column**: all five self-hostable competitors store server-side plaintext, and all are domain-silos (workouts, CGM, records, home automation, hospital) — a self-hoster needs 4+ of them to match our eight domains.
- **Agent/MCP surface**: no competitor exposes anything comparable; nearest are conventional REST APIs (Exist, wger, Nightscout, Guava beta FHIR).
