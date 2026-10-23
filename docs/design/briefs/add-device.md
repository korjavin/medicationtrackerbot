# Brief — Add a device (approve on the origin device)

Short single-feature brief (claude-design skill, "Owner decisions"). Screens land in
`ui_kits/app-v2/screens-add-device.html` as AD1…; beads reference them as
`Spec: screens-add-device.html ADn`. Epic `med-r1j2` (protocol v2 is in the epic).

## What it does

Adds a second device to an existing account by scanning a QR or opening a link. It is
secure: a stolen or old code never lets anyone join, and nobody joins without the owner's
approval on the device that showed the code. Both devices show the same 6-digit **match code**,
and the owner approves only when the codes match. Each device gets **its own passkey**; this
is not "enrol another passkey on this device". It works in every direction: web, iOS and
Android, in any combination.

Owner decisions (Zulip msg 3407): if the joining device has local data, it is **erased** after
an explicit confirmation that names the account being joined (no merge). Approval on the
origin device is required. The key is released only to the approved device.

## Screens wanted

**Origin device** (Settings → Devices & connectors → "Add a device"; `med-r1j2.2`)
- **AD1 Start.** "Unlock with your passkey to create a one-time code. This does not create a
  new passkey." One primary: Unlock.
- **AD2 Waiting.** QR + "Copy link" + the typed fallback code. Hint: "Single use · expires in
  10 min · you approve the join here". A countdown and Cancel.
- **AD3 Approve.** "<Android app> wants to join" with the match code in large mono digits:
  "Does your new device show this code?" Approve (primary) / Deny.
- **AD4 End states.** Done ("<platform> can now open your account"), Expired, Denied/Cancelled,
  and "Someone else tried to use this code" (bad proof; Cancel only, danger tone).

**New device** (`/claim`, `med-r1j2.3`)
- **AD5 Waiting.** Two beats: first "Connecting to your other device…" (no code yet), then the
  match code, large: "Approve this on the device that showed the QR" (protocol v2: the code
  appears on both devices before Approve, and nothing is released until then). Line: "This device gets its own passkey. Your existing passkeys keep working."
- **AD6 Approved → creating this device's passkey**, then into the account.
- **AD7 End states.** Taken by someone else (409), and Expired/Denied/Cancelled (410), each with
  "Ask for a new code on your other device".

**Hand-off and local app** (`med-r1j2.4`)
- **AD8 /d/ landing.** A twin of invite landing L1–L3: "Open in the app" / "Continue in this
  browser" / store buttons; desktop variant; a no-fragment variant ("Scan the code again on
  your other device").
- **AD9 Join and erase.** Local-mode app, after the scan: "Join <sub>.<base>? Everything on
  this phone (N records) will be erased after this phone is added." Join and erase (destructive)
  / Cancel. Local data stays until enrolment succeeds.

**Synced passkey** (`med-r1j2.5`, P3)
- **AD10 "I already have a passkey — open my account".** An entry on the W5 Sync page and on the
  AD8 browser path. An address field that accepts `<sub>.<base>` or an https URL on it, an
  invalid-address state, and "Nothing on this device changes".

**Devices list** (`med-r1j2.6`, P3)
- **AD11 Rows and notice.** Rows "<Platform> · added 23 Oct", "This device" marked (with the
  caveat that a synced passkey can live on several devices), and the toast "New device added:
  <platform>, <date>" with Revoke.

## Neighbouring kit screens

S4 Devices & connectors, S5 destructive confirm, D1 dialog family, onboarding v3 L1–L3 invite
landing, P3 incoming invite, F1 "Have an invite?" sheet, W5 Sync & backup.

## Constraints

`wg-*` kit v2 at 390×844, dark only; the desktop landing at 1280. One sun-filled control per
view (kit rule 1). Flows put the primary in `.wg-pagefoot` / `.wg-shell__foot` (rule 8).
Destructive steps go through `.wg-dialog` (rule 3). Status only via tokens; no emoji. No native
dialogs. The match code is mono, grouped as 3+3, and never the only thing that tells two
states apart.

## Owner decisions on the brief (2026-10-23, msg 3452)

1. AD3: a single **Approve** under "Does your new device show this code?" is enough.
2. AD9 Join and erase is a **D1 dialog** (destructive), not a sheet.
3. AD10 is a quiet secondary link under the W5 invite entry (and on the AD8 browser path).

## Follow-up (2026-10-23, Archie msg 3532) — next pass

- Draw **AD10 · none**: no synced passkey found on this device → /unlock's existing fallback,
  offering "Add this device from another device" (the QR flow).
- **AD12** (med-r1j2.9) origin in background: a `.wg-notif` "Approve the new device?" /
  "<platform> is waiting · code expires in N min"; tapping it opens AD3.
- **AD13** (med-r1j2.10) in-app Scan on the joining device, with camera denied: the AD8 · no code
  layout (the typed field) plus an "Allow camera in Settings" ghost link.
- Typed code (Archie msg 3536): the full secret, 28 letters, letters only, in 3-letter groups
  wrapped to two lines in `.wg-code` and in the input; paste accepts it with or without
  separators, in any case. Redraw AD2 / AD8 · no code / AD8 · desktop with a real-length sample
  (no digits: "7PM" becomes letters).
