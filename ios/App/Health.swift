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
/// Kinds: "bp" (blood-pressure correlations), "weight" (body mass), and
/// (bd med-w6gx.7) "sleep" (sleep-analysis samples) and "workout" (HKWorkout).
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
    /// A sleep page is answered with every sleep sample from this much before
    /// the page's earliest new sample to this much after its latest, so the web
    /// side sees whole nights (healthimport.js). ponytail: one window per page,
    /// unbounded — out-of-order backfill can read a long span once; split into
    /// per-night windows if that shows up as slow.
    static let sleepPad: TimeInterval = 18 * 3600

    /// Read authorization is per quantity type: a blood-pressure correlation
    /// is readable once both of its members are; a workout's heart rate,
    /// energy and distance totals need their own types.
    static func readTypes(_ kind: String) -> [HKObjectType] {
        switch kind {
        case "bp": return [systolic, diastolic]
        case "weight": return [bodyMass]
        case "sleep": return [sleepAnalysis]
        case "workout": return [HKObjectType.workoutType(), heartRate, energy] + distances
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
        let anchor = (args["anchor"] as? String)
            .flatMap { Data(base64Encoded: $0) }
            .flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0) }
        if args["type"] as? String == "sleep", let f = (args["from"] as? NSNumber)?.doubleValue, let t = (args["to"] as? NSNumber)?.doubleValue {
            let from = Date(timeIntervalSince1970: f / 1000), to = Date(timeIntervalSince1970: t / 1000)
            let samples = try await sleepSamples(from, to)
            return ["samples": samples, "from": ms(from), "to": ms(to), "returned": 0, "more": false] as [String: Any]
        }
        let limit = max(1, min(args["limit"] as? Int ?? 500, 1000))
        var samples: [[String: Any]] = []
        var window: [String: Any] = [:]
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
        case let t:
            throw Failure("unknown type: \(t ?? "")")
        }
        let token = try NSKeyedArchiver.archivedData(withRootObject: newAnchor, requiringSecureCoding: true)
        let page: [String: Any] = ["samples": samples, "anchor": token.base64EncodedString(),
                                   "returned": returned, "more": returned >= limit]
        return page.merging(window) { a, _ in a }
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
