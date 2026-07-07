import AppKit

/// Renders the menu bar "blip": a colored dot whose color/shape encodes state,
/// with a small count for multiple working/waiting agents. Non-template so the
/// on-air color shows through (a template image would be flattened to mono).
enum StatusIcon {
    static func image(for blip: BlipState) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size)
        image.lockFocus()
        defer { image.unlockFocus() }

        let (color, filled, count): (NSColor, Bool, Int?) = {
            switch blip {
            case .unreachable: return (.tertiaryLabelColor, false, nil)
            case .paused: return (.secondaryLabelColor, false, nil)
            case .backedOff: return (.systemGray, false, nil)
            case .idle: return (.systemGray, false, nil)
            case .waiting(let n): return (.systemOrange, true, n > 1 ? n : nil)
            case .working(let n): return (.systemGreen, true, n > 1 ? n : nil)
            }
        }()

        let inset: CGFloat = 4
        let rect = NSRect(x: inset, y: inset, width: size.width - inset * 2, height: size.height - inset * 2)
        let path = NSBezierPath(ovalIn: rect)
        if filled {
            color.setFill()
            path.fill()
        } else {
            color.setStroke()
            path.lineWidth = 1.6
            path.stroke()
        }

        if let count {
            let text = "\(min(count, 9))"
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 9, weight: .bold),
                .foregroundColor: NSColor.white,
            ]
            let attributed = NSAttributedString(string: text, attributes: attrs)
            let textSize = attributed.size()
            let point = NSPoint(
                x: rect.midX - textSize.width / 2,
                y: rect.midY - textSize.height / 2
            )
            attributed.draw(at: point)
        }

        image.isTemplate = false
        return image
    }
}
