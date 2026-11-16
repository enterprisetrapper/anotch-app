import AppKit
import AVFoundation
import CoreMedia
import CoreText
import CoreVideo

private struct Update: Decodable, Sendable {
    let body: String
    let phase: String
    let displayID: UInt32?
    let watching: Bool?
    let watchPhase: String?
}

private struct PanelLayout {
    let frame: NSRect
    let notchWidth: CGFloat?
    let bandHeight: CGFloat
    let scale: CGFloat
}

private final class StealthPanel: NSPanel {
    var docked = false

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        docked ? frameRect : super.constrainFrameRect(frameRect, to: screen)
    }
}

@MainActor
private final class AnswerPanel: NSObject, NSApplicationDelegate {
    private let video = AVSampleBufferDisplayLayer()
    private var window: StealthPanel?
    private var layout: PanelLayout?
    private var update = Update(body: "", phase: "idle", displayID: nil, watching: nil, watchPhase: nil)
    private var scroll: CGFloat = 0
    private var scrollMonitor: Any?
    private var observer: NSObjectProtocol?
    private let dockAtNotch = CommandLine.arguments.contains("--notch")
    private lazy var logo: CGImage? = {
        let url = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
            .deletingLastPathComponent().appendingPathComponent("anotch-logo.png")
        return NSImage(contentsOf: url)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
    }()

