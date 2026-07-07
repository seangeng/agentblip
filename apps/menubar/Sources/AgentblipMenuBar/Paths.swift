import Foundation

/// Resolves the same config/state locations as the CLI (packages/cli/src/lib/paths.ts),
/// honoring XDG_CONFIG_HOME / XDG_STATE_HOME so a customized daemon is still found.
enum Paths {
    private static var home: String {
        FileManager.default.homeDirectoryForCurrentUser.path
    }

    private static func envDir(_ key: String, default fallback: [String]) -> String {
        if let v = ProcessInfo.processInfo.environment[key], !v.isEmpty { return v }
        return ([home] + fallback).joined(separator: "/")
    }

    static var configDir: String {
        envDir("XDG_CONFIG_HOME", default: [".config"]) + "/agentblip"
    }

    static var stateDir: String {
        envDir("XDG_STATE_HOME", default: [".local", "state"]) + "/agentblip"
    }

    static var configPath: String { configDir + "/config.json" }
    static var daemonSecretPath: String { stateDir + "/daemon.secret" }
}
