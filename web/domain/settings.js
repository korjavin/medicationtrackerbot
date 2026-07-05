// Runtime-agnostic Settings domain module. Pure logic over an injected
// records port — no window/document/fetch/IndexedDB — so the same file can
// later run inside the Go server via goja (C6) with a Go-backed records port.
// Mirrors internal/server/settings_handlers.go (general/features/tab-order)
// + internal/server/food_handlers.go (targets). Feature-flag defaults mirror
// internal/store/migrations/{022,025,073,074}_*.sql (food_intake and
// weekly_digest default off; everything else defaults on).

const GENERAL_RECORD_TYPE = 'settings';
const GENERAL_RECORD_ID = 'settings';
const FEATURES_RECORD_TYPE = 'features';
const FEATURES_RECORD_ID = 'features';
const TABORDER_RECORD_TYPE = 'taborder';
const TABORDER_RECORD_ID = 'taborder';
const FOODTARGETS_RECORD_TYPE = 'foodtargets';
const FOODTARGETS_RECORD_ID = 'foodtargets';

const DEFAULT_FEATURES = {
  food: false,
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
    return { timezone: (rec && rec.timezone) || timeZone };
  }

  async function setTimezone(tz) {
    if (tz) {
      await records.put(GENERAL_RECORD_TYPE, {
        recordId: GENERAL_RECORD_ID, clientTs: now(), deleted: false, timezone: tz,
      });
    }
    return getGeneral();
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

  return {
    getGeneral, setTimezone, getFeatures, setFeature, getTabOrder, setTabOrder, getFoodTargets, setFoodTargets,
  };
}