    private func screen(for displayID: UInt32?) -> NSScreen? {
        if let displayID, let requested = NSScreen.screens.first(where: {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
        }) { return requested }
        return window?.screen ?? NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) })
            ?? NSScreen.main ?? NSScreen.screens.first
    }

    private func placement(on screen: NSScreen) -> PanelLayout {
        if dockAtNotch, screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea,
           let right = screen.auxiliaryTopRightArea {
            let screenFrame = screen.frame
            let width = min(414, screenFrame.width)
            let height = min(312, screenFrame.height)
            let center = (left.maxX + right.minX) / 2
            let x = min(max(center - width / 2, screenFrame.minX), screenFrame.maxX - width)
            let band = min(width - 16, max(328, right.minX - left.maxX + 128))
            return PanelLayout(
                frame: NSRect(x: x, y: screenFrame.maxY - height, width: width, height: height),
                notchWidth: band, bandHeight: max(34, screen.safeAreaInsets.top), scale: screen.backingScaleFactor
            )
        }
        let work = screen.visibleFrame
        let width = min(414, max(1, work.width - 22))
        let height = min(312, max(1, work.height - 20))
        let x = max(work.minX, work.maxX - width - 22)
        let y = max(work.minY, work.maxY - height - 20)
        return PanelLayout(frame: NSRect(x: x, y: y, width: width, height: height),
                           notchWidth: nil, bandHeight: 40, scale: screen.backingScaleFactor)
    }

    private func place(_ panel: StealthPanel, on screen: NSScreen) {
        let next = placement(on: screen)
        layout = next
        panel.docked = next.notchWidth != nil
        panel.level = panel.docked ? .statusBar : NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
        if panel.frame != next.frame {
            panel.setFrame(next.frame, display: true)
            if let view = panel.contentView { video.frame = view.bounds }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let display = screen(for: nil) else {
            fail()
            return
        }
        let rect = placement(on: display).frame
        let panel = StealthPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel],
                                 backing: .buffered, defer: false, screen: display)
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.isMovable = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]
        let view = NSView(frame: NSRect(origin: .zero, size: rect.size))
        view.wantsLayer = true
        view.layer?.isOpaque = false
        view.layer?.backgroundColor = NSColor.clear.cgColor
        video.frame = view.bounds
        video.isOpaque = false
        video.backgroundColor = NSColor.clear.cgColor
        video.videoGravity = .resize
        video.preventsCapture = true
        view.layer?.addSublayer(video)
        panel.contentView = view
        window = panel
        place(panel, on: display)

        observer = NotificationCenter.default.addObserver(
            forName: .AVSampleBufferDisplayLayerFailedToDecode, object: video, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.fail() } }
        scrollMonitor = NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let window = self.window, window.isVisible,
                      window.frame.contains(NSEvent.mouseLocation), event.scrollingDeltaY != 0 else { return }
                let movement = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * 22
                self.scroll = max(0, self.scroll - movement)
                if !self.present() { self.fail() }
            }
        }

        Task.detached { [weak self] in
            for line in AnyIterator<String>({ readLine() }) {
                guard let update = try? JSONDecoder().decode(Update.self, from: Data(line.utf8)) else { continue }
                await self?.apply(update)
            }
            await MainActor.run { NSApp.terminate(nil) }
        }
    }

    private func apply(_ next: Update) {
        if let window, let target = screen(for: next.displayID) { place(window, on: target) }
        if next.body != update.body && (next.phase != "working" || update.phase != "working") { scroll = 0 }
        update = next
        if !present() { fail(); return }
        if window?.isVisible == false {
            // Show a window only after its sole content layer is configured and enqueued.
            window?.orderFrontRegardless()
            confirmPresentation()
        }
    }

    func applicationDidChangeScreenParameters(_ notification: Notification) {
        guard let window, let display = screen(for: update.displayID) else { fail(); return }
        place(window, on: display)
        if window.isVisible && !present() { fail() }
    }

    private func confirmPresentation(attempt: Int = 0) {
        if video.isReadyForDisplay {
            FileHandle.standardOutput.write(Data("ready\n".utf8))
        } else if attempt < 40 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.confirmPresentation(attempt: attempt + 1)
            }
        } else { fail() }
    }

    private func fail() {
        window?.orderOut(nil)
        NSApp.terminate(nil)
    }

    private func ink(_ rgb: UInt32, _ alpha: CGFloat = 1) -> CGColor {
        NSColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255,
                blue: CGFloat(rgb & 255) / 255, alpha: alpha).cgColor
    }

    private func styled(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular,
                        color: UInt32, tracking: CGFloat = 0) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): NSFont.systemFont(ofSize: size, weight: weight),
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): ink(color),
            NSAttributedString.Key(kCTKernAttributeName as String): tracking
        ])
    }

    private func paint(_ line: CTLine, x: CGFloat, baseline: CGFloat, context: CGContext) {
        context.textPosition = CGPoint(x: x, y: baseline)
        CTLineDraw(line, context)
    }

    private func wrap(_ text: NSAttributedString, width: CGFloat) -> [CTLine] {
        let typesetter = CTTypesetterCreateWithAttributedString(text)
        var lines: [CTLine] = []
        var index = 0
        while index < text.length {
            let count = max(1, CTTypesetterSuggestLineBreak(typesetter, index, Double(width)))
            lines.append(CTTypesetterCreateLine(typesetter, CFRange(location: index, length: count)))
            index += count
        }
        return lines
    }

    private func bottomCorners(_ rect: CGRect, radius: CGFloat) -> CGMutablePath {
        let path = CGMutablePath()
        path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + radius))
        path.addQuadCurve(to: CGPoint(x: rect.minX + radius, y: rect.minY),
                          control: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - radius, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + radius),
                          control: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        return path
    }

    private func paintChrome(_ layout: PanelLayout, size: CGSize, in context: CGContext) {
        let frame = CGRect(x: 0.5, y: 0.5, width: size.width - 1, height: size.height - 1)
        let radius = min(22, frame.width / 2, frame.height / 2)
        let docked = layout.notchWidth != nil
        let shell: CGPath = docked
            ? bottomCorners(CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: size.height - frame.minY),
                            radius: radius)
            : CGPath(roundedRect: frame, cornerWidth: radius, cornerHeight: radius, transform: nil)
        context.addPath(shell)
        context.setFillColor(ink(0x14161A, 0.86))
        context.fillPath()
        context.addPath(shell)
        context.setStrokeColor(ink(0xFFFFFF, 0.16))
        context.setLineWidth(1)
        context.strokePath()

        let bandWidth = layout.notchWidth ?? size.width
        let left = (size.width - bandWidth) / 2
        let right = left + bandWidth
        let top = size.height
        let middle = top - layout.bandHeight / 2
        if docked {
            let band = bottomCorners(CGRect(x: left, y: top - layout.bandHeight,
                                             width: bandWidth, height: layout.bandHeight - 8), radius: 14)
            band.addQuadCurve(to: CGPoint(x: right + 8, y: top), control: CGPoint(x: right, y: top))
            band.addLine(to: CGPoint(x: left - 8, y: top))
            band.addQuadCurve(to: CGPoint(x: left, y: top - 8), control: CGPoint(x: left, y: top))
            band.closeSubpath()
            context.addPath(band)
            context.setFillColor(ink(0x000000))
            context.fillPath()
        }
        let padding: CGFloat = docked ? 13 : 18
        if let logo {
            let badge = CGRect(x: left + padding, y: middle - 9, width: 18, height: 18)
            context.saveGState()
            context.addPath(CGPath(roundedRect: badge, cornerWidth: 5, cornerHeight: 5, transform: nil))
            context.clip()
            context.draw(logo, in: badge)
            context.restoreGState()
        } else {
            let brand = CTLineCreateWithAttributedString(styled("A", size: 12, weight: .semibold, color: 0xA0EFC7))
            paint(brand, x: left + padding + 4, baseline: middle - 4, context: context)
        }
        let status = CTLineCreateWithAttributedString(styled("Stealth", size: 11, weight: .semibold, color: 0xA0EFC7))
        let dot = CGRect(x: right - padding - 6, y: middle - 3, width: 6, height: 6)
        context.setFillColor(ink(0xA0EFC7))
        context.fillEllipse(in: dot)
        paint(status, x: dot.minX - 5 - CTLineGetTypographicBounds(status, nil, nil, nil),
              baseline: middle - 4, context: context)
    }

    private func paintFooter(width: CGFloat, in context: CGContext) {
        func shortcut(_ keys: String, _ title: String) -> CTLine {
            let label = NSMutableAttributedString(attributedString: styled(keys, size: 11, weight: .medium,
                                                                          color: 0xF2F2F4, tracking: 0.65))
            label.append(styled(" " + title, size: 11, color: 0xC9CBD1))
            return CTLineCreateWithAttributedString(label)
        }
        context.move(to: CGPoint(x: 18, y: 37.5))
        context.addLine(to: CGPoint(x: width - 18, y: 37.5))
        context.setStrokeColor(ink(0xFFFFFF, 0.13))
        context.setLineWidth(1)
        context.strokePath()
        let exit = shortcut("⌃⇧K", "Exit")
        let hide = shortcut("⌃⇧G", "Hide")
        let exitX = width - 18 - CTLineGetTypographicBounds(exit, nil, nil, nil)
        let hideX = exitX - 10 - CTLineGetTypographicBounds(hide, nil, nil, nil)
        paint(shortcut("⌃⇧J", "Analyze"), x: 18, baseline: 16, context: context)
        paint(hide, x: hideX, baseline: 16, context: context)
        paint(exit, x: exitX, baseline: 16, context: context)
    }

    private func answerParts(_ text: String) -> (lead: String, detail: String) {
        let paragraphEnd = text.range(of: #"\n[ \t]*\n"#, options: .regularExpression)?.lowerBound ?? text.endIndex
        let paragraph = text[..<paragraphEnd]
        var split = paragraphEnd
        if paragraph.count > 104 {
            let head = paragraph.prefix(104)
            split = head.lastIndex(where: \.isWhitespace) ?? head.endIndex
            if let sentence = head.indices.last(where: { index in
                ".!?".contains(head[index]) && head.distance(from: head.startIndex, to: index) >= 40 &&
                    text[text.index(after: index)].isWhitespace
            }) { split = text.index(after: sentence) }
        }
        return (text[..<split].trimmingCharacters(in: .whitespacesAndNewlines),
                text[split...].trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func paintContent(_ layout: PanelLayout, size: CGSize, in context: CGContext) {
        let message = update.body.trimmingCharacters(in: .whitespacesAndNewlines)
        var area = CGRect(x: 18, y: 48, width: size.width - 36, height: size.height - layout.bandHeight - 55)
        if update.phase == "working" && (message.isEmpty || message == "Trying a backup model…") {
            scroll = 0
            let label = message.isEmpty ? "Reading the display…" : message
            let activity = CTLineCreateWithAttributedString(styled(label, size: 11, weight: .medium, color: 0xA0EFC7))
            paint(activity, x: area.minX, baseline: area.midY + 29, context: context)
            context.setFillColor(ink(0xFFFFFF, 0.14))
            for (index, fraction) in [0.9, 0.6].enumerated() {
                let bar = CGRect(x: area.minX, y: area.midY - CGFloat(index) * 30 - 3,
                                 width: area.width * fraction, height: 22)
                context.addPath(CGPath(roundedRect: bar, cornerWidth: 6, cornerHeight: 6, transform: nil))
                context.fillPath()
            }
            return
        }
        if update.watching == true || update.phase == "working" {
            let status = update.phase == "working" || update.watchPhase == "answering" ? "Answering…"
                : update.watchPhase == "waiting" ? "Waiting for source" : "Watching screen"
            let badge = CTLineCreateWithAttributedString(styled(status, size: 11, weight: .medium, color: 0xA0EFC7))
            paint(badge, x: area.minX, baseline: area.maxY - 10, context: context)
            area.size.height -= 22
        }
        let idle = update.watching == true ? "Watching for the next visible question…" : "Press ⌃⇧J to analyze the display."
        let hasAnswer = !message.isEmpty && update.phase != "error"
        let parts = answerParts(message.isEmpty ? idle : String(message.prefix(8_000)))
        let leadSize: CGFloat = hasAnswer ? 22 : 20
        let leadColor: UInt32 = update.phase == "error" ? 0xFFD4D4 : 0xF2F2F4
        let lead = wrap(styled(parts.lead, size: leadSize, weight: .semibold, color: leadColor, tracking: -0.4),
                        width: area.width)
        let details = wrap(styled(parts.detail, size: 13, color: 0xC9CBD1), width: area.width)
        let headlineStep = leadSize * 1.22
        let detailStep: CGFloat = 19.5
        let gap: CGFloat = details.isEmpty ? 0 : 8
        let leadHeight = CGFloat(lead.count) * headlineStep
        let contentHeight = leadHeight + gap + CGFloat(details.count) * detailStep
        let overflow = max(0, contentHeight - area.height)
        scroll = min(scroll, overflow)
        let top = overflow > 0 ? area.maxY + scroll : area.midY + contentHeight / 2
        context.saveGState()
        context.clip(to: area)
        func draw(_ lines: [CTLine], from top: CGFloat, step: CGFloat) {
            for (index, line) in lines.enumerated() {
                let lineTop = top - CGFloat(index) * step
                if lineTop <= area.minY { break }
                if lineTop - step >= area.maxY { continue }
                var ascent: CGFloat = 0
                var descent: CGFloat = 0
                CTLineGetTypographicBounds(line, &ascent, &descent, nil)
                paint(line, x: area.minX, baseline: lineTop - (step + ascent - descent) / 2, context: context)
            }
        }
        draw(lead, from: top, step: headlineStep)
        draw(details, from: top - leadHeight - gap, step: detailStep)
        context.restoreGState()
        if overflow > 0 {
            let thumb = max(16, area.height * area.height / contentHeight)
            let y = area.maxY - thumb - scroll / overflow * (area.height - thumb)
            let indicator = CGRect(x: size.width - 9, y: y, width: 2, height: thumb)
            context.setFillColor(ink(0xFFFFFF, 0.30))
            context.addPath(CGPath(roundedRect: indicator, cornerWidth: 1, cornerHeight: 1, transform: nil))
            context.fillPath()
        }
    }

    @discardableResult private func present() -> Bool {
        guard let layout, layout.frame.width > 240, layout.frame.height > layout.bandHeight + 110 else { return false }
        let size = layout.frame.size
        var pixelBuffer: CVPixelBuffer?
        let pixelWidth = Int((size.width * layout.scale).rounded(.up))
        let pixelHeight = Int((size.height * layout.scale).rounded(.up))
        let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault, pixelWidth, pixelHeight,
                                  kCVPixelFormatType_32BGRA, attrs, &pixelBuffer) == kCVReturnSuccess,
              let pixelBuffer else { return false }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        guard let context = CGContext(data: CVPixelBufferGetBaseAddress(pixelBuffer), width: pixelWidth, height: pixelHeight,
                                      bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
            CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
            return false
        }
        context.clear(CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight))
        context.scaleBy(x: CGFloat(pixelWidth) / size.width, y: CGFloat(pixelHeight) / size.height)
        paintChrome(layout, size: size, in: context)
        paintContent(layout, size: size, in: context)
        paintFooter(width: size.width, in: context)
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

        var format: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer,
                                                           formatDescriptionOut: &format) == noErr,
              let format else { return false }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        var buffer: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer,
                                                      formatDescription: format, sampleTiming: &timing, sampleBufferOut: &buffer) == noErr,
              let buffer else { return false }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: true),
           let raw = CFArrayGetValueAtIndex(attachments, 0) {
            let properties = unsafeBitCast(raw, to: CFMutableDictionary.self)
            CFDictionarySetValue(properties,
                                 Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        video.sampleBufferRenderer.enqueue(buffer)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let scrollMonitor { NSEvent.removeMonitor(scrollMonitor) }
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
}

@main
private struct AnotchStealth {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AnswerPanel()
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        app.run()
    }
}
