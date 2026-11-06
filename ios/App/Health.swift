import Foundation
import HealthKit

/// window.Health on iOS (bd med-w6gx.6): HealthKit import, plus the opt-in
/// write-back of bp/weight (bd med-8f4s.3), a bp entry's pulse as hr (bd
/// med-8f4s.8) and completed workout sessions (bd med-8f4s.10). The page asks;
/// this answers with raw samples — mapping them into vault records is the web
/// domain layer's job (web/domain/healthimport.js), not the shell's.
///
/// Ops (web/static/js/native/health.js):
///   health.authorize {types, write?}     → Bool (false: no Health store on this device);
///     `write` (["bp", "weight", "hr", "workout"]) also asks share access, in the same sheet
///   health.writeAccess {types}           → {granted: [kind], supported: ["bp", "weight", "hr", "workout"], readableFrom?: ms}
///     (granted: every share type of the kind authorized; readableFrom: the limited-history
///     boundary, 0 when every sample is readable; omitted when iOS 27 can't say, see readableFromMs)
///   health.write {type, id, version, at, systolic, diastolic | kg | bpm} → true, rejects "denied"
///   health.write {entries: [body, ...]}  → [true | "<that entry's error>", ...] in order (bd med-8f4s.14)
///     (each body = a single write's args; "denied" or a store error throws the whole call)
///     Resolves true iff the store then holds this app's id at a version >=
///     the one sent: a store error is re-checked by held() (an equal or lower
///     replay — a Copy from a second device — is true), else it rethrows.
///   health.write {type: "workout", id, version, start, end, activity: 50 | 3000} → true
///     (an HKWorkout, strength training or other, start…end in ms; nothing attached)
///   health.delete {type, id}             → true (nothing written under `id`: a no-op)
///     Our identity: HKMetadataKeySyncIdentifier = the vault recordId on the
///     sample (weight), correlation (bp; members <id>/sys, <id>/dia),
///     heart-rate sample (hr; the page sends <bp recordId>/pulse, stored
///     verbatim) or workout (the session recordId), with
///     HKMetadataKeySyncVersion = version, so the same id again replaces.
///     delete matches only that identity from this app's own source — never
///     an HK UUID, so an imported row's id (weight-hk-<uuid>) deletes nothing.
///     The anchored bp/weight/hr/workout queries drop what this app wrote with
///     that identity, so the write-back is never imported back.
///   health.query {type, anchor?, limit?} → {samples, anchor, returned, more}
///     (returned: added + deleted objects HealthKit handed back)
///   health.query {type: "sleep", from, to} → {samples, from, to, returned: 0, more: false}
///     (no anchor: re-reads nights still settling — web/cloud/js/health-import.js)
///   health.query {type: "steps", from, to} → {samples: [{day, steps, tz}], returned: days, more: false}
///   health.query {type: "hr"|"spo2", anchor?, limit?, from?} → anchored pages of {uuid, start, value}
/// Kinds: "bp" (blood-pressure correlations), "weight" (body mass),
/// (bd med-w6gx.7) "sleep" (sleep-analysis samples) and "workout" (HKWorkout),
/// and (bd med-0xad.2) "steps" (daily step totals), "hr" (heart rate, bpm) and
/// "spo2" (oxygen saturation, percent). An unknown kind: authorize ignores it,
/// query rejects it.
@MainActor
enum Health {
    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    static let store = HKHealthStore()
    static let systolic = HKQuantityType(.bloodPressureSystolic)
    static let diastolic = HKQuantityType(.bloodPressureDiastolic)
    static let bodyMass = HKQuantityType(.bodyMass)
    static let sleepAnalysis = HKCategoryType(.sleepAnalysis)
    static let heartRate = HKQuantityType(.heartRate)
    static let energy = HKQuantityType(.activeEnergyBurned)
    static let distances = [HKQuantityType(.distanceWalkingRunning), HKQuantityType(.distanceCycling),
                            HKQuantityType(.distanceSwimming)]
    static let stepCount = HKQuantityType(.stepCount)
    static let oxygenSaturation = HKQuantityType(.oxygenSaturation)
    /// A sleep page is answered with every sleep sample from this much before
    /// the page's earliest new sample to this much after its latest, so the web
    /// side sees every night of each sleep day it touches (healthimport.js: a
    /// day's nights end within 24h and start at most a day before). ponytail:
    /// one window per page, unbounded — out-of-order backfill can read a long
    /// span once; split into per-day windows if that shows up as slow.
    static let sleepPad: TimeInterval = 48 * 3600

