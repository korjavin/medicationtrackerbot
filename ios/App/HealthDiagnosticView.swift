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
            if !granted.contains("bp") {
                // Probe (temporary, bd med-8f4s.3): BP share status after the
                // combined sheet, a raw unmarked correlation save, and the
                // statuses after a bp-only share request.
                var probe: [String] = ["corr \(store.authorizationStatus(for: bpType).rawValue)"]
                let t = Date().addingTimeInterval(-7200), mmHg = HKUnit.millimeterOfMercury()
                let c = HKCorrelation(type: bpType, start: t, end: t, objects: [
                    HKQuantitySample(type: Health.systolic, quantity: HKQuantity(unit: mmHg, doubleValue: 101), start: t, end: t),
                    HKQuantitySample(type: Health.diastolic, quantity: HKQuantity(unit: mmHg, doubleValue: 61), start: t, end: t),
                ])
                do { try await store.save(c); probe.append("raw save ok"); try? await store.delete([c]) }
                catch { probe.append("raw save \((error as NSError).code) \(error.localizedDescription)") }
                let lone = HKQuantitySample(type: Health.systolic, quantity: HKQuantity(unit: mmHg, doubleValue: 102), start: t, end: t)
                do { try await store.save(lone); probe.append("lone sys save ok"); try? await store.delete([lone]) }
                catch { probe.append("lone sys save \((error as NSError).code)") }
                let trio: [HKObjectType] = [Health.systolic, Health.diastolic, bpType]
                try? await Task.sleep(for: .seconds(3))
                probe.append("after 3s " + trio.map { "\(store.authorizationStatus(for: $0).rawValue)" }.joined(separator: "/"))
                do { try await store.save(c); probe.append("raw save 2 ok"); try? await store.delete([c]) }
                catch { probe.append("raw save 2 \((error as NSError).code)") }
                if let status = try? await store.statusForAuthorizationRequest(toShare: [Health.systolic, Health.diastolic], read: []) {
                    probe.append("request status \(status.rawValue)")
                }
                result["probe"] = probe
            }
            check("writeAccess", Set(granted) == Set(both), "\(granted) status sys/dia/kg \(statuses)")
            let run = UUID().uuidString
            let bp = "bp-qa-\(run)", weight = "weight-qa-\(run)"
            let at = ((Date().timeIntervalSince1970 - 3600) * 1000).rounded()
            // The second write (same ids, higher version) replaces the first.
            for (version, sys) in [(1_000, 120.0), (2_000, 131.0)] {
                _ = try await Health.handle("health.write", ["type": "bp", "id": bp, "version": version, "at": at,
                                                             "systolic": sys, "diastolic": 80.0])
                _ = try await Health.handle("health.write", ["type": "weight", "id": weight, "version": version, "at": at, "kg": sys / 2])
            }
            let corr = try await synced(bpType, bp)
            let sys = try await synced(Health.systolic, bp + "/sys"), dia = try await synced(Health.diastolic, bp + "/dia")
            let kgs = try await synced(Health.bodyMass, weight)
            check("one correlation", corr.count == 1, corr.count)
            check("one systolic", sys.count == 1 && value(sys.first, mmHg) == 131, "\(sys.count) \(value(sys.first, mmHg))")
            check("one diastolic", dia.count == 1 && value(dia.first, mmHg) == 80, dia.count)
            check("one weight", kgs.count == 1 && abs(value(kgs.first, kg) - 65.5) < 0.01, "\(kgs.count) \(value(kgs.first, kg))")
            check("version", (corr.first?.metadata?[HKMetadataKeySyncVersion] as? NSNumber)?.intValue == 2_000)
            check("our source", corr.first.map { Health.ours($0) } == true && kgs.first.map { Health.ours($0) } == true)
            let members = (corr.first as? HKCorrelation)?.objects.map { $0.metadata?[HKMetadataKeySyncIdentifier] as? String ?? "" } ?? []
            check("member ids", Set(members) == [bp + "/sys", bp + "/dia"], members)

            // An unmarked same-bundle pair (a QA writer) still imports; ours does not.
            let t = Date(timeIntervalSince1970: at / 1000 - 60)
            let ps = HKQuantitySample(type: Health.systolic, quantity: HKQuantity(unit: mmHg, doubleValue: 111), start: t, end: t)
            let pd = HKQuantitySample(type: Health.diastolic, quantity: HKQuantity(unit: mmHg, doubleValue: 71), start: t, end: t)
            let plainBP = HKCorrelation(type: bpType, start: t, end: t, objects: [ps, pd])
            let plainKg = HKQuantitySample(type: Health.bodyMass, quantity: HKQuantity(unit: kg, doubleValue: 60), start: t, end: t)
            try await store.save([plainBP, plainKg])
            plain = [plainBP, ps, pd, plainKg]
            let bpSeen = try await imported("bp"), kgSeen = try await imported("weight")
            check("unmarked bp imports", bpSeen.contains(plainBP.uuid.uuidString))
            check("unmarked weight imports", kgSeen.contains(plainKg.uuid.uuidString))
            check("own bp filtered", corr.first.map { !bpSeen.contains($0.uuid.uuidString) } == true)
            check("own weight filtered", kgs.first.map { !kgSeen.contains($0.uuid.uuidString) } == true)

            // An imported row's delete (its HK uuid as the id) deletes nothing.
            for (kind, id) in [("bp", "bp-hk-\(plainBP.uuid.uuidString)"), ("weight", "weight-hk-\(plainKg.uuid.uuidString)"),
                               ("weight", plainKg.uuid.uuidString), ("bp", "bp-qa-never-written")] {
                check("delete \(id)", try await Health.handle("health.delete", ["type": kind, "id": id]) as? Bool == true)
            }
            let left = try await find(Health.bodyMass, HKQuery.predicateForObject(with: plainKg.uuid)).count
                + find(bpType, HKQuery.predicateForObject(with: plainBP.uuid)).count
            check("imported rows kept", left == 2, left)

            for (kind, id) in [("bp", bp), ("weight", weight)] {
                check("delete \(kind)", try await Health.handle("health.delete", ["type": kind, "id": id]) as? Bool == true)
            }
            let stray = try await synced(bpType, bp).count + synced(Health.systolic, bp + "/sys").count
                + synced(Health.diastolic, bp + "/dia").count + synced(Health.bodyMass, weight).count
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
