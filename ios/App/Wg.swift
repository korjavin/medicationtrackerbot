import SwiftUI

/// The native token mirror (bd med-ckm5.13): docs/design/claude-design/ui_kits/app-v2/
/// screens-native.html "Native token mirror", values from its tokens.css — if
/// the two ever disagree, tokens.css wins. Palette, type and the three button
/// styles the native screens need; not a re-implementation of components.css.
enum Wg {
    // Surfaces
    static let screen = Color(hex: 0x132D29)
    static let card = Color(hex: 0x21423D)
    static let ink = Color(hex: 0x0F5042)
    static let inset = LinearGradient(colors: [Color(hex: 0x162F2B), Color(hex: 0x1C3934)], startPoint: .top, endPoint: .bottom)
    static let line = Color.white.opacity(0.07)
    static let lineStrong = Color.white.opacity(0.14)
    static let lineDark = Color.black.opacity(0.28)

    // Text
    static let fg1 = Color(hex: 0xF4FBF7)
    static let fg2 = fg1.opacity(0.76)
    static let fg3 = fg1.opacity(0.6)
    static let fg4 = fg1.opacity(0.36)
    static let onSun = Color(hex: 0x1A1200)
    static let sun = Color(hex: 0xFBBD0D)
    static let mint = Color(hex: 0x9CE4CC)

    // Status: fg on bg, with its line
    static let okFg = mint, okBg = Color(hex: 0x56AC8A, 0.18)
    static let warnFg = Color(hex: 0xFFD870), warnBg = Color(hex: 0xFBBD0D, 0.14), warnLine = Color(hex: 0xFBBD0D, 0.34)
    static let dangerFg = Color(hex: 0xF3A693), dangerBg = Color(hex: 0xC6553A, 0.2), dangerLine = Color(hex: 0xC6553A, 0.45)
    static let infoFg = Color(hex: 0x9FD0F2), infoBg = Color(hex: 0x3FA3E5, 0.14), infoLine = Color(hex: 0x3FA3E5, 0.36)

    // Shape & size
    static let radiusField: CGFloat = 12
    static let radiusRow: CGFloat = 16
    static let radiusSheet: CGFloat = 22
    static let hit: CGFloat = 44
    static let gutter: CGFloat = 24

    /// Space Grotesk (UI). Font.custom(_, size:, relativeTo:) so Dynamic Type scales it.
    enum Weight: String { case regular = "Regular", medium = "Medium", semibold = "SemiBold" }
    static func ui(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        .custom("SpaceGrotesk-\(weight.rawValue)", size: size, relativeTo: style(size))
    }

    /// JetBrains Mono 500 (titles, wordmark, meta).
    static func mono(_ size: CGFloat) -> Font {
        .custom("JetBrainsMono-Medium", size: size, relativeTo: style(size))
    }

    /// The ramp 12 / 14 / 16 / 22 / 28 onto the text styles that scale like it.
    private static func style(_ size: CGFloat) -> Font.TextStyle {
        switch size {
        case ..<13: .caption
        case ..<15: .subheadline
        case ..<20: .body
        case ..<25: .title2
        default: .title
        }
    }

    /// --wg-sunfill: gloss over the sun gradient.
    static var sunFill: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0xFFD14A), Color(hex: 0xE5A600)], startPoint: .top, endPoint: .bottom)
            LinearGradient(stops: [.init(color: .white.opacity(0.34), location: 0), .init(color: .white.opacity(0), location: 0.55)],
                           startPoint: .top, endPoint: .bottom)
        }
    }

    /// --wg-raised: gloss over the raised teal gradient.
    static var raised: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0x3C6B65), Color(hex: 0x264742)], startPoint: .top, endPoint: .bottom)
            LinearGradient(stops: [.init(color: .white.opacity(0.16), location: 0), .init(color: .white.opacity(0), location: 0.52)],
                           startPoint: .top, endPoint: .bottom)
        }
    }
}

extension Color {
    init(hex: UInt32, _ alpha: Double = 1) {
        self.init(.sRGB, red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }
}

/// The one sun-filled control per screen: 52 high, radius 14, grows and wraps at large type.
struct WgPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Wg.ui(16, .semibold))
            .foregroundStyle(Wg.onSun)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(Wg.sunFill)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.black.opacity(0.2)))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// Raised teal with a 1 px line. `square` = the 48 pt icon button beside a field.
struct WgButtonStyle: ButtonStyle {
    var square = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Wg.ui(14, .semibold))
            .foregroundStyle(Wg.fg1)
            .multilineTextAlignment(.center)
            .padding(.horizontal, square ? 0 : 16)
            .padding(.vertical, square ? 0 : 10)
            .frame(minWidth: square ? 48 : nil, minHeight: square ? 48 : Wg.hit)
            .background(Wg.raised)
            .clipShape(RoundedRectangle(cornerRadius: Wg.radiusField))
            .overlay(RoundedRectangle(cornerRadius: Wg.radiusField).strokeBorder(Wg.lineStrong))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// fg-2 text, no fill. `small` = .wg-btn--sm: 13 pt, 36 high (Copy diagnostics).
struct WgGhostButtonStyle: ButtonStyle {
    var small = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Wg.ui(small ? 13 : 14, .semibold))
            .foregroundStyle(configuration.isPressed ? Wg.fg1 : Wg.fg2)
            .multilineTextAlignment(.center)
            .padding(.horizontal, small ? 12 : 10)
            .frame(minHeight: small ? 36 : Wg.hit)
    }
}

/// .wg-shell__foot: the screen's actions docked at the bottom, over a 1 px line.
struct WgShellFoot<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(spacing: 8) { content }
            .padding(.horizontal, Wg.gutter)
            .padding(.vertical, 12)
            .background(alignment: .top) {
                Wg.screen.ignoresSafeArea().overlay(alignment: .top) { Rectangle().fill(Wg.line).frame(height: 1) }
            }
    }
}

/// The 96 pt mark (.wg-mark--lg) as the launch screen draws it (LaunchMark
/// asset, project.yml UILaunchScreen): the launch, the lock screen and the
/// app-switcher cover put it at the same spot, the screen's centre (N3, N6).
struct WgLaunchMark: View {
    var body: some View {
        Image("LaunchMark").accessibilityHidden(true)
    }
}

extension VerticalAlignment {
    private enum MarkCenter: AlignmentID {
        static func defaultValue(in d: ViewDimensions) -> CGFloat { d[VerticalAlignment.center] }
    }
    /// Lines the lock screen's mark up with the launch screen's.
    static let markCenter = VerticalAlignment(MarkCenter.self)
}

/// .wg-note: an icon and a line on a status tint (info, warn, danger).
struct WgNote: View {
    enum Tone { case info, warn, danger }
    let tone: Tone
    let icon: String
    let text: Text

    private var colors: (Color, Color, Color) {
        switch tone {
        case .info: (Wg.infoFg, Wg.infoBg, Wg.infoLine)
        case .warn: (Wg.warnFg, Wg.warnBg, Wg.warnLine)
        case .danger: (Wg.dangerFg, Wg.dangerBg, Wg.dangerLine)
        }
    }

    var body: some View {
        let (fg, bg, line) = colors
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon).foregroundStyle(fg).accessibilityHidden(true)
            text.foregroundStyle(Wg.fg1).frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(Wg.ui(13))
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(bg, in: RoundedRectangle(cornerRadius: Wg.radiusField))
        .overlay(RoundedRectangle(cornerRadius: Wg.radiusField).strokeBorder(line))
    }
}
