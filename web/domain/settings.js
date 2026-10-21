// Runtime-agnostic Settings domain module. Pure logic over an injected
// records port — no window/document/fetch/IndexedDB — so the same file can
// later run inside the Go server via goja (C6) with a Go-backed records port.
// Mirrors internal/server/settings_handlers.go (general/features/tab-order)
// + internal/server/food_handlers.go (targets)
// + internal/server/settings_integrations_handlers.go (provider keys).
// Feature-flag defaults mirror internal/store/migrations/{022,025,073,074}_*.sql
// (weekly_digest and live_hr default off; everything else defaults on), except food, which
// defaults ON here and off in bot mode. Bot mode's shared settings row cannot
// tell "never configured" from "deliberately disabled", so migration 018 stays
// at DEFAULT 0; a fresh vault has no features record at all, so a cloud user
// who turns food off still keeps that choice.

const GENERAL_RECORD_TYPE = 'settings';
const GENERAL_RECORD_ID = 'settings';
const FEATURES_RECORD_TYPE = 'features';
const FEATURES_RECORD_ID = 'features';
const TABORDER_RECORD_TYPE = 'taborder';
const TABORDER_RECORD_ID = 'taborder';
const FOODTARGETS_RECORD_TYPE = 'foodtargets';
const FOODTARGETS_RECORD_ID = 'foodtargets';
const INTEGRATIONS_RECORD_TYPE = 'integrations';
const INTEGRATIONS_RECORD_ID = 'integrations';
// Own singleton rather than a field on the `settings` record: records are
// last-writer-wins whole-record, so a stale device writing the shared singleton
// (timezone / dismissed_tz_suggestion) with a newer clientTs would drop a
// first_run_complete it never saw and re-open the onboarding overlay. Nothing
// but setFirstRunComplete (and vault restore, vault.js vaultToRecords, at the
// clientTs floor) writes this record, and both only ever write `true`.
export const FIRSTRUN_RECORD_TYPE = 'firstrun';
export const FIRSTRUN_RECORD_ID = 'firstrun';
// Provisioned ElevenLabs voice agent state (agent id + toolset version + tool
// id map). Kept in its own vault singleton rather than the masked integrations
// record because it holds an object map, and because it is app-provisioned
// state, not a user-entered secret. Never reachable via any /api shim route.
const VOICEPROV_RECORD_TYPE = 'voiceprovisioning';
const VOICEPROV_RECORD_ID = 'voiceprovisioning';
// Same singleton the free-text Telegram agent reads/appends to
// (web/cloud/js/inbox-apply.js's TG_PREFS_TYPE, bd med-vcv.3) — this module
// adds the Settings UI's full-replace read/edit/clear view over that record.
// Keep type/id/cap in sync with inbox-apply.js's copy; not imported from
// there because that module pulls in apishim.js, and apishim.js is what
// wires THIS module's route (a cycle) — mirrors the DEFAULT_SNOOZE_MINUTES
// precedent in inbox-apply.js of duplicating a small constant across an
// unimportable boundary rather than restructuring around it.
const TG_PREFS_TYPE = 'tgprefs';
const TG_PREFS_RECORD_ID = 'tgprefs';
const TG_PREFS_MAX_CHARS = 4096;
// Explicit durable consent for the operator's trial AI/voice providers
// (bd med-yor.2). Independent scopes — `anon` (bd med-o7zq.16) is iOS local
// mode's one switch for the anonymous trial services through our server (the
// AI now, the operator's food database later); null = never asked, and only a
// literal `true` passes the client-side trial gate — skipping key setup is
// not consent. Deliberately NOT in vault.js's VAULT_MANAGED_TYPES: like `nk`
// and `voiceprovisioning` it survives import untouched, so consent never
// travels in backups (a fresh account asks fresh consent).
const TRIALCONSENT_RECORD_TYPE = 'trialconsent';
const TRIALCONSENT_RECORD_ID = 'trialconsent';
const TRIALCONSENT_SCOPES = ['ai', 'voice', 'tg', 'anon'];
// Whether the CURRENT Emergency Kit was saved (bd med-ckm5.2, epic med-ckm5
// decision 4): {savedAt, how: download|print|ack|none}, written by the kit
// page and read by Settings (S6 chip, S9 row). Synced so the wording is true
// across devices. `none` = no saved kit for the current code: either a new
// code was issued (the old kit is dead) and nobody confirmed saving it yet —
// the page stashes it before Continue, so an abandoned rotation reads as
// unsaved — or signup ran without the kit offer and no code exists yet
// (bd med-ta2n.8). Either way: remind, and regenerate makes a fresh kit. setEmergencyKit keeps the newer
// savedAt, so a stash filed late (cloud-boot drains it on the next unlocked
// open) never replaces a newer kit state from another device.
// Not in VAULT_MANAGED_TYPES: a backup restored into another account must not
// claim that account's kit was saved.
const EMERGENCYKIT_RECORD_TYPE = 'emergencykit';
const EMERGENCYKIT_RECORD_ID = 'emergencykit';
const EMERGENCYKIT_HOW = new Set(['download', 'print', 'ack', 'none']);
// The W4 protect-your-data nudge (bd med-ta2n.4): {lastBackupAt: ms|null,
// nudgeDismissedAt: [ms…]}. Written ONLY by deliberate actions — a backup
// file saved or shared (markBackup) and the card's × / Later (dismissNudge) — with now() +
// put. Never lazily materialized: an absent record reads as "never backed up,
// never dismissed", so CLAUDE.md rule 12's floor does not apply. Carried in
// the vault (data.protection) so a restored backup remembers its last backup.
export const PROTECTION_RECORD_TYPE = 'protection';
const PROTECTION_RECORD_ID = 'protection';
const DAY_MS = 24 * 60 * 60 * 1000;
// Shown once the log is worth losing: 20 records or 7 days since first run,
// whichever first; × snoozes 14 days; the second × stops it for good (the
// Settings chip, med-ta2n.5, keeps reading the status).
const PROTECT_MIN_RECORDS = 20;
const PROTECT_AFTER_MS = 7 * DAY_MS;
const PROTECT_SNOOZE_MS = 14 * DAY_MS;
const PROTECT_MAX_DISMISSALS = 2;

