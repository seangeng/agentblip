import Foundation

enum DaemonError: Error {
    case noSecret
    case notRunning
    case http(Int)
    case badResponse
}

/// Thin HTTP client for the daemon's loopback API. All state lives in the
/// daemon; this only reads it and issues control calls.
struct DaemonClient {
    /// The daemon secret is read fresh each call so a daemon restart (new
    /// secret) is picked up without restarting the app.
    private func secret() throws -> String {
        guard let data = FileManager.default.contents(atPath: Paths.daemonSecretPath),
              let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty
        else { throw DaemonError.noSecret }
        return s
    }

    /// Port comes from config.json (default 4519) so a custom `port` still works.
    private var port: Int {
        guard let data = FileManager.default.contents(atPath: Paths.configPath),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let p = obj["port"] as? Int
        else { return 4519 }
        return p
    }

    private func request(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        let token = try secret()
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 3
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw DaemonError.notRunning // connection refused → daemon down
        }
        guard let http = resp as? HTTPURLResponse else { throw DaemonError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw DaemonError.http(http.statusCode) }
        return data
    }

    func fetchState() async throws -> DaemonState {
        let data = try await request("GET", "/state")
        return try JSONDecoder().decode(DaemonState.self, from: data)
    }

    func fetchConfig() async throws -> DaemonConfig {
        let data = try await request("GET", "/config")
        return try JSONDecoder().decode(DaemonConfig.self, from: data)
    }

    @discardableResult
    func pause() async throws -> Data { try await request("POST", "/pause") }

    @discardableResult
    func resume() async throws -> Data { try await request("POST", "/resume") }

    @discardableResult
    func patchConfig(_ patch: [String: Any]) async throws -> DaemonConfig {
        let body = try JSONSerialization.data(withJSONObject: patch)
        let data = try await request("POST", "/config", body: body)
        return try JSONDecoder().decode(DaemonConfig.self, from: data)
    }
}
