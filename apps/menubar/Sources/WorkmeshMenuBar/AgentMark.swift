import CoreGraphics
import SwiftUI

/// The agents' real marks, drawn as template shapes (they take the foreground
/// style, so they tint like SF Symbols). Path data is Simple Icons (CC0-1.0;
/// the brands are their owners' trademarks), copied from the board's
/// `apps/hub/src/board/b3os/ds/kit/logo-paths.ts` so both surfaces draw the
/// same marks. Both paths are in a 24 x 24 box.
enum AgentMark: CaseIterable {
    case anthropic, openai, gemini, opencode, cursor, windsurf, cline

    /// The mark for a session `source`; nil for sources drawn with an SF Symbol.
    init?(source: String) {
        switch source.lowercased() {
        case "claude-code", "claude": self = .anthropic
        case "codex": self = .openai
        case "gemini-cli", "gemini", "antigravity", "agy": self = .gemini
        case "opencode": self = .opencode
        case "cursor": self = .cursor
        case "windsurf": self = .windsurf
        case "cline": self = .cline
        default: return nil
        }
    }

    var accessibilityTitle: String {
        switch self {
        case .anthropic: return "Claude Code"
        case .openai: return "Codex"
        case .gemini: return "Gemini / Antigravity"
        case .opencode: return "OpenCode"
        case .cursor: return "Cursor"
        case .windsurf: return "Windsurf"
        case .cline: return "Cline"
        }
    }

    fileprivate var pathData: String {
        switch self {
        case .anthropic:
            return "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"
        case .openai:
            return "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
        case .gemini:
            return "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81Z"
        case .opencode:
            return "M22 24H2V0h20zM17 4.8H7v14.4h10z"
        case .cursor:
            return "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23Z"
        case .windsurf:
            return "M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z"
        case .cline:
            return "m23.365 13.556-1.442-2.895V8.994c0-2.764-2.218-5.002-4.954-5.002h-2.464c.178-.367.276-.779.276-1.213A2.77 2.77 0 0 0 12.018 0a2.77 2.77 0 0 0-2.763 2.779c0 .434.098.846.276 1.213H7.067c-2.736 0-4.954 2.238-4.954 5.002v1.667L.64 13.549c-.149.29-.149.636 0 .927l1.472 2.855v1.667C2.113 21.762 4.33 24 7.067 24h9.902c2.736 0 4.954-2.238 4.954-5.002V17.33l1.44-2.865c.143-.286.143-.622.002-.91m-12.854 2.36a2.27 2.27 0 0 1-2.261 2.273 2.27 2.27 0 0 1-2.261-2.273v-4.042A2.27 2.27 0 0 1 8.249 9.6a2.267 2.267 0 0 1 2.262 2.274zm7.285 0a2.27 2.27 0 0 1-2.26 2.273 2.27 2.27 0 0 1-2.262-2.273v-4.042A2.267 2.267 0 0 1 15.535 9.6a2.267 2.267 0 0 1 2.261 2.274z"
        }
    }

    /// Parsed once per mark.
    var path: CGPath { Self.parsed[self] ?? CGMutablePath() }

    private static let parsed: [AgentMark: CGPath] = Dictionary(
        uniqueKeysWithValues: allCases.map { ($0, SVGPath.parse($0.pathData)) }
    )
}

/// A mark scaled into its frame, centred, aspect kept.
struct AgentMarkShape: Shape {
    let mark: AgentMark

    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        var t = CGAffineTransform(translationX: rect.midX - 12 * s, y: rect.midY - 12 * s).scaledBy(x: s, y: s)
        return Path(mark.path.copy(using: &t) ?? mark.path)
    }
}

/// The source glyph used by every row: the agent's mark for Claude Code and
/// Codex, an SF Symbol for workflows and anything else.
struct AgentGlyph: View {
    let source: String
    var size: CGFloat = 12

    var body: some View {
        if let mark = AgentMark(source: source) {
            AgentMarkShape(mark: mark)
                .frame(width: size, height: size)
                .accessibilityLabel(mark.accessibilityTitle)
        } else {
            Image(systemName: Self.symbol(for: source))
                .font(.system(size: size - 1, weight: .semibold))
        }
    }

