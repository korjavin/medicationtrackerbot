import AVFoundation
import SwiftUI
import UIKit
import VisionKit
import WebKit

// The iOS shell (bd med-w6gx.3): first-run → the account origin in one
// WKWebView (Shell.swift). docs/ios.md.
@main
struct WGApp: App {
    @UIApplicationDelegateAdaptor(QuickAction.self) private var quickAction
    @StateObject private var shell = Shell()

    init() {
        Notifications.shared.install() // before launch finishes: a tap that started the app is delivered
    }

    var body: some Scene {
        WindowGroup { RootView(shell: shell) }
    }
}

struct RootView: View {
    @ObservedObject var shell: Shell
    @Environment(\.scenePhase) private var phase
    /// Local-mode diagnostic (bd med-o7zq.1): exists only while its Settings toggle is on.
    @State private var spike: LocalSpike?
    /// N6 (bd med-ckm5.15): the launch screen's mark, kept over the first page until it is ready.
    @State private var launchMark = true

    var body: some View {
        Group {
            if let spike {
                LocalSpikeView(spike: spike) {
                    UserDefaults.standard.set(false, forKey: LocalSpike.toggleKey)
                    spike.stop()
                    self.spike = nil
                }
            } else if shell.host == nil && !shell.local {
                FirstRunView(shell: shell)
            } else if shell.concealed {
                // The web view leaves the window: its page goes hidden, so no
                // visibility-triggered work (Health import, reminders) runs.
                LockView(shell: shell)
            } else {
                WebView(webView: shell.webView)
                    .ignoresSafeArea(.keyboard) // WKWebView handles the keyboard itself
                    .background {
                        // The safe-area bands, in the page's own top/bottom colours.
                        VStack(spacing: 0) { shell.top; shell.bottom }.ignoresSafeArea()
                    }
                    .overlay {
                        if let error = shell.loadError { LoadErrorView(shell: shell, error: error) }
                    }
            }
        }
        .overlay {
            // Before the app-switcher snapshot (taken after inactive): no data
            // in it, the teal and the mark (N3). Not under the lock's own
            // prompt: the lock screen shows there, dimmed.
            if launchMark || (phase != .active && shell.local && shell.lock.on && shell.lock.state != .unlocking) {
                LaunchCover()
            }
        }
        .onChange(of: launchDone, initial: true) { _, done in
            if done { withAnimation(.easeOut(duration: 0.18)) { launchMark = false } }
        }
        // Invite links (bd med-ta2n.11): the landing universal link and the
        // medtracker:// scheme both arrive here, cold or warm.
        .onOpenURL { shell.capture($0) }
        .alert("Diagnostics copied", isPresented: $shell.diagCopied) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Paste them into your message to support.")
        }
        .onChange(of: phase) { _, now in
            if now == .active {
                shell.applySettings()
                shell.didBecomeActive()
                openSpikeIfRequested()
            } else if now == .background {
                shell.didEnterBackground()
            }
        }
        .onAppear {
            if phase == .active { shell.didBecomeActive() } // the lock prompts once either way
            openSpikeIfRequested()
        }
    }

    /// The launch mark's job is done: the page is ready, or a native screen
    /// (first run, lock, error) shows instead. `-wgQAHoldMark YES` (Debug) keeps it.
    private var launchDone: Bool {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "wgQAHoldMark") { return false }
        #endif
        return shell.painted || shell.concealed || spike != nil || (shell.host == nil && !shell.local)
    }

    private func openSpikeIfRequested() {
        guard spike == nil, LocalSpike.requested else { return }
        let s = LocalSpike()
        s.start()
        spike = s
    }
}

struct WebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// N1 first run (bd med-ckm5.13, screens-native.html): local first — the
/// boxed "Only on this device" row pushes the intro — then the invite. No
/// signup here: the user brings an invite/claim link, the account address, or
/// the Emergency Kit QR. Continue is the screen's one sun and stays enabled;
/// every problem shows as a field error on the invite input.
struct FirstRunView: View {
    @ObservedObject var shell: Shell
    @State private var text = ""
    @State private var error: String?
    @State private var scanning = false
    /// "Only on this device" tapped: the local intro replaces this screen until Back.
    @State private var localIntro = false
    /// Local mode's origin still has data on this iPhone.
    @State private var resumable = false
    /// A local → cloud move is pending (bd med-o7zq.35): the stash waits for the new account.
    @State private var moving = false
    @FocusState private var focused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var moreBelow = false

