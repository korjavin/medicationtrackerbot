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
        if UserDefaults.standard.bool(forKey: "wgQAHealthWriteBack") { return publish(await writeBack()) }
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
        publish(result)
    }

    private func publish(_ result: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        report = String(decoding: data, as: UTF8.self)
        NSLog("WG_HEALTH_DIAGNOSTIC %@", report)
    }

    /// The write-back through the shell's own ops (bd med-8f4s.3): authorize
    /// with write, write a BP and a weight, rewrite them with a higher version,
    /// check the own-id import filter against an unmarked same-bundle pair,
    /// check that an imported row's id (`*-hk-<uuid>`) deletes nothing, then
    /// delete ours and find nothing left. Each run uses fresh ids.
    @MainActor
    private func writeBack() async -> [String: Any] {
        var failed: [String] = []
        var result: [String: Any] = [:]
        func check(_ name: String, _ ok: Bool, _ seen: Any = "") {
            if !ok { failed.append("\(name) (\(seen))") }
        }
        let store = Health.store
        let mmHg = HKUnit.millimeterOfMercury(), kg = HKUnit.gramUnit(with: .kilo)
        let bpType = HKCorrelationType(.bloodPressure)
        func find(_ type: HKSampleType, _ predicate: NSPredicate) async throws -> [HKSample] {
            try await withCheckedThrowingContinuation { (done: CheckedContinuation<[HKSample], Error>) in
                store.execute(HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit,
                                            sortDescriptors: nil) { @Sendable _, found, error in
                    if let error { done.resume(throwing: error) } else { done.resume(returning: found ?? []) }
                })
            }
        }
        func synced(_ type: HKSampleType, _ key: String) async throws -> [HKSample] {
            try await find(type, HKQuery.predicateForObjects(withMetadataKey: HKMetadataKeySyncIdentifier, allowedValues: [key]))
        }
        func value(_ s: HKSample?, _ unit: HKUnit) -> Double { (s as? HKQuantitySample)?.quantity.doubleValue(for: unit) ?? -1 }
        /// Every uuid one import pass (anchor nil, paged) hands the page.
        func imported(_ kind: String) async throws -> Set<String> {
            var uuids = Set<String>(), anchor: Any = NSNull(), more = true
            while more {
                let page = try await Health.handle("health.query", ["type": kind, "anchor": anchor, "limit": 1000]) as? [String: Any] ?? [:]
                for s in page["samples"] as? [[String: Any]] ?? [] { if let u = s["uuid"] as? String { uuids.insert(u) } }
                anchor = page["anchor"] ?? NSNull()
                more = page["more"] as? Bool ?? false
            }
            return uuids
        }
        var plain: [HKObject] = []
        do {
            let both = ["bp", "weight"]
            check("authorize", try await Health.handle("health.authorize", ["types": both, "write": both]) as? Bool == true)
            let granted = (try await Health.handle("health.writeAccess", ["types": both]) as? [String: Any])?["granted"] as? [String] ?? []
            let statuses = [Health.systolic, Health.diastolic, Health.bodyMass].map { store.authorizationStatus(for: $0).rawValue }
            result["granted"] = granted
            check("weight writable", granted.contains("weight"), "\(granted) status sys/dia/kg \(statuses)")
            // ponytail: on the iOS 26.5 Simulator the share sheet grants the
            // blood-pressure correlation type (status 2) but leaves systolic and
            // diastolic notDetermined, re-asking is a no-op and every BP save
            // fails "Authorization is not determined". writeAccess then honestly
            // omits bp; the BP half runs only where the store grants it, and the
            // report names the skip. Drop the gate once a runtime grants BP share.
            let bpOn = granted.contains("bp")
            if !bpOn {
                result["bpSkipped"] = "sys/dia/corr " + ([Health.systolic, Health.diastolic, bpType] as [HKObjectType])
                    .map { "\(store.authorizationStatus(for: $0).rawValue)" }.joined(separator: "/")
                var refused = false
                do { _ = try await Health.handle("health.write", ["type": "bp", "id": "bp-qa-gate", "version": 1, "at": 0.0, "systolic": 120.0, "diastolic": 80.0]) }
                catch { refused = error.localizedDescription == "denied" }
                check("bp write refused without access", refused)
            }
            let run = UUID().uuidString
            let bp = "bp-qa-\(run)", weight = "weight-qa-\(run)"
            let at = ((Date().timeIntervalSince1970 - 3600) * 1000).rounded()
            // The second write (same ids, higher version) replaces the first.
            for (version, sys) in [(1_000, 120.0), (2_000, 131.0)] {
                if bpOn {
                    _ = try await Health.handle("health.write", ["type": "bp", "id": bp, "version": version, "at": at,
                                                                 "systolic": sys, "diastolic": 80.0])
                }
                _ = try await Health.handle("health.write", ["type": "weight", "id": weight, "version": version, "at": at, "kg": sys / 2])
            }
            let kgs = try await synced(Health.bodyMass, weight)
            check("one weight", kgs.count == 1 && abs(value(kgs.first, kg) - 65.5) < 0.01, "\(kgs.count) \(value(kgs.first, kg))")
            check("weight version", (kgs.first?.metadata?[HKMetadataKeySyncVersion] as? NSNumber)?.intValue == 2_000)
            check("weight our source", kgs.first.map { Health.ours($0) } == true)
            var corr: [HKSample] = []
            if bpOn {
                corr = try await synced(bpType, bp)
                let sys = try await synced(Health.systolic, bp + "/sys"), dia = try await synced(Health.diastolic, bp + "/dia")
                check("one correlation", corr.count == 1, corr.count)
                check("one systolic", sys.count == 1 && value(sys.first, mmHg) == 131, "\(sys.count) \(value(sys.first, mmHg))")
                check("one diastolic", dia.count == 1 && value(dia.first, mmHg) == 80, dia.count)
                check("bp version", (corr.first?.metadata?[HKMetadataKeySyncVersion] as? NSNumber)?.intValue == 2_000)
                check("bp our source", corr.first.map { Health.ours($0) } == true)
                let members = (corr.first as? HKCorrelation)?.objects.map { $0.metadata?[HKMetadataKeySyncIdentifier] as? String ?? "" } ?? []
                check("member ids", Set(members) == [bp + "/sys", bp + "/dia"], members)
            }

            // An unmarked same-bundle sample (a QA writer) still imports; ours does not.
            let t = Date(timeIntervalSince1970: at / 1000 - 60)
            let ps = HKQuantitySample(type: Health.systolic, quantity: HKQuantity(unit: mmHg, doubleValue: 111), start: t, end: t)
            let pd = HKQuantitySample(type: Health.diastolic, quantity: HKQuantity(unit: mmHg, doubleValue: 71), start: t, end: t)
            let plainBP = HKCorrelation(type: bpType, start: t, end: t, objects: [ps, pd])
            let plainKg = HKQuantitySample(type: Health.bodyMass, quantity: HKQuantity(unit: kg, doubleValue: 60), start: t, end: t)
            let unmarked: [HKObject] = bpOn ? [plainBP, plainKg] : [plainKg]
            try await store.save(unmarked)
            plain = bpOn ? [plainBP, ps, pd, plainKg] : [plainKg]
            let kgSeen = try await imported("weight")
            check("unmarked weight imports", kgSeen.contains(plainKg.uuid.uuidString))
            check("own weight filtered", kgs.first.map { !kgSeen.contains($0.uuid.uuidString) } == true)
            if bpOn {
                let bpSeen = try await imported("bp")
                check("unmarked bp imports", bpSeen.contains(plainBP.uuid.uuidString))
                check("own bp filtered", corr.first.map { !bpSeen.contains($0.uuid.uuidString) } == true)
            }

            // An imported row's delete (its HK uuid as the id) deletes nothing.
            var probes = [("weight", "weight-hk-\(plainKg.uuid.uuidString)"), ("weight", plainKg.uuid.uuidString)]
            if bpOn { probes += [("bp", "bp-hk-\(plainBP.uuid.uuidString)"), ("bp", "bp-qa-never-written")] }
            for (kind, id) in probes {
                check("delete \(id)", try await Health.handle("health.delete", ["type": kind, "id": id]) as? Bool == true)
            }
            var left = try await find(Health.bodyMass, HKQuery.predicateForObject(with: plainKg.uuid)).count
            if bpOn { left += try await find(bpType, HKQuery.predicateForObject(with: plainBP.uuid)).count }
            check("imported rows kept", left == (bpOn ? 2 : 1), left)

            check("delete weight", try await Health.handle("health.delete", ["type": "weight", "id": weight]) as? Bool == true)
            var stray = try await synced(Health.bodyMass, weight).count
            if bpOn {
                check("delete bp", try await Health.handle("health.delete", ["type": "bp", "id": bp]) as? Bool == true)
                stray += try await synced(bpType, bp).count + synced(Health.systolic, bp + "/sys").count
                    + synced(Health.diastolic, bp + "/dia").count
            }
            check("nothing left", stray == 0, stray)
        } catch {
            let e = error as NSError
            failed.append("error \(e.domain) \(e.code) \(e.localizedDescription)")
        }
        if !plain.isEmpty { try? await store.delete(plain) }
        result["failed"] = failed
        result["ok"] = failed.isEmpty
        return result
    }
}
#endif
