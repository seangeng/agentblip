// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AgentblipMenuBar",
    platforms: [.macOS(.v13)], // MenuBarExtra requires macOS 13 (Ventura)
    targets: [
        .executableTarget(
            name: "AgentblipMenuBar",
            path: "Sources/AgentblipMenuBar"
        )
    ]
)
