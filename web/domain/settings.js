// Runtime-agnostic Settings domain module. Pure logic over an injected
// records port — no window/document/fetch/IndexedDB — so the same file can
// later run inside the Go server via goja (C6) with a Go-backed records port.
// Mirrors internal/server/settings_handlers.go (general/features/tab-order)
// + internal/server/food_handlers.go (targets)
// + internal/server/settings_integrations_handlers.go (provider keys).
// Feature-flag defaults mirror internal/store/migrations/{022,025,073,074}_*.sql
// (weekly_digest defaults off; everything else defaults on), except food, which
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
// but setFirstRunComplete writes this record, and it only ever writes `true`.
const FIRSTRUN_RECORD_TYPE = 'firstrun';
const FIRSTRUN_RECORD_ID = 'firstrun';
// Provisioned ElevenLabs voice agent state (agent id + toolset version + tool
// id map). Kept in its own vault singleton rather than the masked integrations
// record because it holds an object map, and because it is app-provisioned
// state, not a user-entered secret. Never reachable via any /api shim route.
const VOICEPROV_RECORD_TYPE = 'voiceprovisioning';
const VOICEPROV_RECORD_ID = 'voiceprovisioning';

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

  async function setFirstRunComplete(done) {
    await records.put(FIRSTRUN_RECORD_TYPE, {
      recordId: FIRSTRUN_RECORD_ID,
      clientTs: now(),
      deleted: false,
      first_run_complete: !!done,
    });
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
    getVoiceProvisioning,
    setVoiceProvisioning,
    // readIntegrationsUnmasked exposes raw provider keys for module-to-module
    // consumption only (web/cloud/js/aiclient.js, the food-DB port) — never
    // reachable via any shim route; getIntegrations()'s masked shape stays
    // the only /api-facing view.
    readIntegrationsUnmasked: getStoredIntegrations,
  };
}
