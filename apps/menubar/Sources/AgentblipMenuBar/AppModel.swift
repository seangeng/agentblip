import Foundation
import SwiftUI

/// Owns the poll loop and exposes the current daemon view to SwiftUI.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var state: DaemonState?
    @Published private(set) var config: DaemonConfig?
    @Published private(set) var reachable = false

    private let client = DaemonClient()
    private var timer: Timer?
    private let pollInterval: TimeInterval = 2

    var blip: BlipState { BlipState.from(state: reachable ? state : nil) }

    init() {
        start() // begin polling at launch so the icon is live before first click
    }

    func start() {
        Task { await self.refresh() }
        let t = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func refresh() async {
        do {
            let s = try await client.fetchState()
            let c = try? await client.fetchConfig()
            state = s
            if let c { config = c }
            reachable = true
        } catch {
            reachable = false
        }
    }

    // Optimistic control actions — reflect immediately, then reconcile on the
    // next poll so a failed call self-corrects.
    func setPaused(_ paused: Bool) {
        Task {
            do {
                _ = paused ? try await client.pause() : try await client.resume()
            } catch {}
            await refresh()
        }
    }

    func setGranularity(_ value: String) { patch(["granularity": value]) }
    func setPolicy(_ value: String) { patch(["statusPolicy": value]) }
    func setShowProject(_ value: Bool) { patch(["showProject": value]) }
    func setRepoPrefix(_ value: Bool) { patch(["repoPrefix": value]) }

    private func patch(_ p: [String: Any]) {
        Task {
            if let c = try? await client.patchConfig(p) { config = c }
            await refresh()
        }
    }

    func openConfigFile() {
        NSWorkspace.shared.open(URL(fileURLWithPath: Paths.configPath))
    }

    func quit() { NSApplication.shared.terminate(nil) }
}
