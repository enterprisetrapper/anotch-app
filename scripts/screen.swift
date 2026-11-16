import AppKit
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

private struct CaptureSource: Encodable {
    let id: String
    let name: String
    let kind: String
    let primary: Bool
}

private enum CaptureError: String, Error {
    case permission, stale, unavailable, sourceHidden, displayAsleep, displayLocked, watchLocked, encoding
}

@main
private enum AnotchScreen {
    static func write(_ data: Data) throws {
        try FileHandle.standardOutput.write(contentsOf: data)
    }

    @MainActor static func main() async {
        do {
            _ = NSApplication.shared
            let args = Array(CommandLine.arguments.dropFirst())
            if args.first == "permission" {
                let allowed = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
                try write(JSONEncoder().encode(allowed))
                return
            }
            guard args.count >= 2, let owner = pid_t(args[1]) else { throw CaptureError.unavailable }
            let watching = args[0] == "watch"
            let locked = (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool == true
            if watching && locked { throw CaptureError.watchLocked }
            let watchingWindow = watching && args.count >= 3 && args[2] == "window"
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: !watchingWindow)
            let windows = content.windows.filter {
                $0.windowLayer == 0 && $0.owningApplication != nil && $0.owningApplication?.processID != owner
            }
            let visible = windows.filter { $0.isOnScreen && $0.frame.width >= 80 && $0.frame.height >= 55 }
            if args[0] == "list" {
                let displays = content.displays.enumerated().map { index, display in
                    let primary = display.displayID == CGMainDisplayID()
                    return CaptureSource(id: "screen:\(display.displayID):0", name: primary ? "Main display" : "Display \(index + 1)", kind: "screen", primary: primary)
                }.sorted { $0.primary && !$1.primary }
                let entries = visible.prefix(120).map { window in
                    let name = window.owningApplication?.applicationName ?? "Window"
                    let title = (window.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let label = title.isEmpty || title == name ? name : name + " — " + title
                    let process = window.owningApplication?.processID ?? 0
                    return CaptureSource(id: "window:\(window.windowID):\(process)", name: String(label.prefix(130)), kind: "window", primary: false)
                }
                try write(JSONEncoder().encode(displays + entries))
                return
            }
            guard (args[0] == "capture" || watching), args.count >= 4, let id = UInt32(args[3]) else { throw CaptureError.unavailable }
            let sourceOwner = args.count >= 5 ? pid_t(args[4]) : nil
            if watchingWindow && (sourceOwner ?? 0) <= 0 { throw CaptureError.stale }
            let filter: SCContentFilter
            let windowCapture = args[2] == "window"
            if windowCapture {
                guard let window = windows.first(where: {
                    $0.windowID == id && (sourceOwner == nil || sourceOwner == 0 || $0.owningApplication?.processID == sourceOwner)
                }) else { throw CaptureError.stale }
                if !visible.contains(where: { $0.windowID == id }) { throw watching ? CaptureError.sourceHidden : CaptureError.stale }
                filter = SCContentFilter(desktopIndependentWindow: window)
            } else {
                if locked { throw CaptureError.displayLocked }
                guard !content.displays.isEmpty else { throw CaptureError.displayAsleep }
                guard let display = content.displays.first(where: { $0.displayID == id }) else { throw CaptureError.stale }
                let notchOwner = args.count >= 6 ? pid_t(args[5]) : nil
                let owners = Set([owner, notchOwner].compactMap { $0 })
                let ownWindows = content.windows.filter { window in
                    window.owningApplication.map { owners.contains($0.processID) } ?? false
                }
                filter = SCContentFilter(display: display, excludingWindows: ownWindows)
                if watching { filter.includeMenuBar = false }
            }
            let config = SCStreamConfiguration()
            let base = filter.contentRect.size
            guard base.width > 0, base.height > 0 else { throw CaptureError.stale }
            let native = CGFloat(filter.pointPixelScale)
            let scale = min(native > 0 ? native : 1, 2304 / max(base.width, base.height))
            config.width = max(1, Int((base.width * scale).rounded()))
            config.height = max(1, Int((base.height * scale).rounded()))
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            config.ignoreGlobalClipSingleWindow = windowCapture && !watching
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            for quality in [0.87, 0.62] {
                let output = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
                    throw CaptureError.encoding
                }
                CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
                if CGImageDestinationFinalize(destination), output.length < 2_900_000 {
                    try write(output as Data)
                    return
                }
            }
            throw CaptureError.encoding
        } catch {
            let failure = error as NSError
            let dormant = failure.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" && failure.code == -3811
            let cause = !CGPreflightScreenCaptureAccess() ? CaptureError.permission
                : (error as? CaptureError ?? (dormant ? .displayAsleep : .unavailable))
            FileHandle.standardError.write(Data(cause.rawValue.utf8))
            exit(EXIT_FAILURE)
        }
    }
}