// SECRET_MASK mirrors secretMask in settings_integrations_handlers.go: GET
// returns this sentinel for non-empty secret fields (never the raw key), and
// PATCH treats a field submitted with this exact value as "leave unchanged".
const SECRET_MASK = '***';

const DEFAULT_INTEGRATIONS = {
  openai: {
    api_key: '', url: '', model: '', vision_api_key: '', vision_url: '', vision_model: '',
  },
  food: { api_key: '', url: '', domain: '' },
  elevenlabs: { api_key: '', agent_id: '' },
};

// Secret-bearing fields per group — masked on read, mask-preserves on write.
const INTEGRATIONS_SECRET_FIELDS = {
  openai: new Set(['api_key', 'vision_api_key']),
  food: new Set(['api_key']),
  elevenlabs: new Set(['api_key']),
};

const DEFAULT_FEATURES = {
  food: true,
  bp: true,
  weight: true,
  medication: true,
  workout: true,
  health: true,
  gamification: true,
  weekly_digest: false,
  // Experimental live-HR card on the Vitals screen (med-byks.1 POC): BLE
  // pairing over Web Bluetooth, off until the owner hardware-tests it.
  live_hr: false,
};

const DEFAULT_FOOD_TARGETS = { calories: 0, carbs: 0, protein: 0, fat: 0 };

// Valid tab IDs, ported from handleSetTabOrder (settings_handlers.go) — 'today'
// and 'settings' are not cards, so they are rejected same as server-side.
const VALID_TABS = new Set(['bp', 'weight', 'workouts', 'food', 'health', 'meds']);

function findSingleton(all, recordId) {
  return all.find((r) => r.recordId === recordId && !r.deleted);
}