    var body: some View {
        if localIntro {
            LocalIntroView(shell: shell, moving: moving) { localIntro = false }
        } else {
            invite
        }
    }

    /// The field's error: the submit's own, else the shell's (account gone).
    private var message: String? { error ?? shell.firstRunMessage }

    private var invite: some View {
        // Scrolls (bd med-o7zq.31): with the keyboard up or at large type a
        // plain VStack clipped the screen.
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 10) {
                    WgMark()
                    Text("Med Tracker").font(Wg.mono(16)).foregroundStyle(Wg.fg1)
                }
                .padding(.top, 12)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Your health log, on your terms")
                        .font(Wg.mono(28)).tracking(-0.56).foregroundStyle(Wg.fg1)
                    Text("Keep it on this iPhone with no account, or open the account you were invited to.")
                        .font(Wg.ui(16)).foregroundStyle(Wg.fg2)
                }
                if moving {
                    WgNote(tone: .info, icon: "arrow.triangle.turn.up.right.diamond",
                           text: Text("Your records are ready to move.").font(Wg.ui(13, .semibold))
                               + Text(" Paste or scan the invite for your new account. They move in after you sign in."))
                }
                // Local mode was left (Switch account, "I have an invite") or its
                // flag was lost, but its records are still here: offer them first,
                // without hiding the invite form (bd med-o7zq.31).
                if resumable {
                    WgNote(tone: .info, icon: "iphone",
                           text: Text("Your records from \"Only on this device\" are still on this iPhone."))
                    Button("Continue on this iPhone") { shell.openLocal() }
                        .buttonStyle(WgButtonStyle())
                        .frame(maxWidth: .infinity)
                }
                // A pending move puts the invite first: opening the new account is the next step.
                if moving {
                    inviteSection
                    or
                    localRow
                } else {
                    localRow
                    or
                    inviteSection
                }
                // App Store packaging (bd med-w6gx.8): same wording as the store description.
                Text("Med Tracker is a personal log, not a medical device, and does not give medical advice. Talk to your doctor before changing a treatment.")
                    .font(Wg.ui(12)).foregroundStyle(Wg.fg3)
                HStack(alignment: .firstTextBaseline) {
                    Link("Privacy policy", destination: URL(string: "https://github.com/korjavin/medicationtrackerbot/blob/master/docs/privacy-policy.md")!)
                    Spacer(minLength: 16)
                    // The service's landing page says how to get an invite (Android's twin link).
                    if !shell.base.isEmpty, let landing = URL(string: "https://\(shell.base)/") {
                        Link("How to get an invite", destination: landing).multilineTextAlignment(.trailing)
                    }
                }
                .font(Wg.ui(13, .semibold))
                .foregroundStyle(Wg.sun)
            }
            .padding(.horizontal, Wg.gutter)
            .padding(.top, 8)
            .padding(.bottom, Wg.gutter)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // At accessibility sizes the column fades at the bottom while more is
        // below: the cut-off text reads as "more below", the end reads clear.
        .onScrollGeometryChange(for: Bool.self) { g in
            g.contentOffset.y + g.containerSize.height < g.contentSize.height + g.contentInsets.bottom - 1
        } action: { _, below in
            moreBelow = below
        }
        .mask {
            let fade = typeSize.isAccessibilitySize && moreBelow
            LinearGradient(stops: [.init(color: .black, location: 0),
                                   .init(color: .black, location: fade ? 0.82 : 1),
                                   .init(color: fade ? .clear : .black, location: 1)],
                           startPoint: .top, endPoint: .bottom)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Wg.screen.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onAppear {
            moving = shell.move.exists || Self.qaMoving
            // While a move is pending the records are on their way to the account; Continue here would drop the stash.
            resumable = !moving && LocalOrigin.offersResume(host: shell.host, local: shell.local, dataDirs: LocalOrigin.dataDirs().count)
            // "There is no account at …": the address stays in the field, to fix in place.
            if text.isEmpty, shell.firstRunMessage != nil, let gone = shell.firstRunInput { text = gone }
        }
        // A captured invite link (bd med-ta2n.11) waits in the field: the user taps Continue to open it.
        .onChange(of: shell.pendingInvite, initial: true) { _, url in
            if let url {
                text = url
                error = nil
            }
        }
        .sheet(isPresented: $scanning) {
            VStack(spacing: 0) {
                HStack {
                    Text("Scan QR code").font(Wg.mono(16)).foregroundStyle(Wg.fg1)
                    Spacer()
                    Button("Cancel") { scanning = false }.buttonStyle(WgGhostButtonStyle())
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                QRScanner { payload in
                    scanning = false
                    // Straight to submit, never into the text field: a kit QR carries the recovery code.
                    submit(payload)
                }
                .ignoresSafeArea()
            }
            .background(Wg.screen.ignoresSafeArea())
            .preferredColorScheme(.dark)
        }
    }

    /// Local mode (bd med-o7zq.5): the boxed row that pushes the intro (N2).
    private var localRow: some View {
        Button { localIntro = true } label: {
            HStack(spacing: 12) {
                Image(systemName: "iphone")
                    .font(Wg.ui(16))
                    .foregroundStyle(Wg.okFg)
                    .frame(width: 36, height: 36)
                    .background(Wg.okBg, in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Only on this device").font(Wg.ui(14, .medium)).foregroundStyle(Wg.fg1)
                    Text(moving ? "Stay without an account and cancel the move" : "No account. Records stay on this iPhone.")
                        .font(Wg.ui(12)).foregroundStyle(Wg.fg3)
                }
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(Wg.ui(14)).foregroundStyle(Wg.fg3)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: 56)
            .background(Wg.card, in: RoundedRectangle(cornerRadius: Wg.radiusRow))
            .overlay(RoundedRectangle(cornerRadius: Wg.radiusRow).strokeBorder(Wg.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The flows find it by this label (ios/UITests); the description is the hint.
        .accessibilityLabel("Only on this device")
        .accessibilityHint(moving ? "Stay without an account and cancel the move" : "No account. Records stay on this iPhone.")
    }

    private var or: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Wg.lineStrong).frame(height: 1)
            Text("OR").font(Wg.ui(10.5, .semibold)).tracking(1.5).foregroundStyle(Wg.fg3)
            Rectangle().fill(Wg.lineStrong).frame(height: 1)
        }
        .accessibilityHidden(true)
    }

    private var inviteSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                WgLabel(text: "Have an invite?")
                HStack(alignment: .top, spacing: 8) {
                    TextField("", text: $text,
                              prompt: Text(typeSize.isAccessibilitySize ? "Invite link" : "Paste invite link or address").foregroundStyle(Wg.fg4))
                        .font(Wg.ui(14, .medium))
                        .foregroundStyle(Wg.fg1)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($focused)
                        .onSubmit { submit(text) }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 48)
                        .background(Wg.inset, in: RoundedRectangle(cornerRadius: Wg.radiusField))
                        .overlay(RoundedRectangle(cornerRadius: Wg.radiusField)
                            .strokeBorder(message != nil ? Wg.dangerLine : focused ? Wg.sun.opacity(0.6) : Wg.lineDark))
                        // The flows find the field by this label (ios/UITests).
                        .accessibilityLabel("Invite link or account address")
                    if DataScannerViewController.isSupported {
                        Button { scan() } label: {
                            Image(systemName: "qrcode.viewfinder").font(Wg.ui(18))
                        }
                        .buttonStyle(WgButtonStyle(square: true))
                        .accessibilityLabel("Scan QR code")
                    }
                }
                if let message {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle").accessibilityHidden(true)
                        Text(message) // its own static text: the account-gone flow finds it by label
                    }
                    .font(Wg.ui(12, .medium))
                    .foregroundStyle(Wg.dangerFg)
                    Text("Check the address, or ask whoever invited you for a new link.")
                        .font(Wg.ui(12)).foregroundStyle(Wg.fg3)
                } else {
                    Text("From your invite, or scan the QR on your Emergency Kit.")
                        .font(Wg.ui(12)).foregroundStyle(Wg.fg3)
                }
            }
            Button("Continue") { submit(text) }
                .buttonStyle(WgPrimaryButtonStyle())
        }
    }

    private func submit(_ raw: String) {
        if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            error = "Paste your invite link or account address."
            return
        }
        error = shell.open(raw)
    }

    private func scan() {
        Task {
            if await AVCaptureDevice.requestAccess(for: .video) {
                scanning = true
            } else {
                error = "Allow camera access for Med Tracker in Settings to scan a QR code."
            }
        }
    }

    /// Visual QA (Debug only): `-wgQAMovePending YES` draws the pending-move state.
    static var qaMoving: Bool {
        #if DEBUG
        UserDefaults.standard.bool(forKey: "wgQAMovePending")
        #else
        false
        #endif
    }
}

