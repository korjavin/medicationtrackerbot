// Apple Health → vault import (bd med-w6gx.6). Pure logic over the injected
// records port, like every web/domain module: the iOS shell hands over raw
// HealthKit samples (web/cloud/js/health-import.js fetches them through
// window.Health), and this maps them onto the EXISTING bp / weight record
// shapes through their own domain create().
//
// Idempotent by construction: the recordId is derived from the HealthKit sample
// UUID, so a re-import, a reset anchor, or a second iPhone reading the same
// iCloud-synced Health data lands on the same slot. That makes it a derived
// write (CLAUDE.md rule 12): clientTs 0 via putIfAbsent, so an import never
// overwrites an edit to that reading and never resurrects a deleted one (a
// tombstone occupies the slot).
//
// The only new field is the optional `source: 'apple_health'`; clients that
// predate it ignore it (toResponse picks known fields).
import { createBPDomain } from './bp.js';
import { createWeightDomain } from './weight.js';

export const HEALTH_SOURCE = 'apple_health';

// HKObject.uuid.uuidString — also keeps the recordId free of anything odd.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function healthRecordId(kind, uuid) {
  return `${kind}-hk-${String(uuid).toLowerCase()}`;
}

function positive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// createHealthImportDomain({ records, now, timeZone }) — records must carry
// listRaw and putIfAbsent (web/cloud/js/sync.js recordsPort).
export function createHealthImportDomain({ records, now, timeZone }) {
  const bp = createBPDomain({ records, now, timeZone });
  const weight = createWeightDomain({ records, now, timeZone });

  // Sample shapes come from ios/App/Health.swift: start is ms epoch, BP in
  // mmHg, body mass in kg.
  const KINDS = {
    bp: {
      valid: (s) => positive(s.systolic) && positive(s.diastolic),
      create: (s, opts) => bp.create({
        measured_at: s.start,
        systolic: Math.round(s.systolic),
        diastolic: Math.round(s.diastolic),
        source: HEALTH_SOURCE,
      }, opts),
    },
    weight: {
      valid: (s) => positive(s.kg),
      create: (s, opts) => weight.create({
        measured_at: s.start,
        weight: Math.round(s.kg * 100) / 100,
        source: HEALTH_SOURCE,
      }, opts),
    },
  };

  // importSamples(kind, samples) → { added }: the readings that were new here.
  // Malformed samples are skipped, never thrown on — one odd entry in Health
  // must not stall every later import behind the same anchor.
  async function importSamples(kind, samples) {
    const k = KINDS[kind];
    if (!k) throw new Error(`healthimport: unknown kind ${kind}`);
    // Tombstones included: a deleted reading stays deleted.
    const have = new Set((await records.listRaw(kind)).map((r) => r.recordId));
    // Oldest first, so weight_trend builds forward over a first import.
    // ponytail: weight.create re-lists per call (O(n²) on a first import of
    // years of history); batch the trend if that ever shows up as slow.
    const fresh = (Array.isArray(samples) ? samples : [])
      .filter((s) => s && UUID_RE.test(s.uuid) && Number.isFinite(s.start) && k.valid(s))
      .sort((a, b) => a.start - b.start);
    let added = 0;
    for (const s of fresh) {
      const recordId = healthRecordId(kind, s.uuid);
      if (have.has(recordId)) continue;
      have.add(recordId);
      await k.create(s, { recordId, derived: true });
      added++;
    }
    return { added };
  }

  return { importSamples };
}