// createSettingsDomain builds the Settings domain API over the injected ports:
//   records  — { list(type), put(type, record), del(type, id) }
//   now()    — current time in ms epoch
//   timeZone — IANA zone string used until the user overrides it via setTimezone
export function createSettingsDomain({ records, now, timeZone }) {
  async function getGeneral() {
    const all = await records.list(GENERAL_RECORD_TYPE);
    const rec = findSingleton(all, GENERAL_RECORD_ID);
    return {
      timezone: (rec && rec.timezone) || timeZone,
      dismissed_tz_suggestion: (rec && rec.dismissed_tz_suggestion) || '',
    };
  }

  // setTimezone merges onto the existing singleton record (rather than
  // replacing it) so it never clobbers dismissed_tz_suggestion — mirrors
  // repo.go's Record(), which only clears the dismissal on an actual TZ
  // change, never on every write.
  async function setTimezone(tz) {
    if (tz) {
      const all = await records.list(GENERAL_RECORD_TYPE);
      const existing = findSingleton(all, GENERAL_RECORD_ID);
      const changed = !existing || existing.timezone !== tz;
      await records.put(GENERAL_RECORD_TYPE, {
        ...existing,
        recordId: GENERAL_RECORD_ID,
        clientTs: now(),
        deleted: false,
        timezone: tz,
        dismissed_tz_suggestion: changed ? '' : (existing && existing.dismissed_tz_suggestion) || '',
      });
    }
    return getGeneral();
  }

  // setDismissedTzSuggestion mirrors tzsuggestion.Service.RecordDismissal —
  // persists the detected TZ the user dismissed so other devices skip the
  // same prompt (LWW via clientTs, same as every other singleton record).
  async function setDismissedTzSuggestion(tz) {
    const all = await records.list(GENERAL_RECORD_TYPE);
    const existing = findSingleton(all, GENERAL_RECORD_ID);
    await records.put(GENERAL_RECORD_TYPE, {
      ...existing,
      recordId: GENERAL_RECORD_ID,
      clientTs: now(),
      deleted: false,
      dismissed_tz_suggestion: tz || '',
    });
    return tz || '';
  }

  // Semantics: an ABSENT firstrun record means "needs onboarding". A vault
  // record cannot be backfilled the way bot-mode migration 071 backfilled its
  // SQLite column, so only an explicit true suppresses the overlay — vaults
  // predating this flag see onboarding once.
  async function getFirstRunComplete() {
    const all = await records.list(FIRSTRUN_RECORD_TYPE);
    const rec = findSingleton(all, FIRSTRUN_RECORD_ID);
    return !!(rec && rec.first_run_complete);
  }

  // picked (bd med-ta2n.1): the W1 module picks, in picker order ('diary' has
  // no feature flag), read by the W3 Today hints. A deliberate user write, so
  // now() + put — not a derived row.
  async function setFirstRunComplete(done, picked) {
    const rec = {
      recordId: FIRSTRUN_RECORD_ID,
      clientTs: now(),
      deleted: false,
      first_run_complete: !!done,
    };
    if (Array.isArray(picked)) rec.picked = picked.filter((k) => typeof k === 'string');
    await records.put(FIRSTRUN_RECORD_TYPE, rec);
    return !!done;
  }

  async function getFeatures() {
    const all = await records.list(FEATURES_RECORD_TYPE);
    const rec = findSingleton(all, FEATURES_RECORD_ID);
    return { ...DEFAULT_FEATURES, ...(rec && rec.flags) };
  }

  async function setFeature(feature, enabled) {
    if (!(feature in DEFAULT_FEATURES)) {
      const err = new Error(`Unknown feature: ${feature}`);
      err.code = 'unknown_feature';
      throw err;
    }
    const flags = await getFeatures();
    flags[feature] = !!enabled;
    await records.put(FEATURES_RECORD_TYPE, {
      recordId: FEATURES_RECORD_ID, clientTs: now(), deleted: false, flags,
    });
    return flags;
  }

  async function getTabOrder() {
    const all = await records.list(TABORDER_RECORD_TYPE);
    const rec = findSingleton(all, TABORDER_RECORD_ID);
    return (rec && rec.order) || null;
  }

  async function setTabOrder(order) {
    const list = Array.isArray(order) ? order : [];
    for (const tab of list) {
      if (!VALID_TABS.has(tab)) {
        const err = new Error(`Unknown tab ID: ${tab}`);
        err.code = 'invalid_tab';
        throw err;
      }
    }
    await records.put(TABORDER_RECORD_TYPE, {
      recordId: TABORDER_RECORD_ID, clientTs: now(), deleted: false, order: list,
    });
    return list;
  }

  async function getFoodTargets() {
    const all = await records.list(FOODTARGETS_RECORD_TYPE);
    const rec = findSingleton(all, FOODTARGETS_RECORD_ID);
    if (!rec) return { ...DEFAULT_FOOD_TARGETS };
    return { calories: rec.calories, carbs: rec.carbs, protein: rec.protein, fat: rec.fat };
  }

  async function setFoodTargets(targets) {
    const t = {
      calories: (targets && targets.calories) | 0,
      carbs: (targets && targets.carbs) | 0,
      protein: (targets && targets.protein) | 0,
      fat: (targets && targets.fat) | 0,
    };
    if (t.calories < 0 || t.carbs < 0 || t.protein < 0 || t.fat < 0) {
      const err = new Error('Targets must be non-negative');
      err.code = 'invalid_targets';
      throw err;
    }
    await records.put(FOODTARGETS_RECORD_TYPE, {
      recordId: FOODTARGETS_RECORD_ID, clientTs: now(), deleted: false, ...t,
    });
    return t;
  }

  // getStoredIntegrations returns the unmasked values held in the vault
  // record (encrypted at rest like every other record — see sync.js), with
  // every field defaulted so groups/fields never seen before read as ''
  // rather than undefined.
  async function getStoredIntegrations() {
    const all = await records.list(INTEGRATIONS_RECORD_TYPE);
    const rec = findSingleton(all, INTEGRATIONS_RECORD_ID);
    const out = {};
    for (const group of Object.keys(DEFAULT_INTEGRATIONS)) {
      out[group] = { ...DEFAULT_INTEGRATIONS[group], ...(rec && rec[group]) };
    }
    return out;
  }

  // getIntegrations mirrors handleGetIntegrations: secret fields are masked
  // to SECRET_MASK when set, '' when unset, so the caller can tell
  // "configured" apart from "not configured" without ever reading the key.
  async function getIntegrations() {
    const stored = await getStoredIntegrations();
    const out = {};
    for (const group of Object.keys(stored)) {
      out[group] = {};
      for (const field of Object.keys(stored[group])) {
        const value = stored[group][field];
        out[group][field] = INTEGRATIONS_SECRET_FIELDS[group].has(field)
          ? (value ? SECRET_MASK : '')
          : value;
      }
    }
    return out;
  }

  // patchIntegrations mirrors handleUpdateIntegrations: groups omitted from
  // patch are untouched; within a provided group, fields not present as an
  // own property are untouched (server's *string nil case), an explicit ''
  // clears, SECRET_MASK on a secret field preserves the existing value
  // (resolveSecretPatch), and any other string overwrites.
  async function patchIntegrations(patch) {
    const stored = await getStoredIntegrations();
    for (const group of Object.keys(DEFAULT_INTEGRATIONS)) {
      const groupPatch = patch && typeof patch[group] === 'object' ? patch[group] : null;
      if (!groupPatch) continue;
      for (const field of Object.keys(DEFAULT_INTEGRATIONS[group])) {
        if (!Object.prototype.hasOwnProperty.call(groupPatch, field)) continue;
        const incoming = groupPatch[field];
        if (INTEGRATIONS_SECRET_FIELDS[group].has(field) && incoming === SECRET_MASK) continue;
        stored[group][field] = typeof incoming === 'string' ? incoming : '';
      }
    }
    await records.put(INTEGRATIONS_RECORD_TYPE, {
      recordId: INTEGRATIONS_RECORD_ID, clientTs: now(), deleted: false, ...stored,
    });
    return getIntegrations();
  }

  // getVoiceProvisioning / setVoiceProvisioning persist the app-provisioned
  // ElevenLabs agent id, toolset version, and tool-id map in the vault so
  // elevenlabs-agent.js can reprovision only when the version changes.
  async function getVoiceProvisioning() {
    const all = await records.list(VOICEPROV_RECORD_TYPE);
    const rec = findSingleton(all, VOICEPROV_RECORD_ID);
    return {
      agentId: (rec && rec.agentId) || '',
      toolsetVersion: (rec && rec.toolsetVersion) || 0,
      toolIds: (rec && rec.toolIds) || {},
    };
  }

  async function setVoiceProvisioning({ agentId, toolsetVersion, toolIds }) {
    await records.put(VOICEPROV_RECORD_TYPE, {
      recordId: VOICEPROV_RECORD_ID,
      clientTs: now(),
      deleted: false,
      agentId: agentId || '',
      toolsetVersion: toolsetVersion || 0,
      toolIds: toolIds || {},
    });
    return getVoiceProvisioning();
  }

  // getTrialConsent / setTrialConsent back the trial-provider consent gate:
  // aiclient.js / elevenlabs-call.js refuse trial transmission unless the
  // relevant scope reads exactly `true`. setTrialConsent merges a partial
  // {ai?, voice?, tg?, anon?} of booleans over the existing record — non-boolean
  // values are ignored, so a malformed patch can never widen consent.
  async function getTrialConsent() {
    const all = await records.list(TRIALCONSENT_RECORD_TYPE);
    const rec = findSingleton(all, TRIALCONSENT_RECORD_ID);
    const out = { updated_at: (rec && rec.updated_at) || 0 };
    for (const scope of TRIALCONSENT_SCOPES) {
      out[scope] = rec && typeof rec[scope] === 'boolean' ? rec[scope] : null;
    }
    return out;
  }

  async function setTrialConsent(patch) {
    const cur = await getTrialConsent();
    for (const scope of TRIALCONSENT_SCOPES) {
      if (patch && typeof patch[scope] === 'boolean') cur[scope] = patch[scope];
    }
    cur.updated_at = now();
    await records.put(TRIALCONSENT_RECORD_TYPE, {
      recordId: TRIALCONSENT_RECORD_ID, clientTs: now(), deleted: false, ...cur,
    });
    return cur;
  }

  // null = no kit save recorded on any device yet.
  async function getEmergencyKit() {
    const all = await records.list(EMERGENCYKIT_RECORD_TYPE);
    const rec = findSingleton(all, EMERGENCYKIT_RECORD_ID);
    return rec ? { savedAt: rec.savedAt, how: rec.how } : null;
  }

  async function setEmergencyKit(state) {
    const how = state && state.how;
    if (!EMERGENCYKIT_HOW.has(how)) {
      const err = new Error(`Unknown kit save method: ${how}`);
      err.code = 'invalid_kit_state';
      throw err;
    }
    const savedAt = Number.isFinite(state.savedAt) && state.savedAt > 0 ? state.savedAt : now();
    // records.put promotes clientTs past the stored row, so LWW alone would let
    // an older stash win; compare the save times instead.
    const existing = findSingleton(await records.list(EMERGENCYKIT_RECORD_TYPE), EMERGENCYKIT_RECORD_ID);
    if (existing && existing.savedAt >= savedAt) return { savedAt: existing.savedAt, how: existing.how };
    await records.put(EMERGENCYKIT_RECORD_TYPE, {
      recordId: EMERGENCYKIT_RECORD_ID, clientTs: savedAt, deleted: false, savedAt, how,
    });
    return { savedAt, how };
  }

  async function getProtection() {
    const rec = findSingleton(await records.list(PROTECTION_RECORD_TYPE), PROTECTION_RECORD_ID);
    return {
      lastBackupAt: (rec && Number.isFinite(rec.lastBackupAt)) ? rec.lastBackupAt : null,
      nudgeDismissedAt: (rec && Array.isArray(rec.nudgeDismissedAt)) ? rec.nudgeDismissedAt.filter(Number.isFinite) : [],
    };
  }

  async function putProtection(p) {
    await records.put(PROTECTION_RECORD_TYPE, {
      recordId: PROTECTION_RECORD_ID, clientTs: now(), deleted: false, ...p,
    });
    return p;
  }

  async function markBackup() {
    return putProtection({ ...(await getProtection()), lastBackupAt: now() });
  }

  async function dismissNudge() {
    const p = await getProtection();
    return putProtection({ ...p, nudgeDismissedAt: [...p.nudgeDismissedAt, now()] });
  }

  // records: the live user-record count (vault.js userContentCount), computed
  // by the caller. legacyDismissedAt: the old weekly toast's last stamp
  // (localStorage, owner-accepted 14-day grace) — a snooze baseline that
  // never counts as one of the two dismissals. firstRunAt: the firstrun
  // record's clientTs (0, a restored vault's floor, means unknown).
  async function getProtectionStatus({ records: count = 0, legacyDismissedAt = null } = {}) {
    const p = await getProtection();
    const fr = findSingleton(await records.list(FIRSTRUN_RECORD_TYPE), FIRSTRUN_RECORD_ID);
    const firstRunAt = (fr && fr.clientTs > 0) ? fr.clientTs : null;
    const stamps = [...p.nudgeDismissedAt];
    if (Number.isFinite(legacyDismissedAt) && legacyDismissedAt > 0) stamps.push(legacyDismissedAt);
    const lastDismissedAt = stamps.length ? Math.max(...stamps) : null;
    const t = now();
    const nudge = p.lastBackupAt == null
      && p.nudgeDismissedAt.length < PROTECT_MAX_DISMISSALS
      && (lastDismissedAt == null || t - lastDismissedAt >= PROTECT_SNOOZE_MS)
      && (count >= PROTECT_MIN_RECORDS || (firstRunAt != null && t - firstRunAt >= PROTECT_AFTER_MS));
    return {
      records: count,
      firstRunAt,
      lastBackupAt: p.lastBackupAt,
      dismissedCount: p.nudgeDismissedAt.length,
      lastDismissedAt,
      synced: false,
      nudge,
    };
  }

  // getTGPrefsNote / setTGPrefsNote back the Settings UI's Telegram agent
  // glossary field (bd med-vcv.4): read the note the agent has learned, or
  // FULL-REPLACE it (never append — that's inbox-apply.js's appendTGPref,
  // used only by the agent's own remember_preference tool). An empty string
  // is written verbatim and read back as '' — the deliberate "clear" case.
  async function getTGPrefsNote() {
    const all = await records.list(TG_PREFS_TYPE);
    const rec = findSingleton(all, TG_PREFS_RECORD_ID);
    return (rec && rec.note) || '';
  }

  async function setTGPrefsNote(note) {
    let clean = String(note || '').replace(/\r\n/g, '\n');
    if (clean.length > TG_PREFS_MAX_CHARS) clean = clean.slice(0, TG_PREFS_MAX_CHARS);
    await records.put(TG_PREFS_TYPE, {
      recordId: TG_PREFS_RECORD_ID, clientTs: now(), deleted: false, note: clean,
    });
    return clean;
  }

  return {
    getGeneral,
    getFirstRunComplete,
    setTimezone,
    setDismissedTzSuggestion,
    setFirstRunComplete,
    getFeatures,
    setFeature,
    getTabOrder,
    setTabOrder,
    getFoodTargets,
    setFoodTargets,
    getIntegrations,
    patchIntegrations,
    getTrialConsent,
    setTrialConsent,
    getEmergencyKit,
    setEmergencyKit,
    getProtection,
    markBackup,
    dismissNudge,
    getProtectionStatus,
    getTGPrefsNote,
    setTGPrefsNote,
    getVoiceProvisioning,
    setVoiceProvisioning,
    // readIntegrationsUnmasked exposes raw provider keys for module-to-module
    // consumption only (web/cloud/js/aiclient.js, the food-DB port) — never
    // reachable via any shim route; getIntegrations()'s masked shape stays
    // the only /api-facing view.
    readIntegrationsUnmasked: getStoredIntegrations,
  };
}
