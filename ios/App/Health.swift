import Foundation
import HealthKit

/// window.Health on iOS (bd med-w6gx.6): HealthKit READ-ONLY. The page asks;
/// this answers with raw samples — mapping them into vault records is the web
/// domain layer's job (web/domain/healthimport.js), not the shell's.
///
/// Ops (web/static/js/native/health.js):
///   health.authorize {types}             → Bool (false: no Health store on this device)
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

    static func handle(_ op: String, _ args: [String: Any]) async throws -> Any {
        switch op {
        case "health.authorize":
            guard HKHealthStore.isHealthDataAvailable() else { return false }
            let kinds = args["types"] as? [String] ?? []
            let read = Set(kinds.flatMap(readTypes))
            guard !read.isEmpty else { throw Failure("no known types") }
            #if DEBUG
            if UserDefaults.standard.bool(forKey: "wgQAHealthSeed") {
                try await store.requestAuthorization(toShare: [stepCount, heartRate, oxygenSaturation], read: read)
                try await qaSeed()
                return true
            }
            #endif
            // Never says whether access was granted: a denied type just
            // returns no samples, which is the graceful degradation.
            try await store.requestAuthorization(toShare: [], read: read)
            return true
        case "health.query":
            return try await query(args)
        default:
            throw Failure("unsupported: \(op)")
        }
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
        let fromMs = token.count == 2 ? Double(token[0]) : (args["from"] as? NSNumber)?.doubleValue
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
            samples = r.addedSamples.compactMap { c -> [String: Any]? in
                guard let s = (c.objects(for: systolic).first as? HKQuantitySample)?.quantity.doubleValue(for: mmHg),
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
            samples = r.addedSamples.map { q -> [String: Any] in
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
            samples = r.addedSamples.map { w -> [String: Any] in
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
            // Every sample, workout-rate heart rate included; SpO2 comes from
            // HealthKit as a 0-1 fraction and goes out as percent.
            let spo2 = args["type"] as? String == "spo2"
            let since = fromMs.map { HKQuery.predicateForSamples(withStart: Date(timeIntervalSince1970: $0 / 1000), end: nil, options: .strictStartDate) }
            let r = try await HKAnchoredObjectQueryDescriptor(
                predicates: [.quantitySample(type: spo2 ? oxygenSaturation : heartRate, predicate: since)],
                anchor: anchor, limit: limit).result(for: store)
            let unit = spo2 ? HKUnit.percent() : HKUnit.count().unitDivided(by: .minute())
            samples = r.addedSamples.compactMap { q -> [String: Any]? in
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

    #if DEBUG
    /// Visual QA (Debug only, `-wgQAHealthSeed YES`, scene health-kit-import):
    /// the Simulator's Health store has no steps, heart rate or SpO2, so the
    /// authorize sheet also asks to write them and a week of samples is saved
    /// once per device for the import to read back.
    private static func qaSeed() async throws {
        let done = "wgQAHealthSeeded"
        guard !UserDefaults.standard.bool(forKey: done) else { return }
        let now = Date(), calendar = Calendar.current, today = calendar.startOfDay(for: now)
        var objects: [HKObject] = []
        for (i, steps) in [9876, 10211, 6120, 12034, 7311, 9020, 11002].enumerated() {
            guard let day = calendar.date(byAdding: .day, value: -i, to: today) else { continue }
            let end = min(day.addingTimeInterval(10 * 3600), now), start = max(day, end.addingTimeInterval(-3600))
            guard end > start else { continue }
            objects.append(HKQuantitySample(type: stepCount, quantity: HKQuantity(unit: .count(), doubleValue: Double(steps)),
                                            start: start, end: end))
        }
        let bpm = HKUnit.count().unitDivided(by: .minute())
        for h in 1...24 {
            let at = now.addingTimeInterval(Double(-h) * 3600)
            objects.append(HKQuantitySample(type: heartRate, quantity: HKQuantity(unit: bpm, doubleValue: Double(58 + h * 7 % 25)),
                                            start: at, end: at))
        }
        for (i, f) in [0.97, 0.96, 0.98, 0.95, 0.99, 0.97].enumerated() {
            let at = now.addingTimeInterval(Double(-(i + 1)) * 4 * 3600)
            objects.append(HKQuantitySample(type: oxygenSaturation, quantity: HKQuantity(unit: .percent(), doubleValue: f),
                                            start: at, end: at))
        }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            store.save(objects) { _, error in
                if let error { c.resume(throwing: error) } else { c.resume() }
            }
        }
        UserDefaults.standard.set(true, forKey: done)
    }
    #endif
}
