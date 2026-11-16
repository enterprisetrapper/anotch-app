import Darwin
import Foundation
import Vision

do {
    let image = FileHandle.standardInput.readDataToEndOfFile()
    let request = VNRecognizeTextRequest()
    // Revision 3 in fast mode avoids waiting for a language model on first use.
    request.recognitionLevel = .fast
    request.revision = VNRecognizeTextRequestRevision3
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(data: image).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
    print(String(text.prefix(8_000)))
} catch {
    FileHandle.standardError.write(Data("Could not read text in the captured image.\n".utf8))
    exit(EXIT_FAILURE)
}
