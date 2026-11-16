import AVFoundation
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

private let sampleRate = 16_000.0

private final class AudioOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sample.isValid, sample.dataReadiness == .ready,
              var description = sample.formatDescription?.audioStreamBasicDescription,
              let format = AVAudioFormat(streamDescription: &description),
              format.sampleRate == sampleRate, format.channelCount == 1,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sample.numSamples))
        else { return }
        buffer.frameLength = AVAudioFrameCount(sample.numSamples)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sample, at: 0, frameCount: Int32(buffer.frameLength), into: buffer.mutableAudioBufferList
        ) == noErr else { return }
        let count = Int(buffer.frameLength)
        if let audio = buffer.floatChannelData?[0] {
            let pcm = (0..<count).map { index -> Int16 in
                let value = audio[index]
                let clipped = value.isFinite ? max(-1, min(value, 1)) : 0
                return Int16(clipped * Float(Int16.max)).littleEndian
            }
            pcm.withUnsafeBytes { FileHandle.standardOutput.write(Data($0)) }
        } else if let audio = buffer.int16ChannelData?[0] {
            FileHandle.standardOutput.write(Data(bytes: audio, count: count * MemoryLayout<Int16>.size))
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("stopped\n".utf8))
        exit(EXIT_FAILURE)
    }
}

@main
private enum AnotchSystemAudio {
    static func main() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
                FileHandle.standardError.write(Data("display\n".utf8))
                exit(EXIT_FAILURE)
            }
            let config = SCStreamConfiguration()
            config.width = 64
            config.height = 64
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = Int(sampleRate)
            config.channelCount = 1
            let output = AudioOutput()
            let stream = SCStream(
                filter: SCContentFilter(display: display, excludingWindows: []),
                configuration: config, delegate: output
            )
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: DispatchQueue(label: "anotch.audio"))
            try await stream.startCapture()
            FileHandle.standardError.write(Data("ready\n".utf8))
            // The parent closes stdin (also on unexpected exit) to end the stream.
            _ = FileHandle.standardInput.readDataToEndOfFile()
            try? await stream.stopCapture()
            withExtendedLifetime(output) {}
        } catch {
            FileHandle.standardError.write(Data("unavailable\n".utf8))
            exit(EXIT_FAILURE)
        }
    }
}