    /// Read authorization is per quantity type: a blood-pressure correlation
    /// is readable once both of its members are; a workout's heart rate,
    /// energy and distance totals need their own types.
    static func readTypes(_ kind: String) -> [HKObjectType] {
        switch kind {
        case "bp": return [systolic, diastolic]
        case "weight": return [bodyMass]
        case "sleep": return [sleepAnalysis]
        case "workout": return [HKObjectType.workoutType(), heartRate, energy] + distances
        case "steps": return [stepCount]
        case "hr": return [heartRate]
        case "spo2": return [oxygenSaturation]
        default: return []
        }
    }

    /// Write (share) authorization: a blood-pressure correlation is saved
    /// with its two members, and the correlation type itself is not a share
    /// type. Only bp, weight, hr (a bp entry's pulse) and workout are ever written.
    static func shareTypes(_ kind: String) -> [HKSampleType] {
        switch kind {
        case "bp": return [systolic, diastolic]
        case "weight": return [bodyMass]
        case "hr": return [heartRate]
        case "workout": return [HKObjectType.workoutType()]
        default: return []
        }
    }

    /// The kinds health.write takes (writeAccess `supported`).
    static let writeKinds = ["bp", "weight", "hr", "workout"]

    static func canWrite(_ kind: String) -> Bool {
        let types = shareTypes(kind)
        return !types.isEmpty && types.allSatisfy { store.authorizationStatus(for: $0) == .sharingAuthorized }
    }

    /// Our identity on a written object: the sync identifier, versioned so a
    /// later save with a higher version replaces it (HealthKit's own upsert).
    static func identity(_ id: String, _ version: NSNumber) -> [String: Any] {
        [HKMetadataKeySyncIdentifier: id, HKMetadataKeySyncVersion: version]
    }

    /// An object this app wrote back from the vault: our source AND our sync
    /// identifier. A same-bundle object without it (a QA writer) still imports.
    static func ours(_ o: HKObject) -> Bool {
        o.sourceRevision.source.bundleIdentifier == Bundle.main.bundleIdentifier
            && o.metadata?[HKMetadataKeySyncIdentifier] != nil
    }

    /// health.writeAccess's readableFrom (bd med-8f4s.18): iOS 27 lets the
    /// person grant only a recent history window per type, reported by
    /// earliestAuthorizedSampleDate (end-date boundary; full access or denied =
    /// no entry). One number on the wire, so the latest boundary (the
    /// conservative cut), in ms rounded up; no entry → 0, as before iOS 27.
    static func readableFromMs(_ earliest: [HKObjectType: Date]) -> Int {
        Int(((earliest.values.max()?.timeIntervalSince1970 ?? 0) * 1000).rounded(.up))
    }

    /// The OS gate around readableFromMs, pure: below iOS 27 every sample is
    /// readable (0, earliest unused); on 27+ the boundary, nil when the call threw.
    static func readableFrom(osMajor: Int, earliest: [HKObjectType: Date]?) -> Int? {
        osMajor < 27 ? 0 : earliest.map(readableFromMs)
    }