/// N2 local intro (bd med-o7zq.5, med-ckm5.13): what "only on this device"
/// means for the user's data, before the choice is stored. Honest on purpose —
/// this can be someone's only medication history.
struct LocalIntroView: View {
    @ObservedObject var shell: Shell
    /// A local → cloud move is pending: Start cancels it (openLocal clears the stash).
    let moving: Bool
    let back: () -> Void
    @State private var lock = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: back) {
                    HStack(spacing: 2) {
                        Image(systemName: "chevron.left")
                        Text("Back")
                    }
                }
                .buttonStyle(WgGhostButtonStyle())
                .accessibilityLabel("Back")
                Spacer()
            }
            .padding(.horizontal, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Only on this device")
                            .font(Wg.mono(28)).tracking(-0.56).foregroundStyle(Wg.fg1)
                        Text("Use Med Tracker without an account. Your records live on this iPhone.")
                            .font(Wg.ui(16)).foregroundStyle(Wg.fg2)
                    }
                    VStack(alignment: .leading, spacing: 14) {
                        fact("iphone", "Stored here, nowhere else", "Nothing is sent to a server.")
                        fact("arrow.down.doc", "You make the backups", "Export an encrypted file from Settings → Backup & import.")
                        fact("exclamationmark.triangle", "Lose the phone, lose the records", "Unless you have a backup file.", warn: true)
                        fact("arrow.triangle.turn.up.right.diamond", "Move to an account later", "Settings → Move to a cloud account.")
                    }
                    // Optional lock (bd med-o7zq.8); also iPhone Settings → Med Tracker → Lock.
                    if DeviceAuth.available { lockRow }
                    if let error {
                        WgNote(tone: .danger, icon: "exclamationmark.triangle", text: Text(error))
                    }
                    if moving {
                        WgNote(tone: .warn, icon: "exclamationmark.triangle",
                               text: Text("A move to a cloud account is waiting.").font(Wg.ui(13, .semibold))
                                   + Text(" Start here cancels it. Your records stay on this iPhone."))
                    }
                }
                .padding(.horizontal, Wg.gutter)
                .padding(.top, 8)
                .padding(.bottom, Wg.gutter)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // Start docked at the bottom, the screen's one sun.
            WgShellFoot {
                Button(moving ? "Start and cancel the move" : "Start") { start() }
                    .buttonStyle(WgPrimaryButtonStyle())
                if moving {
                    Button("Open the new account instead", action: back)
                        .buttonStyle(WgGhostButtonStyle())
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .background(Wg.screen.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onAppear { lock = shell.lock.on } // still on from an earlier stay in local mode
    }

    private func fact(_ icon: String, _ lead: String, _ detail: String, warn: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: icon)
                .font(Wg.ui(16))
                .foregroundStyle(warn ? Wg.warnFg : Wg.mint)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(lead).font(Wg.ui(14, .semibold)).foregroundStyle(warn ? Wg.warnFg : Wg.fg1)
                Text(detail).font(Wg.ui(13)).foregroundStyle(Wg.fg2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    private var lockRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "lock")
                .font(Wg.ui(16))
                .foregroundStyle(lock ? Wg.sun : Wg.fg2)
                .frame(width: 36, height: 36)
                .background(lock ? Wg.warnBg : Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Lock with \(DeviceAuth.method)").font(Wg.ui(14, .medium)).foregroundStyle(Wg.fg1)
                Text("Hides the app. It doesn't encrypt, and reminders still show on the lock screen.")
                    .font(Wg.ui(12)).foregroundStyle(Wg.fg3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityHidden(true) // the switch carries the label and the hint
            Toggle("Lock with \(DeviceAuth.method)", isOn: $lock)
                .labelsHidden()
                .tint(Wg.sun)
                .accessibilityHint("Hides the app. It doesn't encrypt, and reminders still show on the lock screen.")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 56)
        .background(Wg.card, in: RoundedRectangle(cornerRadius: Wg.radiusRow))
        .overlay(RoundedRectangle(cornerRadius: Wg.radiusRow).strokeBorder(Wg.line))
    }

    private func start() {
        Task {
            if await shell.setLock(lock) {
                error = nil
                shell.openLocal()
            } else {
                // A lock already on needs the check either way; a new one can just be switched off.
                error = shell.lock.on
                    ? "The lock is on from before, and changing it or opening Med Tracker needs \(DeviceAuth.method). Try again."
                    : "The lock was not turned on. Try again, or switch it off to continue without it."
            }
        }
    }
}

/// The launch screen as a view (N6): the teal and the centred mark. Also the
/// app-switcher cover while locked (N3).
struct LaunchCover: View {
    var body: some View {
        WgLaunchMark()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Wg.screen)
            .ignoresSafeArea()
            .allowsHitTesting(false)
    }
}

