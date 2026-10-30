#if DEBUG && targetEnvironment(simulator)
import HealthKit
import SwiftUI

/// Native baseline independent of browser error translation. Never writes samples.
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
        do {
            try await store.requestAuthorization(toShare: [], read: [type])
            result["authorizationCompleted"] = true
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
