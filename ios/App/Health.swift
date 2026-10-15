import Foundation
import HealthKit

/// window.Health on iOS (bd med-w6gx.6): HealthKit READ-ONLY. The page asks;
/// this answers with raw samples — mapping them into vault records is the web
/// domain layer's job (web/domain/healthimport.js), not the shell's.
///
/// Ops (web/static/js/native/health.js):
///   health.authorize {types}             → Bool (false: no Health store on this device)
///   health.query {type, anchor?, limit?} → {samples, anchor, more}
/// Kinds: "bp" (blood-pressure correlations), "weight" (body mass).
/// Sleep and workouts (med-7) add their kinds to `readTypes` and `query`.
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

    /// Read authorization is per quantity type: a blood-pressure correlation
    /// is readable once both of its members are.
    static func readTypes(_ kind: String) -> [HKObjectType] {
        switch kind {
        case "bp": return [systolic, diastolic]
        case "weight": return [bodyMass]
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
        guard HKHealthStore.isHealthDataAvailable() else { return ["samples": [], "more": false] as [String: Any] }
        let anchor = (args["anchor"] as? String)
            .flatMap { Data(base64Encoded: $0) }
            .flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0) }
        let limit = max(1, min(args["limit"] as? Int ?? 500, 1000))
        let samples: [[String: Any]]
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
        case let t:
            throw Failure("unknown type: \(t ?? "")")
        }
        let token = try NSKeyedArchiver.archivedData(withRootObject: newAnchor, requiringSecureCoding: true)
        return ["samples": samples, "anchor": token.base64EncodedString(), "more": returned >= limit] as [String: Any]
    }

    private static func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }
}