/// N3 app lock (bd med-o7zq.8, med-ckm5.15): local mode's lock screen. The
/// mark sits where the launch screen has it, so launch → lock is a
/// cross-fade; never the account name. A cancelled prompt lands here and
/// stays: only the button asks again. A failed one adds the warn note.
struct LockView: View {
    @ObservedObject var shell: Shell

    var body: some View {
        ZStack(alignment: Alignment(horizontal: .center, vertical: .markCenter)) {
            Color.clear
            VStack(spacing: 16) {
                WgLaunchMark().alignmentGuide(.markCenter) { $0[VerticalAlignment.center] }
                Text("Med Tracker is locked")
                    .font(Wg.mono(22)).tracking(-0.44).foregroundStyle(Wg.fg1)
                Text(DeviceAuth.method == "passcode" ? "Unlock with your passcode." : "Unlock with \(DeviceAuth.method) or your passcode.")
                    .font(Wg.ui(16)).foregroundStyle(Wg.fg2)
                if shell.lock.failed {
                    WgNote(tone: .warn, icon: "exclamationmark.triangle",
                           text: Text("Not recognised. Try again, or use your passcode."))
                        .multilineTextAlignment(.leading)
                }
            }
            .multilineTextAlignment(.center)
            .padding(.horizontal, Wg.gutter)
        }
        .ignoresSafeArea()
        .safeAreaInset(edge: .bottom, spacing: 0) {
            WgShellFoot {
                Button { shell.unlock() } label: {
                    Label("Unlock", systemImage: DeviceAuth.method == "Face ID" ? "faceid" : DeviceAuth.method == "Touch ID" ? "touchid" : "lock")
                }
                .buttonStyle(WgPrimaryButtonStyle())
                .disabled(shell.lock.state == .unlocking)
            }
        }
        .overlay {
            // Under the system prompt (N3): a cancel lands on a screen that still makes sense.
            if shell.lock.state == .unlocking { Color.black.opacity(0.5).ignoresSafeArea() }
        }
        .background(Wg.screen.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }
}

/// N4 load error (bd med-ckm5.15): network/5xx, a bare 404 (warn: trying
/// again can't fix it, so another invite leads), and local mode, which never
/// offers Switch account. The status code is a mono line for support.
struct LoadErrorView: View {
    @ObservedObject var shell: Shell
    let error: LoadError

