import Darwin
import Foundation
import FoundationModels
import ImageIO

private struct Status: Encodable {
    let available: Bool
    let vision: Bool
    let reason: String

    init(available: Bool = false, vision: Bool = false, reason: String = "") {
        self.available = available
        self.vision = vision
        self.reason = reason
    }
}

private struct Query: Decodable {
    let instructions: String
    let prompt: String
    let images: [Data]
    let maximumResponseTokens: Int?
}

@main
private enum AnotchAnswer {
    static func write<T: Encodable>(_ value: T) throws {
        var line = try JSONEncoder().encode(value)
        line.append(10)
        try FileHandle.standardOutput.write(contentsOf: line)
    }

    @available(macOS 26.0, *)
    static func availability(_ model: SystemLanguageModel) -> Status {
        switch model.availability {
        case .available:
            if #available(macOS 27.0, *) {
                return Status(available: true, vision: model.capabilities.contains(.vision))
            }
            return Status(available: true)
        case .unavailable(.appleIntelligenceNotEnabled):
            return Status(reason: "Turn on Apple Intelligence in System Settings to get answers on this Mac.")
        case .unavailable(.modelNotReady):
            return Status(reason: "Apple Intelligence is still preparing its on-device model. Try again once it is ready.")
        default:
            return Status(reason: "Apple Intelligence is unavailable on this device. You can connect a provider in Settings.")
        }
    }

    static func main() async {
        do {
            guard #available(macOS 26.0, *) else {
                try write(Status(reason: "Apple Intelligence answers require macOS 26 or later. You can connect a provider in Settings."))
                return
            }
            let model = SystemLanguageModel.default
            let status = availability(model)
            if CommandLine.arguments.dropFirst().first == "--status" {
                try write(status)
                return
            }
            guard status.available else {
                try write(["error": status.reason]); return
            }

            let input = FileHandle.standardInput.readDataToEndOfFile()
            let query = try JSONDecoder().decode(Query.self, from: input)
            let session = LanguageModelSession(model: model, instructions: query.instructions)
            let prompt: Prompt
            if #available(macOS 27.0, *), status.vision, !query.images.isEmpty {
                let options = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: 1280,
                    kCGImageSourceCreateThumbnailWithTransform: true
                ] as CFDictionary
                let images = query.images.prefix(2).compactMap { data -> Attachment<ImageAttachmentContent>? in
                    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
                    return Attachment<ImageAttachmentContent>(image)
                }
                guard !images.isEmpty else { try write(["error": "Anotch could not read the attached image. Capture it again."]); return }
                prompt = Prompt {
                    query.prompt
                    for image in images { image }
                }
            } else {
                prompt = Prompt(query.prompt)
            }
            var final = ""
            let options = GenerationOptions(temperature: 0.2, maximumResponseTokens: min(1000, max(1, query.maximumResponseTokens ?? 700)))
            for try await snapshot in session.streamResponse(to: prompt, options: options) {
                if snapshot.content != final {
                    final = snapshot.content
                    try write(["snapshot": final])
                }
            }
            try write(["answer": final])
        } catch {
            try? write(["error": "Apple Intelligence couldn’t answer this request. Try a smaller window or a simpler question."])
        }
    }
}
