# Health source labels — med-w6gx.32

Approved by Developer, 2026-10-30 (Zulip 9501). Frames: `../claude-design/ui_kits/app-v2/screens-health-sources.html` HS1–HS4.

BP and weight history should distinguish Health imports from readings entered elsewhere. Sleep has a chart, not history rows: show a quiet summary of the sources represented in the active range below that chart. No new list, native changes, stored fields or import path.

Current surfaces: `web/static/js/features/bp.js:560` (`buildBPReadingRow`), `weight.js:1131` (`buildWeightHistoryRow`), `health.js:220` (`renderSleepCard`), `web/domain/vitals.js` (daily fold). Current visuals inspected in run 41115082164 at 508588715: iphone-390/health-bp.png, weight.png, health-vitals.png. Neighbours: screens-bmi.html BM1 and existing Health navigation. Existing chart and row actions stay as shipped.

Recommendation: small muted **Health import** text on BP/weight metadata rows; no new label without the shared Health marker. Sleep: **Sources · Health import · Mi Band · Other sources**, including only values present in displayed nights, deduplicated in that order. A homogeneous range names just its source; an empty range has no line. Missing or unknown markers remain Other sources. Wrap naturally, never replace status/sync chips.

Archie confirmed the shared marker cannot identify the originating platform and approved an optional per-day sources field on the existing daily fold after visibleSleep (Zulip 9427). Never infer provenance from the viewing device. Developer approved placement and copy in HS1–HS4 (9501), with BP/Weight limited to the small source text. Dark kit, 390×844; same layout across devices, no new component.

Owner clarification 2026-10-30 (9492/9493): BP and Weight only gain source text. HS1/HS2 are now focused row excerpts, without surrounding mock navigation/filters. No surrounding UI changes are authorised.