    static func handle(_ op: String, _ args: [String: Any]) async throws -> Any {
        switch op {
        case "health.authorize":
            guard HKHealthStore.isHealthDataAvailable() else { return false }
            let kinds = args["types"] as? [String] ?? []
            let read = Set(kinds.flatMap(readTypes))
            guard !read.isEmpty else { throw Failure("no known types") }
            let share = Set((args["write"] as? [String] ?? []).flatMap(shareTypes))
            // Never says whether read access was granted: a denied type just
            // returns no samples, which is the graceful degradation. Write
            // access is asked in the same sheet and read by health.writeAccess.
            try await store.requestAuthorization(toShare: share, read: read)
            return true
        case "health.writeAccess":
            // readableFrom (readableFrom(osMajor:earliest:)): 0 before iOS 27 (every sample
            // readable); on iOS 27+ the latest limited-history boundary over
            // the write kinds' read types, asked on every call (the person can
            // change the window in Settings); the call throwing omits it (Copy
            // dark, never a guess). Reporting it promises the page the entries
            // batch below (one build, never apart).
            let kinds = args["types"] as? [String] ?? []
            var reply: [String: Any] = [
                "granted": HKHealthStore.isHealthDataAvailable() ? kinds.filter(canWrite) : [String](),
                "supported": writeKinds,
            ]
            var earliest: [HKObjectType: Date]?
            if #available(iOS 27, *) {
                earliest = try? await store.earliestAuthorizedSampleDate(for: Set(writeKinds.flatMap(readTypes)))
            }
            if let from = readableFrom(osMajor: ProcessInfo.processInfo.operatingSystemVersion.majorVersion, earliest: earliest) {
                reply["readableFrom"] = from
            }
            return reply
        case "health.write":
            guard let raw = args["entries"] else { return try await write(args) }
            // The batch (twin of Android's, one shape from the web): one result
            // per entry, in order. A malformed entry (bad write, unknown type)
            // is that entry's string; a whole-call failure — "denied" (no share
            // grant or no Health store) or a HealthKit store error — throws the
            // whole call as a single write does, and the page keeps every id
            // (a verified replay is that entry's true, see verified()).
            guard let entries = raw as? [Any] else { throw Failure("bad write: entries") }
            var results: [Any] = []
            for entry in entries {
                guard let body = entry as? [String: Any] else { results.append("bad write: entry"); continue }
                do { results.append(try await write(body)) } catch let f as Failure where f.errorDescription != "denied" {
                    results.append(f.errorDescription ?? "bad write")
                }
            }
            return results
        case "health.delete":
            return try await delete(args)
        case "health.query":
            return try await query(args)
        default:
            throw Failure("unsupported: \(op)")
        }
    }

    private static func write(_ args: [String: Any]) async throws -> Any {
        guard let kind = args["type"] as? String, let id = args["id"] as? String, !id.isEmpty,
              let version = args["version"] as? NSNumber
        else { throw Failure("bad write") }
        func time(_ key: String) throws -> Date {
            guard let x = (args[key] as? NSNumber)?.doubleValue, x.isFinite else { throw Failure("bad write") }
            return Date(timeIntervalSince1970: x / 1000)
        }
        guard !shareTypes(kind).isEmpty else { throw Failure("unknown type: \(kind)") }
        guard HKHealthStore.isHealthDataAvailable(), canWrite(kind) else { throw Failure("denied") }
        // HKMetadataKeySyncVersion must be an integer.
        let v = NSNumber(value: version.int64Value)
        if kind == "workout" {
            let start = try time("start"), end = try time("end")
            guard end > start else { throw Failure("bad write: end") }
            let config = HKWorkoutConfiguration()
            switch (args["activity"] as? NSNumber)?.intValue {
            case 50: config.activityType = .traditionalStrengthTraining
            case 3000: config.activityType = .other
            default: throw Failure("bad write: activity")
            }
            // The builder honours the sync identifier like a sample save: a
            // higher version replaces the earlier workout (HealthWriteBackTests);
            // a lower one throws, which verified() absorbs.
            let builder = HKWorkoutBuilder(healthStore: store, configuration: config, device: .local())
            try await verified(kind, id, v) {
                try await builder.beginCollection(at: start)
                try await builder.addMetadata(identity(id, v))
                try await builder.endCollection(at: end)
                _ = try await builder.finishWorkout()
            }
            return true
        }
        let at = try time("at")
        func value(_ key: String) throws -> Double {
            guard let x = (args[key] as? NSNumber)?.doubleValue, x.isFinite, x > 0 else { throw Failure("bad write: \(key)") }
            return x
        }
        if kind == "bp" {
            let mmHg = HKUnit.millimeterOfMercury()
            // Three distinct identities: no one string names all three objects.
            let s = HKQuantitySample(type: systolic, quantity: HKQuantity(unit: mmHg, doubleValue: try value("systolic")),
                                     start: at, end: at, metadata: identity(id + "/sys", v))
            let d = HKQuantitySample(type: diastolic, quantity: HKQuantity(unit: mmHg, doubleValue: try value("diastolic")),
                                     start: at, end: at, metadata: identity(id + "/dia", v))
            // Saved as the correlation, not its members separately.
            try await verified(kind, id, v) { try await store.save(HKCorrelation(type: HKCorrelationType(.bloodPressure), start: at, end: at,
                                               objects: [s, d], metadata: identity(id, v))) }
        } else if kind == "hr" {
            // The id arrives as <bp recordId>/pulse: stored verbatim.
            let sample = HKQuantitySample(type: heartRate, quantity: HKQuantity(unit: .count().unitDivided(by: .minute()), doubleValue: try value("bpm")),
                                          start: at, end: at, metadata: identity(id, v))
            try await verified(kind, id, v) { try await store.save(sample) }
        } else {
            let sample = HKQuantitySample(type: bodyMass, quantity: HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: try value("kg")),
                                          start: at, end: at, metadata: identity(id, v))
            try await verified(kind, id, v) { try await store.save(sample) }
        }
        return true
    }

    /// Runs one store write; a store error (never our Failure) counts as
    /// written only if held() finds our object at this version or newer —
    /// else the ORIGINAL error rethrows. No error domain/code is trusted
    /// (bd med-8f4s.14 R4): samples absorb a lower-version replay silently,
    /// but HKWorkoutBuilder.finishWorkout throws com.apple.healthd.SQLite 1.
    private static func verified(_ kind: String, _ id: String, _ v: NSNumber, _ save: () async throws -> Void) async throws {
        do { try await save() } catch let error where !(error is Failure) {
            if (try? await held(kind, id, v.int64Value)) == true { return }
            throw error
        }
    }

    /// The objects this app writes under `id` for a kind, primary first (the
    /// bp correlation, then its members) — shared by write, held and delete.
    static func owned(_ kind: String, _ id: String) throws -> [(HKSampleType, String)] {
        switch kind {
        case "bp": return [(HKCorrelationType(.bloodPressure), id), (systolic, id + "/sys"), (diastolic, id + "/dia")]
        case "weight": return [(bodyMass, id)]
        case "hr": return [(heartRate, id)]
        case "workout": return [(HKObjectType.workoutType(), id)]
        default: throw Failure("unknown type: \(kind)")
        }
    }

    /// This app's own object under `key`: our source AND our sync identifier.
    static func mine(_ key: String) -> NSPredicate {
        NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForObjects(from: HKSource.default()),
            HKQuery.predicateForObjects(withMetadataKey: HKMetadataKeySyncIdentifier, allowedValues: [key]),
        ])
    }

    /// Does the store hold this app's `id` (the kind's primary object) at
    /// `version` or newer? Needs no read grant: a share-only app still reads
    /// back the samples it saved itself (Apple, "Authorizing access to health data").
    static func held(_ kind: String, _ id: String, _ version: Int64) async throws -> Bool {
        guard let primary = try owned(kind, id).first else { return false }
        let found = try await withCheckedThrowingContinuation { (done: CheckedContinuation<[HKSample], Error>) in
            store.execute(HKSampleQuery(sampleType: primary.0, predicate: mine(primary.1), limit: HKObjectQueryNoLimit,
                                        sortDescriptors: nil) { @Sendable _, found, error in
                if let error { done.resume(throwing: error) } else { done.resume(returning: found ?? []) }
            })
        }
        let best = found.compactMap { ($0.metadata?[HKMetadataKeySyncVersion] as? NSNumber)?.int64Value }.max()
        return best.map { $0 >= version } ?? false
    }

    /// Deletes each object written under `id`, matched on this app's source
    /// AND our sync identifier only (no cascade assumed either way). An id we
    /// never wrote — an imported row's weight-hk-<uuid> — matches nothing.
    private static func delete(_ args: [String: Any]) async throws -> Any {
        guard let kind = args["type"] as? String, let id = args["id"] as? String, !id.isEmpty
        else { throw Failure("bad delete") }
        let objects = try owned(kind, id)
        guard HKHealthStore.isHealthDataAvailable() else { return true }
        guard canWrite(kind) else { throw Failure("denied") }
        for (type, key) in objects {
            let predicate = mine(key)
            try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
                store.deleteObjects(of: type, predicate: predicate) { @Sendable _, _, error in
                    // Nothing matched is not a failure.
                    if let error, (error as? HKError)?.code != .errorNoData { done.resume(throwing: error) } else { done.resume() }
                }
            }
        }
        return true
    }

    private static func query(_ args: [String: Any]) async throws -> Any {
        guard HKHealthStore.isHealthDataAvailable() else { return ["samples": [], "returned": 0, "more": false] as [String: Any] }
        // An hr/spo2 anchor carries its first scan's `from` as "<ms>|<anchor>",
        // so every later page keeps the same start-date floor: HealthKit's
        // anchor order is insertion order, and a store synced in from iCloud
        // can insert old samples after the anchor.
        let token = (args["anchor"] as? String)?.split(separator: "|", maxSplits: 1).map(String.init) ?? []
        let anchor = token.last
            .flatMap { Data(base64Encoded: $0) }
            .flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0) }
        let fromMs = (token.count == 2 ? Double(token[0]) : (args["from"] as? NSNumber)?.doubleValue).flatMap { $0.isFinite ? $0 : nil }
        let toMs = (args["to"] as? NSNumber)?.doubleValue
        if args["type"] as? String == "sleep", let f = fromMs, let t = toMs {
            let from = Date(timeIntervalSince1970: f / 1000), to = Date(timeIntervalSince1970: t / 1000)
            let samples = try await sleepSamples(from, to)
            return ["samples": samples, "from": ms(from), "to": ms(to), "returned": 0, "more": false] as [String: Any]
        }
        if args["type"] as? String == "steps" {
            guard let f = fromMs, let t = toMs else { throw Failure("steps needs from and to") }
            let days = try await dailySteps(Date(timeIntervalSince1970: f / 1000), Date(timeIntervalSince1970: t / 1000))
            return ["samples": days, "returned": days.count, "more": false] as [String: Any]
        }
        let limit = max(1, min(args["limit"] as? Int ?? 500, 1000))
        var samples: [[String: Any]] = []
        var window: [String: Any] = [:]
        var anchorPrefix = ""
        let newAnchor: HKQueryAnchor
        let returned: Int
        switch args["type"] as? String {
        case "bp":
            let r = try await HKAnchoredObjectQueryDescriptor(
                predicates: [.correlation(type: HKCorrelationType(.bloodPressure))],
                anchor: anchor, limit: limit).result(for: store)
            let mmHg = HKUnit.millimeterOfMercury()
            // Our own write-back is never imported (tested on the correlation);
            // returned and the anchor stay as the query produced them.
            samples = r.addedSamples.compactMap { c -> [String: Any]? in
                guard !ours(c), let s = (c.objects(for: systolic).first as? HKQuantitySample)?.quantity.doubleValue(for: mmHg),
                      let d = (c.objects(for: diastolic).first as? HKQuantitySample)?.quantity.doubleValue(for: mmHg)
                else { return nil }
                return ["uuid": c.uuid.uuidString, "start": ms(c.startDate), "systolic": s, "diastolic": d]
            }
            newAnchor = r.newAnchor
            returned = r.addedSamples.count + r.deletedObjects.count
        case "weight":
            let r = try await HKAnchoredObjectQueryDescriptor(
                predicates: [.quantitySample(type: bodyMass)],
                anchor: anchor, limit: limit).result(for: store)
            let kg = HKUnit.gramUnit(with: .kilo)
            samples = r.addedSamples.filter { !ours($0) }.map { q -> [String: Any] in
                ["uuid": q.uuid.uuidString, "start": ms(q.startDate), "kg": q.quantity.doubleValue(for: kg)]
            }
            newAnchor = r.newAnchor
            returned = r.addedSamples.count + r.deletedObjects.count
        case "sleep":
            // The anchor finds what is new; the answer is every sleep sample
            // around it (all sources), with the window it covers as from/to.
            let r = try await HKAnchoredObjectQueryDescriptor(
                predicates: [.categorySample(type: sleepAnalysis)],
                anchor: anchor, limit: limit).result(for: store)
            if let lo = r.addedSamples.map(\.startDate).min(), let hi = r.addedSamples.map(\.endDate).max() {
                let from = lo.addingTimeInterval(-sleepPad), to = hi.addingTimeInterval(sleepPad)
                samples = try await sleepSamples(from, to)
                window = ["from": ms(from), "to": ms(to)]
            }
            newAnchor = r.newAnchor
            returned = r.addedSamples.count + r.deletedObjects.count
        case "workout":
            let r = try await HKAnchoredObjectQueryDescriptor(
                predicates: [.workout()],
                anchor: anchor, limit: limit).result(for: store)
            let bpm = HKUnit.count().unitDivided(by: .minute())
            // Our mirrored sessions never re-import (returned/anchor unchanged).
            samples = r.addedSamples.filter { !ours($0) }.map { w -> [String: Any] in
                var o: [String: Any] = ["uuid": w.uuid.uuidString, "start": ms(w.startDate), "end": ms(w.endDate),
                                        "activity": Int(w.workoutActivityType.rawValue), "duration": w.duration]
                if let hr = w.statistics(for: heartRate)?.averageQuantity() { o["hr"] = hr.doubleValue(for: bpm) }
                if let kcal = w.statistics(for: energy)?.sumQuantity() { o["energy"] = kcal.doubleValue(for: .kilocalorie()) }
                if let m = distances.lazy.compactMap({ w.statistics(for: $0)?.sumQuantity() }).first {
                    o["distance"] = m.doubleValue(for: .meter())
                }
                return o
            }
            newAnchor = r.newAnchor
            returned = r.addedSamples.count + r.deletedObjects.count
        case "hr", "spo2":
            // Every sample, workout-rate heart rate included, except the
            // pulses this app wrote back (returned and the anchor stay as the
            // query produced them); SpO2 comes from HealthKit as a 0-1
            // fraction and goes out as percent.
            let spo2 = args["type"] as? String == "spo2"
            let since = fromMs.map { HKQuery.predicateForSamples(withStart: Date(timeIntervalSince1970: $0 / 1000), end: nil, options: .strictStartDate) }
            let r = try await HKAnchoredObjectQueryDescriptor(
                predicates: [.quantitySample(type: spo2 ? oxygenSaturation : heartRate, predicate: since)],
                anchor: anchor, limit: limit).result(for: store)
            let unit = spo2 ? HKUnit.percent() : HKUnit.count().unitDivided(by: .minute())
            samples = r.addedSamples.compactMap { q -> [String: Any]? in
                guard !ours(q) else { return nil }
                let v = q.quantity.doubleValue(for: unit) * (spo2 ? 100 : 1)
                if spo2, !(50...100).contains(v) { return nil }
                return ["uuid": q.uuid.uuidString, "start": ms(q.startDate), "value": v]
            }
            newAnchor = r.newAnchor
            returned = r.addedSamples.count + r.deletedObjects.count
            anchorPrefix = fromMs.map { "\(Int64($0))|" } ?? ""
        case let t:
            throw Failure("unknown type: \(t ?? "")")
        }
        let archived = try NSKeyedArchiver.archivedData(withRootObject: newAnchor, requiringSecureCoding: true)
        let page: [String: Any] = ["samples": samples, "anchor": anchorPrefix + archived.base64EncodedString(),
                                   "returned": returned, "more": returned >= limit]
        return page.merging(window) { a, _ in a }
    }

    /// One step total per local day from `from`'s midnight to `to`, as
    /// HealthKit's own cumulative sum (it dedupes overlapping sources; summing
    /// raw samples would count a phone and a watch twice). Empty days are left out.
    private static func dailySteps(_ from: Date, _ to: Date) async throws -> [[String: Any]] {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: from)
        let window = HKQuery.predicateForSamples(withStart: start, end: to, options: [])
        let days = try await HKStatisticsCollectionQueryDescriptor(
            predicate: .quantitySample(type: stepCount, predicate: window),
            options: .cumulativeSum, anchorDate: start,
            intervalComponents: DateComponents(day: 1)).result(for: store)
        let tz = TimeZone.current.identifier
        return days.statistics().compactMap { s -> [String: Any]? in
            guard let n = s.sumQuantity()?.doubleValue(for: .count()), n > 0 else { return nil }
            let d = calendar.dateComponents([.year, .month, .day], from: s.startDate)
            let day = String(format: "%04d-%02d-%02d", d.year ?? 0, d.month ?? 0, d.day ?? 0)
            return ["day": day, "steps": Int(n.rounded()), "tz": tz]
        }
    }

    /// Every sleep sample (all sources) overlapping [from, to].
    private static func sleepSamples(_ from: Date, _ to: Date) async throws -> [[String: Any]] {
        let around = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
        let all = try await HKSampleQueryDescriptor(
            predicates: [.categorySample(type: sleepAnalysis, predicate: around)],
            sortDescriptors: []).result(for: store)
        return all.map { s -> [String: Any] in
            var o: [String: Any] = ["uuid": s.uuid.uuidString, "start": ms(s.startDate), "end": ms(s.endDate),
                                    "value": s.value, "source": s.sourceRevision.source.bundleIdentifier]
            if let tz = s.metadata?[HKMetadataKeyTimeZone] as? String { o["tz"] = tz }
            return o
        }
    }

    private static func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }
}