    static func symbol(for source: String) -> String {
        switch source.lowercased() {
        case "claude-code", "claude": return "asterisk"
        case "codex": return "chevron.left.forwardslash.chevron.right"
        case "workflow": return "point.3.connected.trianglepath.dotted"
        case "gemini-cli", "gemini", "antigravity", "agy": return "sparkle"
        case "opencode": return "cpu"
        case "grok": return "bolt.fill"
        case "cursor": return "cursorarrow.rays"
        case "copilot", "github-copilot": return "airplane"
        case "windsurf": return "wind"
        case "amp": return "waveform"
        case "aider": return "wrench.and.screwdriver"
        case "cline": return "terminal.fill"
        case "zed": return "z.square"
        case "harness": return "square.grid.2x2"
        default: return "terminal"
        }
    }
}

/// A small SVG path-data parser: M L H V C S Q T A Z, absolute and relative,
/// implicit repeats, compact numbers (".5.5", "-.3") and packed arc flags
/// ("0 01"). Arcs become cubic Béziers. Enough for vendored icon paths; on
/// malformed data it stops and returns what it has.
enum SVGPath {
    static func parse(_ d: String) -> CGPath {
        var p = Parser(bytes: Array(d.utf8))
        return p.run()
    }

    private struct Parser {
        let bytes: [UInt8]
        var i = 0
        let path = CGMutablePath()
        var cur = CGPoint.zero
        var start = CGPoint.zero
        var lastCubic: CGPoint?
        var lastQuad: CGPoint?

        init(bytes: [UInt8]) { self.bytes = bytes }

        mutating func run() -> CGPath {
            while let cmd = command() {
                var first = true
                repeat {
                    guard step(cmd, first: first) else { return path }
                    first = false
                } while cmd != UInt8(ascii: "Z") && cmd != UInt8(ascii: "z") && hasNumber()
            }
            return path
        }

        // MARK: Tokens

        mutating func skip() {
            while i < bytes.count {
                let c = bytes[i]
                guard c == 0x20 || c == 0x2C || (0x09...0x0D).contains(c) else { return }
                i += 1
            }
        }

        mutating func command() -> UInt8? {
            skip()
            guard i < bytes.count else { return nil }
            let c = bytes[i]
            guard "MmLlHhVvCcSsQqTtAaZz".utf8.contains(c) else { return nil }
            i += 1
            return c
        }

        mutating func hasNumber() -> Bool {
            skip()
            guard i < bytes.count else { return false }
            let c = bytes[i]
            return (0x30...0x39).contains(c) || c == 0x2D || c == 0x2B || c == 0x2E
        }

        mutating func number() -> CGFloat? {
            skip()
            let begin = i
            if i < bytes.count, bytes[i] == 0x2D || bytes[i] == 0x2B { i += 1 }
            var digits = false, dot = false
            while i < bytes.count {
                let c = bytes[i]
                if (0x30...0x39).contains(c) {
                    digits = true
                } else if c == 0x2E && !dot {
                    dot = true
                } else {
                    break
                }
                i += 1
            }
            if digits, i < bytes.count, bytes[i] == 0x65 || bytes[i] == 0x45 { // exponent
                var j = i + 1
                if j < bytes.count, bytes[j] == 0x2D || bytes[j] == 0x2B { j += 1 }
                if j < bytes.count, (0x30...0x39).contains(bytes[j]) {
                    i = j
                    while i < bytes.count, (0x30...0x39).contains(bytes[i]) { i += 1 }
                }
            }
            guard digits, let v = Double(String(decoding: bytes[begin..<i], as: UTF8.self)) else {
                i = begin
                return nil
            }
            return CGFloat(v)
        }

        mutating func flag() -> Bool? {
            skip()
            guard i < bytes.count else { return nil }
            switch bytes[i] {
            case 0x30: i += 1; return false
            case 0x31: i += 1; return true
            default: return nil
            }
        }

        mutating func point(_ relative: Bool) -> CGPoint? {
            guard let x = number(), let y = number() else { return nil }
            return relative ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
        }

        // MARK: Commands

