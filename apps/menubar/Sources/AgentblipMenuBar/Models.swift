import Foundation

// Wire types mirroring the daemon's loopback JSON (packages/core + daemon/server.ts).
// Field names match the JSON exactly so no CodingKeys are needed.

struct SlackStatus: Decodable, Equatable {
    let text: String
    let emoji: String
    let expirationSec: Int
}

struct AgentSession: Decodable, Identifiable {
    let key: String
    let source: String
    let sessionId: String
    let state: String // "working" | "waiting" | "idle"
    let activity: String?
    let project: String?
    let startedAt: Double
    let updatedAt: Double

    var id: String { key }
}

struct Snapshot: Decodable {
    let sessions: [AgentSession]
    let working: Int
    let waiting: Int
    let idle: Int
    let total: Int
    let latestActivity: String?
}

struct Ownership: Decodable, Equatable {
    let backedOff: Bool
    let savedPrior: Bool
    let policy: String // "respect" | "overwrite"
}

struct DaemonState: Decodable {
    let snapshot: Snapshot
    let formatted: SlackStatus?
    let paused: Bool
    let ownership: Ownership
    let lastError: String?
}

struct DaemonConfig: Decodable {
    let mode: String
    let relayUrl: String
    let port: Int
    let granularity: String
    let statusPolicy: String
    let showProject: Bool
    let repoPrefix: Bool
    let statusTtlSec: Int
    let debounceMs: Int
}

/// One place that maps the daemon's world into what the menu bar renders.
enum BlipState: Equatable {
    case unreachable // no daemon / can't connect
    case paused
    case backedOff // standing down — a foreign status is up
    case idle // daemon up, nothing running
    case waiting(Int) // agents blocked on the human
    case working(Int) // agents actively working

    static func from(state: DaemonState?) -> BlipState {
        guard let s = state else { return .unreachable }
        if s.paused { return .paused }
        if s.ownership.backedOff { return .backedOff }
        if s.snapshot.working > 0 { return .working(s.snapshot.working) }
        if s.snapshot.waiting > 0 { return .waiting(s.snapshot.waiting) }
        return .idle
    }
}
