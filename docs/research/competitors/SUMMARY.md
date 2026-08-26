# Competitor Research — Morning Summary

*2026-08-26. 22 competitors researched (per-file details + sources in this folder; matrix in [MATRIX.md](MATRIX.md)).*

## The one-paragraph verdict

Our position — **zero-knowledge E2EE + self-hosted + all eight health domains in one PWA** — is genuinely unoccupied. Every competitor gives up at least one leg of that tripod: commercial multi-metric apps (Guava, Bearable, MedM, Cronometer) run on server-side plaintext SaaS; self-hosted OSS (wger, Nightscout, Fasten, Home Assistant, GNU Health) stores plaintext on the server and is single-domain; local-only privacy apps (Gadgetbridge, openScale, Waistline, Drip) achieve privacy by having no sync, no web access, and one domain each; Apple Health has real E2EE but is welded to iOS hardware with no web surface.

## The three competitors that matter

1. **Guava Health** ($78/y SaaS) — the feature-set doppelgänger: all eight domains including med inventory, drug interactions, AI food photo logging, an LLM assistant, plus what we lack: 50k+ US patient-portal/FHIR connections. It's the proof that the market wants a unified personal health hub — and its unavoidable server-side plaintext (its AI needs it) is exactly the trust gap we exploit.
2. **MedM Health** — closest commercial architecture match (web + mobile + offline mode, CSV in/out, low lock-in) and 750+ Bluetooth medical devices vs our Mi Band import. Watch its device-connectivity moat.
3. **Apple Health** — the only other real E2EE story, plus native watch hardware. Its lock-in (no web, no Android, no self-hosting, weak med inventory) is our counter-pitch, but for iPhone-only users it's "good enough" privacy.

## Gaps we own (from _landscape.md, verified against the files)

- **Unified suite for self-hosters** — today they must run wger + openScale + Waistline + Nightscout side by side, four dashboards, no shared reminders.
- **Zero-knowledge sync** — every rival treats server plaintext as the price of sync/analytics/notifications; our blind push relay disproves that.
- **AI-agent (MCP) surface** — literally no competitor has one; best-in-class elsewhere is a REST API.
- **PWA distribution** — the privacy-first field is almost entirely native Android binaries on F-Droid; we run in any browser, no app store gatekeeper.

## Where we're behind

- **EHR/clinical records**: Fasten and Guava pull real FHIR records from tens of thousands of institutions; we have nothing there.
- **Wearable breadth**: MedM 750+ devices, Gadgetbridge 100+ watches; we import Mi Band `.nxk` files.
- **Native watch/wrist reminders**: Medisafe/MyTherapy/Apple/Samsung all ring on the wrist; web push is our ceiling.
- **Food database depth**: Cronometer's 80+ verified micronutrients is the bar; our Open-Food-Facts-class coverage is far below it.

## Cautionary tales worth remembering

- **Round Health**: beloved, free, acquired by Alto Pharmacy 2020, delisted, zero export — users lost everything. Our encrypted full-vault export/import is the insurance policy competitors keep proving is needed (Dosecast still has no export at all).
- **Google Fit**: web portal and REST APIs deprecated under users' feet — vendor-cloud dependence is a platform risk, not a convenience.
- **Flo/Clue FTC scrutiny**: monetizing health data is a trust time-bomb; zero-knowledge architecture makes the failure mode impossible rather than promised away.

## Suggested next moves (not filed as beads — say the word)

1. Position marketing copy explicitly against the "4 apps + 4 dashboards" self-hoster status quo and the "privacy = no sync" local-only trade-off.
2. Consider a Health Connect / Apple Health *import* bridge — it would neutralize the wearable-breadth gap by piggybacking on ecosystems that already aggregate device data.
3. Keep an eye on Guava's FHIR/API beta and Health Connect's FHIR medication schema — clinical-records import is the biggest genuine feature gap.

---

# Phase 2 — Customers, Why They Win, How We Win

*Appended 2026-08-26 after the four-dimension deep dive (customer base, killer features, marketing, counter-positioning). Per-competitor detail: `## Phase 2` section in each dossier.*

## Market size ladder (what "success" looks like at each tier)

