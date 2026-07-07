import SwiftUI

@main
struct AgentblipMenuBarApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            // @StateObject drives re-evaluation, so the icon tracks state live.
            Image(nsImage: StatusIcon.image(for: model.blip))
        }
        .menuBarExtraStyle(.window)
    }
}
