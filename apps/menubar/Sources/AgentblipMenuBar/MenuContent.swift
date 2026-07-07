import SwiftUI

/// Maps the handful of Slack shortcodes the formatter emits to real glyphs.
private func glyph(_ shortcode: String) -> String {
    switch shortcode {
    case ":robot_face:": return "🤖"
    case ":raised_hand:": return "✋"
    default: return ""
    }
}

struct MenuContent: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if !model.reachable {
                notRunning
            } else {
                if let s = model.state, s.ownership.backedOff {
                    banner("Standing down — your existing Slack status is untouched.",
                           systemImage: "pause.circle")
                }
                sessions
                Divider()
                controls
            }
            Divider()
            footer
        }
        .padding(12)
        .frame(width: 300)
    }

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: 8) {
            Image(nsImage: StatusIcon.image(for: model.blip))
            Text(headline).font(.system(size: 13, weight: .semibold))
            Spacer()
        }
    }

    private var headline: String {
        guard model.reachable, let s = model.state else { return "agentblip — daemon offline" }
        if s.paused { return "Paused" }
        if let f = s.formatted {
            let g = glyph(f.emoji)
            return g.isEmpty ? f.text : "\(g)  \(f.text)"
        }
        return "No agents running"
    }

    private var notRunning: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("The agentblip daemon isn't running.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text("Start it with  agentblip start --detach")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.tertiary)
                .textSelection(.enabled)
        }
    }

    private var sessions: some View {
        Group {
            if let s = model.state, !s.snapshot.sessions.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(s.snapshot.sessions) { session in
                        HStack(spacing: 8) {
                            Circle()
                                .fill(color(for: session.state))
                                .frame(width: 7, height: 7)
                            Text(session.source)
                                .font(.system(size: 12, weight: .medium))
                            Text(session.activity ?? session.state)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Spacer()
                            if let p = session.project {
                                Text(p)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(
                get: { !(model.state?.paused ?? false) },
                set: { model.setPaused(!$0) }
            )) {
                Text("Syncing to Slack").font(.system(size: 12))
            }
            .toggleStyle(.switch)

            if let c = model.config {
                Picker("Detail", selection: Binding(
                    get: { c.granularity },
                    set: { model.setGranularity($0) }
                )) {
                    Text("Off").tag("off")
                    Text("Presence").tag("presence")
                    Text("Count").tag("count")
                    Text("Activity").tag("activity")
                }
                .font(.system(size: 12))

                Picker("If a status is already set", selection: Binding(
                    get: { c.statusPolicy },
                    set: { model.setPolicy($0) }
                )) {
                    Text("Respect it").tag("respect")
                    Text("Overwrite").tag("overwrite")
                }
                .font(.system(size: 12))

                Toggle(isOn: Binding(
                    get: { c.repoPrefix },
                    set: { model.setRepoPrefix($0) }
                )) {
                    Text("Lead with repo name").font(.system(size: 12))
                }
                .toggleStyle(.switch)
                .help("Show “repo: activity” (e.g. b3iq: editing README.md) in activity mode")
            }
        }
    }

    private var footer: some View {
        HStack {
            Button("Config…") { model.openConfigFile() }
                .buttonStyle(.plain)
                .font(.system(size: 12))
            Spacer()
            Button("Quit") { model.quit() }
                .buttonStyle(.plain)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
    }

    private func banner(_ text: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: systemImage).foregroundStyle(.orange)
            Text(text).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
    }

    private func color(for state: String) -> Color {
        switch state {
        case "working": return .green
        case "waiting": return .orange
        default: return .gray
        }
    }
}