    var body: some View {
        ViewThatFits(in: .vertical) {
            content
            ScrollView { content.padding(.vertical, 24) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            WgShellFoot {
                // Leaving local mode keeps its data: it is back on the next switch.
                switch error.kind {
                case .network:
                    tryAgain
                    secondary("Switch account") { shell.forget() }
                case .notFound:
                    Button("Use another invite") { shell.forget() }.buttonStyle(WgPrimaryButtonStyle())
                    secondary("Try again") { shell.retry() }
                case .local:
                    tryAgain
                    secondary("Use an account instead") { shell.forget() }
                }
                Button { shell.copyDiagnostics() } label: {
                    Label("Copy diagnostics", systemImage: "doc.on.doc")
                }
                .buttonStyle(WgGhostButtonStyle(small: true))
            }
        }
        .background(Wg.screen.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private var content: some View {
        VStack(spacing: 16) {
            let warn = error.kind == .notFound
            Image(systemName: icon)
                .font(.system(size: 28))
                .foregroundStyle(warn ? Wg.warnFg : Wg.fg2)
                .frame(width: 64, height: 64)
                .background(warn ? Wg.warnBg : Wg.fg1.opacity(0.05), in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(warn ? Wg.warnLine : Wg.fg1.opacity(0.24)))
                .accessibilityHidden(true)
            Text(title).font(Wg.mono(22)).tracking(-0.44).foregroundStyle(Wg.fg1)
            Text(lede).font(Wg.ui(16)).foregroundStyle(Wg.fg2).frame(maxWidth: 320)
            Text(error.meta).font(Wg.mono(12)).foregroundStyle(Wg.fg3)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, Wg.gutter)
        .frame(maxWidth: .infinity)
    }

    private var host: String { shell.host ?? "your account" }

    private var icon: String {
        switch error.kind {
        case .network: "icloud.slash"
        case .notFound: "magnifyingglass"
        case .local: "iphone"
        }
    }

    private var title: String {
        switch error.kind {
        case .network: "Can't reach your account"
        case .notFound: "We can't find this account"
        case .local: "Can't open Med Tracker"
        }
    }

    private var lede: String {
        switch error.kind {
        case .network: "Med Tracker couldn't connect to \(host). Your records are safe. Check your connection and try again."
        case .notFound: "There's no account at \(host) any more. It may have been deleted, or the address changed."
        case .local: "The app on this iPhone didn't start. Your records are still here. Try again, or restart your iPhone if it keeps happening."
        }
    }

    private var tryAgain: some View {
        Button { shell.retry() } label: { Label("Try again", systemImage: "arrow.clockwise") }
            .buttonStyle(WgPrimaryButtonStyle())
    }

    private func secondary(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).frame(maxWidth: .infinity) }.buttonStyle(WgButtonStyle())
    }
}

/// The Home Screen quick action "Copy diagnostics" (bd med-w6gx.24, twin of
/// Android's launcher shortcut; UIApplicationShortcutItems in project.yml):
/// a cold launch hands it to the scene configuration, a running app to the
/// scene delegate.
@MainActor
final class QuickAction: NSObject, UIApplicationDelegate, UIWindowSceneDelegate {
    static let copyType = "copy-diagnostics"

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if options.shortcutItem?.type == QuickAction.copyType { QuickAction.copyDiagnostics() }
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = QuickAction.self
        return config
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        let mine = shortcutItem.type == QuickAction.copyType
        if mine { QuickAction.copyDiagnostics() }
        completionHandler(mine)
    }

