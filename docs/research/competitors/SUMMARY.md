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
