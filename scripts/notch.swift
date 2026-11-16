import AppKit
import Foundation

@MainActor
private final class NotchLayoutReporter: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        reportDisplay()
        Task.detached {
            while readLine() != nil {}
            await MainActor.run { NSApp.terminate(nil) }
        }
    }

    func applicationDidChangeScreenParameters(_ notification: Notification) { reportDisplay() }

    private func reportDisplay() {
        guard let screen = NSScreen.screens.first(where: {
            $0.safeAreaInsets.top > 0 && $0.auxiliaryTopLeftArea != nil && $0.auxiliaryTopRightArea != nil
        }), let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea,
              let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32 else {
            write(#"{"displayID":null}"#)
            return
        }
        let width = right.minX - left.maxX
        let center = (left.maxX + right.minX) / 2 - screen.frame.minX
        write("{\"displayID\":\(id),\"top\":\(screen.safeAreaInsets.top),\"center\":\(center),\"cameraWidth\":\(width)}")
    }

    private func write(_ line: String) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

@main
private enum AnotchNotchApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let reporter = NotchLayoutReporter()
        app.setActivationPolicy(.prohibited)
        app.delegate = reporter
        app.run()
    }
}