        /// One argument group of `cmd`. False when the data runs out mid-group.
        mutating func step(_ cmd: UInt8, first: Bool) -> Bool {
            let rel = cmd >= 0x61
            var nextCubic: CGPoint?
            var nextQuad: CGPoint?
            switch cmd | 0x20 { // lower-case
            case 0x6D: // m: a moveto, then implicit linetos
                guard let p = point(rel) else { return false }
                if first {
                    path.move(to: p)
                    start = p
                } else {
                    path.addLine(to: p)
                }
                cur = p
            case 0x6C: // l
                guard let p = point(rel) else { return false }
                path.addLine(to: p)
                cur = p
            case 0x68: // h
                guard let x = number() else { return false }
                cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y)
                path.addLine(to: cur)
            case 0x76: // v
                guard let y = number() else { return false }
                cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y)
                path.addLine(to: cur)
            case 0x63: // c
                guard let c1 = point(rel), let c2 = point(rel), let p = point(rel) else { return false }
                path.addCurve(to: p, control1: c1, control2: c2)
                nextCubic = c2
                cur = p
            case 0x73: // s
                let c1 = lastCubic.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                guard let c2 = point(rel), let p = point(rel) else { return false }
                path.addCurve(to: p, control1: c1, control2: c2)
                nextCubic = c2
                cur = p
            case 0x71: // q
                guard let c = point(rel), let p = point(rel) else { return false }
                path.addQuadCurve(to: p, control: c)
                nextQuad = c
                cur = p
            case 0x74: // t
                let c = lastQuad.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                guard let p = point(rel) else { return false }
                path.addQuadCurve(to: p, control: c)
                nextQuad = c
                cur = p
            case 0x61: // a
                guard let rx = number(), let ry = number(), let rot = number(),
                      let large = flag(), let sweep = flag(), let p = point(rel)
                else { return false }
                arc(to: p, rx: rx, ry: ry, degrees: rot, large: large, sweep: sweep)
                cur = p
            case 0x7A: // z
                path.closeSubpath()
                cur = start
            default:
                return false
            }
            lastCubic = nextCubic
            lastQuad = nextQuad
            return true
        }

        /// SVG endpoint arc → centre parameterisation (SVG 1.1 F.6.5), then one
        /// cubic per quarter turn or less.
        func arc(to p: CGPoint, rx rx0: CGFloat, ry ry0: CGFloat, degrees: CGFloat, large: Bool, sweep: Bool) {
            let p0 = cur
            if p0 == p { return }
            var rx = abs(rx0), ry = abs(ry0)
            guard rx > 0, ry > 0 else {
                path.addLine(to: p)
                return
            }
            let phi = degrees * .pi / 180
            let cosP = cos(phi), sinP = sin(phi)
            let dx = (p0.x - p.x) / 2, dy = (p0.y - p.y) / 2
            let x1 = cosP * dx + sinP * dy
            let y1 = -sinP * dx + cosP * dy
            let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
            if lambda > 1 {
                rx *= lambda.squareRoot()
                ry *= lambda.squareRoot()
            }
            let num = max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1)
            let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
            var coef = den == 0 ? 0 : (num / den).squareRoot()
            if large == sweep { coef = -coef }
            let cxp = coef * rx * y1 / ry
            let cyp = -coef * ry * x1 / rx
            let cx = cosP * cxp - sinP * cyp + (p0.x + p.x) / 2
            let cy = sinP * cxp + cosP * cyp + (p0.y + p.y) / 2

            func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
                atan2(ux * vy - uy * vx, ux * vx + uy * vy)
            }
            let ux = (x1 - cxp) / rx, uy = (y1 - cyp) / ry
            let vx = (-x1 - cxp) / rx, vy = (-y1 - cyp) / ry
            let theta = angle(1, 0, ux, uy)
            var delta = angle(ux, uy, vx, vy)
            if !sweep && delta > 0 { delta -= 2 * .pi }
            if sweep && delta < 0 { delta += 2 * .pi }

            func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: cx + rx * x * cosP - ry * y * sinP, y: cy + rx * x * sinP + ry * y * cosP)
            }
            let segments = max(1, Int((abs(delta) / (.pi / 2)).rounded(.up)))
            let step = delta / CGFloat(segments)
            let k = 4 / 3 * tan(step / 4)
            for n in 0..<segments {
                let a1 = theta + CGFloat(n) * step, a2 = a1 + step
                let c1 = cos(a1), s1 = sin(a1), c2 = cos(a2), s2 = sin(a2)
                let end = n == segments - 1 ? p : map(c2, s2)
                path.addCurve(to: end, control1: map(c1 - k * s1, s1 + k * c1), control2: map(c2 + k * s2, s2 - k * c2))
            }
        }
    }
}