| Tier | Products | Scale | How they got it |
|---|---|---|---|
| OS defaults | Apple Health, Samsung Health, Health Connect | 100M–1B+ devices | Pre-installation. Not a competable channel — integrate via import bridges instead. |
| VC/corporate med trackers | Medisafe (~7M MAU claimed, $51.5M VC), MyTherapy (12M patients claimed, Redcare-owned) | millions | Pharma B2B2C programs, doctor pads, ASO on "pill reminder" |
| Bootstrapped niche SaaS | Cronometer (~$3.8M ARR), MedM (~$2.2M ARR), Bearable (~$360k ARR), Exist (~$150k ARR) | 10k–1M MAU | Owning one niche deeply (micronutrients, BT devices, chronic illness, QS) |
| OSS | Loop Habit (5M+ downloads), Home Assistant (671k live instances), Gadgetbridge/openScale (~100k), Nightscout (~50k setups) | 10k–5M | F-Droid, awesome-selfhosted, subreddits, privacy directories — zero ad spend |
| Dead | Round Health (acquired→delisted), Fasten Health (archived Jul 2026, verified) | — | Cautionary: acquisition and maintainer burnout both kill; export is the user's only insurance |

Realistic benchmark for us: the OSS/self-hosted tier's winners reach 50k–250k active users on community channels alone; the bootstrapped-SaaS tier shows a single deep niche can sustain $1–4M ARR without VC.

## The marketing playbook, ranked by transplantability

1. **Community advocacy beats ad spend everywhere in our segment.** Nightscout's #WeAreNotWaiting (emotional, patient-led), Bearable's founder-run subreddit presence, Drip's privacy-directory endorsements (EFF, Privacy Guides, Mozilla). *Do: be listed in awesome-selfhosted + privacy directories; show up authentically in r/selfhosted; our CI-enforced privacy claims (CSP allowlist, ciphertext-only server) are audit-invitations — the Gadgetbridge "no INTERNET permission" archetype.*
2. **Refugee capture is the highest-ROI SEO.** Cronometer grew on MyFitnessPal paywall refugees; Medisafe's 2-med free cap, Round Health's death, and Fasten's archival all strand users today. *Do: "Medisafe free alternative", "Round Health replacement", "Fasten Health alternative" landing content with import paths.*
3. **B2B2C offline channels work for med adherence** (Medisafe pharma programs, MyTherapy doctor pads, MedM device-vendor bundling). *Do cheaply: a printable "recommend to privacy-conscious patients" one-pager for physicians/pharmacists.*
4. **Niche SEO/ASO terms are winnable** (Dosecast owns "PRN interval reminder"; MedM owns "bluetooth BP log"). *Do: target long-tail privacy+health terms nobody owns: "self-hosted medication tracker", "E2EE health tracking".*

## Feature asks the research surfaced (validated by rivals' users)

- **Doctor-visit PDF brief** — the single most-repeated decision driver across Guava, MyTherapy, Bearable users; trivially compatible with zero-knowledge (client-side render).
- **Flexible dose windows** (Round Health's beloved anti-alarm-anxiety model) and **PRN rolling-interval dosing** ("6h after last dose" — Dosecast's moat; chronic-pain niche).
- **Web Bluetooth for standard GATT profiles** (BP 0x1810, glucose 0x1808, HR 0x180D) — neutralizes MedM/openScale device stories in-browser.
- **Apple Health XML / Health Connect import bridge** — neutralizes the wearable-breadth gap and doubles as a "decode Apple's XML blob" acquisition tool.
- **Per-metric permission sheet UX** (Health Connect's most-praised pattern) and a **<5s daily summary** on open (Samsung's Energy Score lesson).
- **Caregiver escalation** (Medisafe's Medfriend is its #1 driver) — hard for us; a blind-relay-based missed-dose alert to a chosen contact is the zero-knowledge-compatible shape.

## Battlecard themes (the lines that hold up)

- **vs SaaS** (Guava, Bearable, Cronometer, Medisafe): "Encrypted at rest but *vendor-readable* — they hold the keys. We can't read your data even if subpoenaed, breached, or acquired." Plus: no subscription, no med cap, no ads.
- **vs local-only FOSS** (Gadgetbridge, openScale, Waistline, Drip, Loop): "They make you choose between privacy and sync. Sync without trust ends that trade-off." (Phone dies = data dies, is the pain to name.)
- **vs self-hosted OSS** (wger, Nightscout, Home Assistant): one app instead of four, zero-knowledge instead of server plaintext — and Fasten's archival is the maintenance-burden proof point.
- **vs ecosystems** (Apple, Samsung, Google): don't fight pre-installation; sell cross-platform web access + no hardware lock-in, and *import* their exports.
- **Honest losses to keep neutralizing**: passive sensor capture, wrist-native alarms, Cronometer-grade food DB, FHIR clinical records. Never claim parity; claim the trade is worth it and shrink the gap with imports.
