# Mi Band live heart rate over Web Bluetooth — POC (med-byks.1)

**Status:** in-app POC shipped behind the `live_hr` flag (default OFF);
hardware go/no-go pending owner testing. This doc is the POC writeup the
bead requires: parsing notes, the hrsample mapping, the downsampling
recommendation, and a blank results table for the owner to fill.

## Form

Per the owner's 2026-09-27 direction the POC ships **inside the app**,
not as a standalone page:

- Flag: `live_hr` in `web/domain/settings.js` (`DEFAULT_FEATURES`,
  default `false`), ported through `web/cloud/js/apishim.js`
  (`PORTED_SET`), toggled in Settings → Features →
  "Live Heart Rate (Experimental)" — the same per-feature enable
  mechanism every other flag uses, no new flag framework.
- Card: "Live heart rate" (`web/static/js/features/live-hr.js`,
  `window.LiveHR`) at the top of the Vitals overview. Hidden unless the
  flag is on **and** `window.Bluetooth.isSupported()` is true
  (Chromium-only; Safari/iOS/Firefox never see the card).
- Radio: `web/static/js/native/web/bluetooth.js` behind
  `window.Bluetooth` (HR-only surface: `isSupported`,
  `requestHeartRateDevice`, `subscribeHeartRate`/`unsubscribe`) —
  the only file allowed to touch `navigator.bluetooth` (Rule 10).
- **No persistence.** The card renders live bpm plus an in-memory
  session log (connect/disconnect events, time-to-first-reading,
  errors) with a Copy button. Nothing is written to `hrsample`;
  product wiring is med-byks.4.

## How to run the hardware test

1. Serve the app over a **secure context** (https origin or
   localhost) — Web Bluetooth is unavailable otherwise.
2. Settings → Features → enable "Live Heart Rate (Experimental)".
3. On the band or its companion app, enable **Discoverable** plus the
   heart-rate broadcast/sharing setting (Zepp Life / Mi Fitness —
   record the exact menu path below; on newer bands the broadcast
   may only be active **during a workout** — record which).
4. Vitals → Live heart rate → **Connect** (a user gesture is
   required), pick the band in the browser chooser.
5. Observe: live bpm, connection status, time-to-first-reading, and
   the session log. Copy the log into the results table.
6. Exercise the edge cases: walk out of range / kill the band's
   broadcast and note reconnect behavior; press Reconnect (must NOT
   re-show the chooser); Disconnect and Connect again (MUST re-show
   the chooser); hold a session past 60 s of notifications.

Desktop Chrome first, then Android Chrome (the realistic pairing
device).

## Mechanics (as implemented)

```
navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] })
  → device.gatt.connect()
  → getPrimaryService('heart_rate')            // 0x180D
  → getCharacteristic('heart_rate_measurement') // 0x2A37
  → startNotifications() → 'characteristicvaluechanged'
```

The `heart_rate` filter alone grants access to 0x180D, so no
`optionalServices` list is needed. The chooser grant is
**per-origin per-device** and survives disconnects: after an
unsolicited `gattserverdisconnected` the impl keeps the device
handle and a later `subscribeHeartRate()` reconnects without the
chooser. Only an explicit `unsubscribe()` (the card's Disconnect
button) drops the handle; the next session re-shows the chooser.

## 0x2A37 parsing notes (Heart Rate Measurement, SIG HRS 1.0)

Byte 0 is flags; the parser lives in
`web/static/js/native/web/bluetooth.js` (`parseHeartRateMeasurement`)
and is pinned by `web/static/js/tests/native.bluetooth.test.js`.

| Bits | Meaning |
|---|---|
| 0 | HR format: `0` = uint8 bpm at byte 1; `1` = uint16 LE bpm at bytes 1–2 |
| 1–2 | Sensor contact: `00`/`01` = unknown, `10` = not detected, `11` = detected |
| 3 | Energy Expended present (uint16 follows the HR bytes; parsed past, not surfaced) |
| 4 | RR-intervals present (uint16 LE each, 1/1024 s units, after the energy field; surfaced in whole ms) |
| 5–7 | Reserved |

Surfaced reading shape: `{ bpm, contact, rrIntervals, timestamp }`
with `contact` one of `unknown` / `absent` / `detected`.
A truncated datagram is dropped without killing the stream.

## Mapping to the hrsample data model

Each parsed reading maps 1:1 onto one `hrsample` sample element:
`{ date_time, tz_offset, value }` with `date_time` the reading's
RFC3339 instant, `tz_offset` the device's UTC offset in minutes, and
`value` the bpm — merged by instant into the day-batched
`hrsample-YYYY-MM-DD` record via the existing
`importDayBatched(recordType, samples)` path in
`web/domain/vitals.js` (the same path the `.nxk` import uses), so
re-applied imports overwrite rather than duplicate. The POC
deliberately does not implement this write path.

## Downsampling recommendation

Live BLE HR arrives at ~1 Hz; imported and seeded HR sit on the
**15-minute `hrCadence` grid anchored to 00:00 UTC**
(`internal/cloudserver/vitals_import.go`, mirrored in
`internal/seeddemo`). Recommendation for med-byks.4: **snap ambient
live readings to that same grid** (first sample per bucket, the
existing `downsampleSamples` rule), so live, imported, and seeded HR
land on one grid and dedupe for free. Do NOT store raw 1 Hz
ambient data — a day of it would dwarf the 96-sample grid day and
churn the sync log for no graph-visible gain. If per-workout
fidelity is wanted later, gate denser storage on an explicit
workout session (bounded duration, separate product decision), never
on ambient streaming.

## Results (owner fills)

Band + environment:

| # | Band model | Firmware | Companion app + version | Exact setting path that enables broadcast | Broadcast always-on or workout-only? |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |

Desktop Chrome:

| # | Chrome version / OS | First reading? | Time to first reading | 60 s+ of notifications held? | Notes (flakes, drops, chooser repeats) |
|---|---|---|---|---|---|
| 1 | | | | | |

Android Chrome:

| # | Chrome version / device / Android | First reading? | Time to first reading | 60 s+ of notifications held? | Notes |
|---|---|---|---|---|---|
| 1 | | | | | |

Connection UX:

| Question | Observation |
|---|---|
| Time to first reading (typical) | |
| Reconnect after drop: chooser re-shown? | (expected: no — grant persists; Disconnect re-shows it) |
| How often must the chooser be re-shown? | |
| Longest stable notification session | |

Pasted session log(s):

```
(paste the card's copied log here)
```

## Go / no-go

- **Go** if a real HR reading from a real Mi Band renders in
  desktop Chrome, holds 60 s of notifications, and reconnects
  without friction; Android Chrome confirms the realistic path.
- **No-go** if the band cannot be made to expose 0x180D at all, or
  the connection cannot hold 60 s. If no-go for Mi Band
  specifically, note whether any standard BLE HR strap
  (Polar/Garmin/Coospo) proves the profile path instead — and name
  which.

**Verdict:** _go / no-go — (fill after testing)_
