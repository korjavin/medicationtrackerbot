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
        let labels = UserDefaults.standard.bool(forKey: "wgQAHealthLabels")
        let kinds: Set<HKSampleType> = seed
            ? [type, HKQuantityType(.heartRate), HKQuantityType(.oxygenSaturation), HKCategoryType(.sleepAnalysis)]
            : [type]
        let labelKinds: Set<HKSampleType> = [HKQuantityType(.bodyMass), HKQuantityType(.bloodPressureSystolic),
                                            HKQuantityType(.bloodPressureDiastolic), HKCorrelationType(.bloodPressure)]
        do {
            let requested = labels ? kinds.union(labelKinds) : kinds
            try await store.requestAuthorization(toShare: seed ? requested : [], read: Set(requested.map { $0 as HKObjectType }))
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
            if labels {
                let at = Date().addingTimeInterval(-3600)
                let mass = HKQuantityType(.bodyMass)
                let sys = HKQuantityType(.bloodPressureSystolic), dia = HKQuantityType(.bloodPressureDiastolic)
                if store.authorizationStatus(for: mass) == .sharingAuthorized {
                    try await store.save(HKQuantitySample(type: mass, quantity: HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: 73.4), start: at, end: at))
                    result["weightSeeded"] = true
                }
                let bp = HKCorrelationType(.bloodPressure)
                if store.authorizationStatus(for: sys) == .sharingAuthorized && store.authorizationStatus(for: dia) == .sharingAuthorized && store.authorizationStatus(for: bp) == .sharingAuthorized {
                    let unit = HKUnit.millimeterOfMercury()
                    let s = HKQuantitySample(type: sys, quantity: HKQuantity(unit: unit, doubleValue: 123), start: at, end: at)
                    let d = HKQuantitySample(type: dia, quantity: HKQuantity(unit: unit, doubleValue: 79), start: at, end: at)
                    try await store.save(HKCorrelation(type: bp, start: at, end: at, objects: [s, d]))
                    result["bpSeeded"] = true
                }
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
    /// delete ours and find nothing left; then the same for a BP pulse as hr
    /// (bd med-8f4s.8), plus a seeded workout whose imported average heart
    /// rate the pulse must not move; then a completed session as a workout (bd
    /// med-8f4s.10): write, replace, activity guard, own-id filter (the seeded
    /// unmarked workout still imports), delete. Each run uses fresh ids.
    @MainActor
    private func writeBack() async -> [String: Any] {
        var failed: [String] = []
        var result: [String: Any] = [:]
        func check(_ name: String, _ ok: Bool, _ seen: Any = "") {
            if !ok { failed.append("\(name) (\(seen))") }
        }
        /// Shown while running, so a stall names its step (the test waits on "pending*").
        func step(_ name: String) { report = "pending: \(name)" }
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
        func ms(_ d: Date) -> Double { (d.timeIntervalSince1970 * 1000).rounded() }
        /// Every sample one import pass (anchor nil, paged) hands the page, by uuid.
        func pages(_ kind: String) async throws -> [String: [String: Any]] {
            var byUUID: [String: [String: Any]] = [:], anchor: Any = NSNull(), more = true
            while more {
                let page = try await Health.handle("health.query", ["type": kind, "anchor": anchor, "limit": 1000]) as? [String: Any] ?? [:]
                for s in page["samples"] as? [[String: Any]] ?? [] { if let u = s["uuid"] as? String { byUUID[u] = s } }
                anchor = page["anchor"] ?? NSNull()
                more = page["more"] as? Bool ?? false
            }
            return byUUID
        }
        func imported(_ kind: String) async throws -> Set<String> { Set(try await pages(kind).keys) }
        /// A replay (bd med-8f4s.14): the same id at an equal or lower version
        /// — a Copy from the user's second device — must resolve true. A throw
        /// is recorded with its domain/code, so the report names what HealthKit did.
        func replay(_ name: String, _ args: [String: Any]) async {
            do { check("\(name) replay resolves", try await Health.handle("health.write", args) as? Bool == true) }
            catch { let e = error as NSError; check("\(name) replay resolves", false, "\(e.domain) \(e.code) \(e.localizedDescription)") }
        }
        var plain: [HKObject] = [], seeded: [HKObject] = []
        do {
            let both = ["bp", "weight", "hr", "workout"]
            // One sheet: on the iOS 26.5 Simulator a second requestAuthorization
            // in the same launch never presents and never returns. So the sheet
            // is the one health.authorize would ask (its share set is
            // write.flatMap(shareTypes) and readTypes), asked here directly.
            // (The sheet left BP members notDetermined, so calling
            // health.authorize again would be that second request.)
            step("authorize")
            check("hr shares heart rate", Health.shareTypes("hr") == [Health.heartRate])
            check("workout shares workouts", Health.shareTypes("workout") == [HKObjectType.workoutType()])
            try await store.requestAuthorization(toShare: Set(both.flatMap(Health.shareTypes)), read: Set(both.flatMap(Health.readTypes)))
            step("bp/weight")
            let access = try await Health.handle("health.writeAccess", ["types": both]) as? [String: Any] ?? [:]
            let granted = access["granted"] as? [String] ?? []
            let statuses = [Health.systolic, Health.diastolic, Health.bodyMass, Health.heartRate, HKObjectType.workoutType()]
                .map { store.authorizationStatus(for: $0).rawValue }
            result["granted"] = granted
            check("supported", access["supported"] as? [String] == ["bp", "weight", "hr", "workout"], access["supported"] ?? "absent")
            // readableFromMs (.18), pure: no boundary (full access) is 0; two
            // limited types → the later date in ms. The OS gate, pure: below
            // iOS 27 → 0 (no runtime for it in CI, Archie 17031); 27 with the
            // call throwing → omitted. The reply on this runtime (full access
            // granted above) is 0.
            check("readableFromMs [:] is 0", Health.readableFromMs([:]) == 0)
            check("readableFrom below iOS 27 is 0", Health.readableFrom(osMajor: 26, earliest: nil) == 0)
            check("readableFrom iOS 27 call threw omits", Health.readableFrom(osMajor: 27, earliest: nil) == nil)
            check("readableFromMs takes the later date", Health.readableFromMs([Health.bodyMass: Date(timeIntervalSince1970: 1_000), Health.heartRate: Date(timeIntervalSince1970: 2_000.5)]) == 2_000_500)
            check("readableFrom 0", (access["readableFrom"] as? NSNumber)?.intValue == 0, access["readableFrom"] ?? "absent")
            check("weight writable", granted.contains("weight"), "\(granted) status sys/dia/kg/hr/workout \(statuses)")
            // Heart rate and workouts are plain types: unlike bp they must grant here.
            check("hr writable", granted.contains("hr"), "\(granted) status sys/dia/kg/hr/workout \(statuses)")
            check("workout writable", granted.contains("workout"), "\(granted) status sys/dia/kg/hr/workout \(statuses)")
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
            // Replays: equal version (same payload), then lower (the old one).
            // HealthKit must keep the v2000 objects; the report says whether
            // the equal one was kept or re-saved (its uuid).
            step("replay")
            let kgBefore = try await synced(Health.bodyMass, weight).first?.uuid
            for (version, sys) in [(2_000, 131.0), (1_000, 120.0)] {
                if bpOn {
                    await replay("bp v\(version)", ["type": "bp", "id": bp, "version": version, "at": at,
                                                    "systolic": sys, "diastolic": 80.0])
                }
                await replay("weight v\(version)", ["type": "weight", "id": weight, "version": version, "at": at, "kg": sys / 2])
            }
            let kgs = try await synced(Health.bodyMass, weight)
            result["equalReplay"] = kgs.count == 1 && kgs.first?.uuid == kgBefore ? "kept" : "replaced"
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

            // Pulse write-back (bd med-8f4s.8): the page sends <bp id>/pulse as
            // its own hr kind. A workout spans the pulse, its average from its
            // own associated samples (100, 120): the pulse must not move it.
            let bpm = HKUnit.count().unitDivided(by: .minute())
            let pulse = bp + "/pulse", pulseAt = Date(timeIntervalSince1970: at / 1000)
            step("workout seed")
            let config = HKWorkoutConfiguration()
            config.activityType = .walking
            let builder = HKWorkoutBuilder(healthStore: store, configuration: config, device: .local())
            let ws = pulseAt.addingTimeInterval(-600)
            try await builder.beginCollection(at: ws)
            let workoutHRs = [100.0, 120.0].enumerated().map { i, b in
                HKQuantitySample(type: Health.heartRate, quantity: HKQuantity(unit: bpm, doubleValue: b),
                                 start: ws.addingTimeInterval(Double(i + 1) * 120), end: ws.addingTimeInterval(Double(i + 1) * 120))
            }
            try await builder.addSamples(workoutHRs)
            try await builder.endCollection(at: pulseAt.addingTimeInterval(600))
            let workout = try await builder.finishWorkout()
            seeded = workoutHRs + (workout.map { [$0] } ?? [])
            /// The workout's average heart rate as the workout import reads it.
            func workoutHR() async throws -> Double {
                try await pages("workout")[workout?.uuid.uuidString ?? "none"]?["hr"] as? Double ?? -1
            }
            step("workout read")
            let before = try await workoutHR()
            step("pulse")
            check("workout hr seeded", abs(before - 110) < 0.01, before)
            for (version, b) in [(1_000, 61.0), (2_000, 64.0)] {
                _ = try await Health.handle("health.write", ["type": "hr", "id": pulse, "version": version, "at": at, "bpm": b])
            }
            for (version, b) in [(2_000, 64.0), (1_000, 61.0)] {
                await replay("hr v\(version)", ["type": "hr", "id": pulse, "version": version, "at": at, "bpm": b])
            }
            let hrs = try await synced(Health.heartRate, pulse)
            check("one pulse", hrs.count == 1 && value(hrs.first, bpm) == 64, "\(hrs.count) \(value(hrs.first, bpm))")
            check("pulse version", (hrs.first?.metadata?[HKMetadataKeySyncVersion] as? NSNumber)?.intValue == 2_000)
            check("pulse our source", hrs.first.map { Health.ours($0) } == true)
            check("pulse at", hrs.first.map { abs($0.startDate.timeIntervalSince(pulseAt)) < 0.001 } == true)
            let after = try await workoutHR()
            check("workout hr unchanged by pulse", abs(after - before) < 0.01, "\(before) → \(after)")

            // An unmarked same-bundle heart-rate sample still imports; our pulse does not.
            let plainHR = HKQuantitySample(type: Health.heartRate, quantity: HKQuantity(unit: bpm, doubleValue: 77), start: t, end: t)
            try await store.save(plainHR)
            plain.append(plainHR)
            let hrSeen = try await imported("hr")
            check("unmarked hr imports", hrSeen.contains(plainHR.uuid.uuidString))
            check("own pulse filtered", hrs.first.map { !hrSeen.contains($0.uuid.uuidString) } == true)
            check("delete unknown pulse", try await Health.handle("health.delete", ["type": "hr", "id": "bp-qa-never-written/pulse"]) as? Bool == true)
            check("delete pulse", try await Health.handle("health.delete", ["type": "hr", "id": pulse]) as? Bool == true)
            let strayPulse = try await synced(Health.heartRate, pulse).count
            check("pulse gone", strayPulse == 0, strayPulse)
            check("unmarked hr kept", try await find(Health.heartRate, HKQuery.predicateForObject(with: plainHR.uuid)).count == 1)

            // Workout write-back (bd med-8f4s.10): the page's payload for a
            // completed session. The second write (higher version, strength,
            // longer) must replace the first (other): one workout left.
            step("workout write")
            let session = "workoutsession-qa-\(run)", wt = HKObjectType.workoutType()
            let start = at - 7_200_000, ends = [at - 5_400_000, at - 4_500_000]
            for (version, activity, end) in [(1_000, 3000, ends[0]), (2_000, 50, ends[1])] {
                _ = try await Health.handle("health.write", ["type": "workout", "id": session, "version": version,
                                                             "start": start, "end": end, "activity": activity])
            }
            for (version, activity, end) in [(2_000, 50, ends[1]), (1_000, 3000, ends[0])] {
                await replay("workout v\(version)", ["type": "workout", "id": session, "version": version,
                                                     "start": start, "end": end, "activity": activity])
            }
            let mine = try await synced(wt, session)
            let w = mine.first as? HKWorkout
            check("one workout", mine.count == 1, mine.count)
            check("workout version", (w?.metadata?[HKMetadataKeySyncVersion] as? NSNumber)?.intValue == 2_000)
            check("workout strength", w?.workoutActivityType == .traditionalStrengthTraining,
                  w.map { "\($0.workoutActivityType.rawValue)" } ?? "none")
            check("workout our source", w.map { Health.ours($0) } == true)
            check("workout span", w.map { abs(ms($0.startDate) - start) < 1 && abs(ms($0.endDate) - ends[1]) < 1 } == true,
                  w.map { "\(ms($0.startDate))…\(ms($0.endDate))" } ?? "none")
            // held() is what turns a store error into true (bd med-8f4s.14 R4):
            // true only at our version or below it; the false cases are the
            // proof that a real store error still rethrows.
            step("held")
            let heldCases: [(String, Int64, Bool)] = [(session, 1_000, true), (session, 2_000, true), (session, 2_001, false),
                                                      ("workoutsession-qa-never-written", 1, false)]
            for (id, version, want) in heldCases {
                do { check("held \(id == session ? "workout" : "never-written") v\(version) \(want)",
                           try await Health.held("workout", id, version) == want) }
                catch { let e = error as NSError; check("held workout v\(version)", false, "\(e.domain) \(e.code)") }
            }
            var refused = false
            do { _ = try await Health.handle("health.write", ["type": "workout", "id": session + "-bad", "version": 1,
                                                              "start": start, "end": ends[0], "activity": 52]) }
            catch { refused = error.localizedDescription == "bad write: activity" }
            check("activity refused", refused)
            check("nothing for refused activity", try await synced(wt, session + "-bad").isEmpty)
            // Our workout never imports; the unmarked same-bundle seed does.
            step("workout filter")
            let workoutSeen = try await imported("workout")
            check("own workout filtered", w.map { !workoutSeen.contains($0.uuid.uuidString) } == true)
            check("unmarked workout imports", workout.map { workoutSeen.contains($0.uuid.uuidString) } == true)
            step("workout delete")
            check("delete unknown workout", try await Health.handle("health.delete", ["type": "workout", "id": "workoutsession-qa-never-written"]) as? Bool == true)
            check("delete workout", try await Health.handle("health.delete", ["type": "workout", "id": session]) as? Bool == true)
            let strayWorkout = try await synced(wt, session).count
            check("workout gone", strayWorkout == 0, strayWorkout)
            check("unmarked workout kept", try await find(wt, HKQuery.predicateForObject(with: workout?.uuid ?? UUID())).count == 1)

            // Batch (bd med-8f4s.14, Android twin .13): 10 mixed bodies → 10
            // true in order, one object per id; then a malformed body gets its
            // own error string while the others in the call are saved.
            step("batch")
            let b = "qa-batch-\(run)"
            var written: [(kind: String, id: String, type: HKSampleType)] = []
            var entries: [Any] = []
            for i in 0..<4 {
                let id = "weight-\(b)-\(i)"
                entries.append(["type": "weight", "id": id, "version": 1_000, "at": at - Double(i) * 60_000, "kg": 70.0 + Double(i)])
                written.append(("weight", id, Health.bodyMass))
                let pid = "bp-\(b)-\(i)/pulse"
                entries.append(["type": "hr", "id": pid, "version": 1_000, "at": at - Double(i) * 60_000, "bpm": 60.0 + Double(i)])
                written.append(("hr", pid, Health.heartRate))
            }
            for i in 0..<2 {
                let id = "workoutsession-\(b)-\(i)", s = at - Double(i + 3) * 7_200_000
                entries.append(["type": "workout", "id": id, "version": 1_000, "start": s, "end": s + 1_800_000, "activity": 50])
                written.append(("workout", id, wt))
            }
            if bpOn {
                let id = "bp-\(b)-bp"
                entries.append(["type": "bp", "id": id, "version": 1_000, "at": at, "systolic": 118.0, "diastolic": 76.0])
                written.append(("bp", id, bpType))
            }
            func results(_ reply: Any) -> [String] {
                (reply as? [Any] ?? []).map { $0 as? Bool == true ? "true" : ($0 as? String ?? "\($0)") }
            }
            let reply = results(try await Health.handle("health.write", ["entries": entries]))
            check("batch all true", reply == Array(repeating: "true", count: entries.count), reply)
            var counts: [String] = []
            for w in written {
                let n = try await synced(w.type, w.id).count
                counts.append("\(n)")
            }
            check("batch one per id", counts == Array(repeating: "1", count: written.count), counts)

            let okKg = "weight-\(b)-ok", okHR = "bp-\(b)-ok/pulse", badKg = "weight-\(b)-bad"
            let mixed: [Any] = [
                ["type": "weight", "id": okKg, "version": 1_000, "at": at, "kg": 71.5],
                ["type": "weight", "id": badKg, "version": 1_000, "at": at, "kg": -1.0],
                "not an object",
                ["type": "sleep", "id": "sleep-\(b)", "version": 1_000, "at": at],
                [String: Any](),
                ["type": "hr", "id": okHR, "version": 1_000, "at": at, "bpm": 66.0],
            ]
            written += [("weight", okKg, Health.bodyMass), ("hr", okHR, Health.heartRate)]
            let mixedReply = results(try await Health.handle("health.write", ["entries": mixed]))
            check("batch malformed", mixedReply == ["true", "bad write: kg", "bad write: entry", "unknown type: sleep", "bad write", "true"], mixedReply)
            let okKgs = try await synced(Health.bodyMass, okKg).count, okHRs = try await synced(Health.heartRate, okHR).count
            check("batch others saved", okKgs == 1 && okHRs == 1, "\(okKgs) \(okHRs)")
            check("batch malformed nothing", try await synced(Health.bodyMass, badKg).isEmpty)
            var shape = ""
            do { _ = try await Health.handle("health.write", ["entries": "x"]) } catch { shape = error.localizedDescription }
            check("entries not a list throws", shape == "bad write: entries", shape)
            var bare = ""
            do { _ = try await Health.handle("health.write", [:]) } catch { bare = error.localizedDescription }
            check("bare write unchanged", bare == "bad write", bare)
            // Denied is a whole-call failure, not an entry string: the Simulator
            // leaves BP share notDetermined, so a batch carrying bp throws.
            if !bpOn {
                let deniedKg = "weight-\(b)-denied"
                written.append(("weight", deniedKg, Health.bodyMass))  // saved before bp throws; cleaned below
                var denied = "resolved"
                do {
                    _ = try await Health.handle("health.write", ["entries": [
                        ["type": "weight", "id": deniedKg, "version": 1_000, "at": at, "kg": 70.0],
                        ["type": "bp", "id": "bp-\(b)-denied", "version": 1_000, "at": at, "systolic": 118.0, "diastolic": 76.0],
                    ]])
                } catch { denied = error.localizedDescription }
                check("batch denied throws", denied == "denied", denied)
            }
            for w in written { _ = try await Health.handle("health.delete", ["type": w.kind, "id": w.id]) }
            var strayBatch = 0
            for w in written { strayBatch += try await synced(w.type, w.id).count }
            check("batch gone", strayBatch == 0, strayBatch)
        } catch {
            let e = error as NSError
            failed.append("error \(e.domain) \(e.code) \(e.localizedDescription)")
        }
        if !plain.isEmpty { try? await store.delete(plain) }
        if !seeded.isEmpty { try? await store.delete(seeded) }
        result["failed"] = failed
        result["ok"] = failed.isEmpty
        return result
    }
}
#endif
