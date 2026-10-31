#if DEBUG && targetEnvironment(simulator)
import HealthKit
import SwiftUI

/// Simulator-only native baseline and explicit real-store seed, never compiled into Release.
struct HealthDiagnosticView: View {
    @State private var report = "pending"

    var body: some View {
        ScrollView { Text(report).accessibilityIdentifier("health-diagnostic-result") }
            .task { await diagnose() }
    }

    @MainActor
    private func diagnose() async {
        var result: [String: Any] = ["available": HKHealthStore.isHealthDataAvailable()]
        let store = HKHealthStore()
        let type = HKQuantityType(.stepCount)
        let seed = UserDefaults.standard.bool(forKey: "wgQAHealthSeed")
        let kinds: Set<HKSampleType> = seed
            ? [type, HKQuantityType(.heartRate), HKQuantityType(.oxygenSaturation), HKCategoryType(.sleepAnalysis)]
            : [type]
        do {
            try await store.requestAuthorization(toShare: seed ? kinds : [], read: Set(kinds.map { $0 as HKObjectType }))
            result["authorizationCompleted"] = true
            if seed && !UserDefaults.standard.bool(forKey: "wgQAHealthSeededV1") {
                let end = Date().addingTimeInterval(-4 * 3600)
                let start = end.addingTimeInterval(-7 * 3600)
                let samples: [HKSample] = [
                    HKQuantitySample(type: type, quantity: HKQuantity(unit: .count(), doubleValue: 4000), start: end, end: end),
                    HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 65), start: end, end: end),
                    HKQuantitySample(type: HKQuantityType(.oxygenSaturation), quantity: HKQuantity(unit: .percent(), doubleValue: 0.98), start: end, end: end),
                    HKCategorySample(type: HKCategoryType(.sleepAnalysis), value: HKCategoryValueSleepAnalysis.asleepCore.rawValue, start: start, end: end),
                ]
                try await store.save(samples)
                UserDefaults.standard.set(true, forKey: "wgQAHealthSeededV1")
                result["seeded"] = samples.count
            }
            let query = HKSampleQueryDescriptor(predicates: [.quantitySample(type: type)],
                                                sortDescriptors: [], limit: 1)
            let samples = try await query.result(for: store)
            result["queryCompleted"] = true
            result["sampleCount"] = samples.count
        } catch {
            let error = error as NSError
            result["errorDomain"] = error.domain
            result["errorCode"] = error.code
            result["errorDescription"] = error.localizedDescription
        }
        result["ok"] = result["available"] as? Bool == true && result["queryCompleted"] as? Bool == true
        let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        report = String(decoding: data, as: UTF8.self)
        NSLog("WG_HEALTH_DIAGNOSTIC %@", report)
    }
}
#endif