    private static func copyDiagnostics() {
        if let shell = Shell.current { shell.copyDiagnostics() } else { Shell.copyOnLaunch = true }
    }
}

/// Reads one QR code with VisionKit and hands back its text.
struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        private var done = false
        init(found: @escaping (String) -> Void) { self.found = found }

        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in addedItems {
                guard !done, let text = code.payloadStringValue else { continue }
                done = true
                scanner.stopScanning()
                found(text)
            }
        }
    }
}

/// Web downloads and printing for the shell (bd med-w6gx.11). WKWebView drops
/// both unless the app handles them. Downloads (blob:/data: `<a download>`,
/// `Content-Disposition: attachment`, types it cannot show) land in a temp file
/// offered through the share sheet (Save to Files), deleted once the sheet
/// closes. `window.print()`, including the offscreen-iframe print in
/// web/cloud/js/print-doc.js, goes to UIPrintInteractionController.
/// The web view's navigation delegate forwards the policy and didBecome calls here.
@MainActor
final class Downloads: NSObject, WKDownloadDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    static let shared = Downloads()
    private var destinations: [WKDownload: URL] = [:]
    private var printView: WKWebView? // retained until its document finished loading and printed
    /// Shell's lock holds (bd med-o7zq.8): nothing the hidden page finishes may show over it.
    var held: @MainActor () -> Bool = { false }

    /// All downloads live here; swept at launch for any file a killed app left behind.
    private let root = FileManager.default.temporaryDirectory.appendingPathComponent("wg-downloads", isDirectory: true)

    func install(on config: WKWebViewConfiguration) {
        try? FileManager.default.removeItem(at: root)
        config.userContentController.add(self, contentWorld: .page, name: "wgPrint")
        config.userContentController.addUserScript(
            WKUserScript(source: Downloads.printShim, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
    }

    static func policy(for action: WKNavigationAction) -> WKNavigationActionPolicy {
        action.shouldPerformDownload ? .download : .allow
    }

    static func policy(for response: WKNavigationResponse) -> WKNavigationResponsePolicy {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment")
        return attachment || !response.canShowMIMEType ? .download : .allow
    }

    // MARK: WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        // Own directory per download: the destination must not exist yet, and
        // the file keeps the page's filename in the share sheet.
        let dir = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            return nil
        }
        let name = (suggestedFilename as NSString).lastPathComponent
        let url = dir.appendingPathComponent(name.isEmpty ? "download" : name)
        destinations[download] = url
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = destinations.removeValue(forKey: download) else { return }
        if held() {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            return
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            // The file can hold a recovery code or a full vault export: delete it now,
            // not when iOS purges tmp (a kill mid-sheet is swept at next launch).
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
        guard let top = Downloads.topViewController() else {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            return
        }
        sheet.popoverPresentationController?.sourceView = top.view
        top.present(sheet, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let url = destinations.removeValue(forKey: download) {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
    }

    // MARK: print

    /// Body is the frame document's HTML for an iframe print, null for the page itself.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let html = message.body as? String else {
            present(message.webView?.viewPrintFormatter())
            return
        }
        // The iframe's document rendered in its own offscreen view: no app CSP,
        // so its inline <style> applies, and nothing of the app chrome prints.
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 612, height: 792))
        view.navigationDelegate = self
        printView = view
        view.loadHTMLString("<!doctype html>" + html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        present(webView.viewPrintFormatter())
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        printView = nil
    }

    private func present(_ formatter: UIPrintFormatter?) {
        guard let formatter, !held() else {
            printView = nil
            return
        }
        let controller = UIPrintInteractionController.shared
        controller.printFormatter = formatter
        controller.present(animated: true) { [weak self] _, _, _ in
            Task { @MainActor in self?.printView = nil }
        }
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.first { $0.activationState == .foregroundActive } as? UIWindowScene
        var top = scene?.keyWindow?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    /// Routes window.print() to the app. print-doc.js prints an offscreen
    /// same-origin iframe through `frame.contentWindow.print()`, so the
    /// contentWindow getter patches that frame's print on the way out. A
    /// cross-origin frame throws on the assignment and keeps its own print.
    static let printShim = #"""
    (() => {
      const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wgPrint;
      if (!h) return;
      window.print = () => h.postMessage(null);
      const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      if (!d || !d.get) return;
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        configurable: true,
        enumerable: d.enumerable,
        get() {
          const w = d.get.call(this);
          try {
            if (w && !w.__wgPrint) {
              w.print = () => h.postMessage(w.document.documentElement.outerHTML);
              w.__wgPrint = true;
            }
          } catch (_) {}
          return w;
        },
      });
    })();
    """#
}
