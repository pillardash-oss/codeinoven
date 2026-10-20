import AVFoundation
import Foundation

private struct Request: Decodable {
    let id: String
    let operation: String
    let outputPath: String?
}

private struct Response: Encodable {
    let id: String
    let ok: Bool
    let error: String?
    /// CoreAudio's own domain and status, so the host can tell a permission
    /// denial from a device negotiation failure instead of parsing a string.
    let errorDomain: String?
    let errorCode: Int?
}

/// Diagnostics for the host.
///
/// The host used to discard this worker's stderr, so a CoreAudio failure
/// surfaced as a bare "error 2003329396" with no record of which device or
/// which call failed. Every failure now says what it was.
private func log(_ message: String) {
    FileHandle.standardError.write(Data(("[speech-capture] \(message)\n").utf8))
}

/// The error as a message plus the domain and status CoreAudio reported.
private func describe(_ error: Error) -> String {
    let nsError = error as NSError
    return "\(nsError.localizedDescription) [\(nsError.domain) \(nsError.code)]"
}

private final class CaptureSession {
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    )!
    private let writeQueue = DispatchQueue(label: "com.pillardash.codeinoven.speech-capture")
    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var file: AVAudioFile?
    private var generation = 0
    private var configurationObserver: NSObjectProtocol?

    var isRecording: Bool { engine != nil }

    func start(outputPath: String) throws {
        stop()
        // One retry with a rebuilt engine and tap. A device switch between the
        // warmup and the start, or a HAL object invalidated under us, fails the
        // first `start` with CoreAudio's unspecified error ('what'); rebuilding
        // binds to the current default device and recovers the common case
        // instead of degrading the whole recording to the browser path.
        var lastError: Error?
        for attempt in 0..<2 {
            do {
                try begin(outputPath: outputPath)
                return
            } catch {
                lastError = error
                log("start attempt \(attempt + 1) failed: \(describe(error))")
                tearDown()
                // Only a CoreAudio/HAL failure is worth rebuilding for. A bad
                // output path or an unusable format fails the same way twice.
                if (error as NSError).domain != "com.apple.coreaudio.avfaudio" { break }
            }
        }
        throw lastError
            ?? NSError(
                domain: "SpeechCaptureWorker",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "The microphone could not be started."]
            )
    }

    /// One attempt: a fresh engine, tap, converter and output file.
    private func begin(outputPath: String) throws {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        // The tap is installed with the node's OUTPUT format. `inputFormat` is
        // the hardware format, which CoreAudio rejects at tap time once the
        // default device has moved, and that rejection is the 'what' failure.
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
            throw NSError(
                domain: "SpeechCaptureWorker",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "The selected microphone has no usable input format."]
            )
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw NSError(
                domain: "SpeechCaptureWorker",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Unable to create the microphone format converter."]
            )
        }
        if inputFormat.channelCount > 1 {
            converter.channelMap = [NSNumber(value: 0)]
        }

        let file = try AVAudioFile(
            forWriting: URL(fileURLWithPath: outputPath),
            settings: [
                AVFormatIDKey: Int(kAudioFormatLinearPCM),
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: true
            ],
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )

        generation += 1
        let currentGeneration = generation
        self.converter = converter
        self.file = file
        self.engine = engine

        inputNode.installTap(onBus: 0, bufferSize: 2_048, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            guard let copy = self.clone(buffer) else { return }
            self.writeQueue.async { [weak self] in
                self?.write(copy, generation: currentGeneration)
            }
        }
        engine.prepare()
        try engine.start()
        // A device switch mid-recording stops the engine and its tap. The host
        // cannot rebuild the engine for a recording already in progress, but the
        // log says the device moved rather than leaving a short file unexplained.
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { _ in
            log("audio engine configuration changed mid-recording")
        }
        log("recording started at \(inputFormat.sampleRate) Hz, \(inputFormat.channelCount) ch")
    }

    func stop() {
        tearDown()
    }

    /// Release the engine, tap, converter and file, whatever state they are in.
    private func tearDown() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        self.engine = nil
        self.converter = nil
        writeQueue.sync {
            generation += 1
            self.file = nil
        }
    }

    /// One-shot CoreAudio/HAL warmup. Builds and prepares a throwaway engine so
    /// the first real start does not pay audio-unit initialization latency.
    /// The engine is intentionally discarded afterwards: every real start
    /// creates a fresh engine bound to the current default input device, so a
    /// warmup can never pin a stale microphone.
    func warm() {
        let engine = AVAudioEngine()
        let inputFormat = engine.inputNode.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else { return }
        _ = AVAudioConverter(from: inputFormat, to: targetFormat)
        engine.prepare()
    }

    private func write(_ input: AVAudioPCMBuffer, generation: Int) {
        guard generation == self.generation, let converter, let file else { return }
        let ratio = targetFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(max(1, (Double(input.frameLength) * ratio).rounded(.up) + 32))
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var consumed = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return input
        }
        guard conversionError == nil, status != .error, output.frameLength > 0 else { return }
        try? file.write(from: output)
    }

    private func clone(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: input.format, frameCapacity: input.frameLength) else {
            return nil
        }
        copy.frameLength = input.frameLength
        let source = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
        let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        guard source.count == destination.count else { return nil }
        for index in 0..<source.count {
            let sourceBuffer = source[index]
            let destinationBuffer = destination[index]
            guard let sourceData = sourceBuffer.mData, let destinationData = destinationBuffer.mData else {
                return nil
            }
            destinationData.copyMemory(from: sourceData, byteCount: Int(sourceBuffer.mDataByteSize))
        }
        return copy
    }
}

private let encoder = JSONEncoder()
private let decoder = JSONDecoder()
private let capture = CaptureSession()

private func emit(_ response: Response) {
    guard let data = try? encoder.encode(response) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private func handle(_ request: Request) -> Response {
    do {
        switch request.operation {
        case "start":
            guard let outputPath = request.outputPath, !outputPath.isEmpty else {
                throw NSError(domain: "SpeechCaptureWorker", code: 3, userInfo: [NSLocalizedDescriptionKey: "Missing recording output path."])
            }
            try capture.start(outputPath: outputPath)
        case "prepare":
            capture.warm()
        case "stop":
            capture.stop()
        default:
            throw NSError(domain: "SpeechCaptureWorker", code: 4, userInfo: [NSLocalizedDescriptionKey: "Unsupported capture operation."])
        }
        return Response(id: request.id, ok: true, error: nil, errorDomain: nil, errorCode: nil)
    } catch {
        let nsError = error as NSError
        log("operation \(request.operation) failed: \(describe(error))")
        return Response(
            id: request.id,
            ok: false,
            error: describe(error),
            errorDomain: nsError.domain,
            errorCode: nsError.code
        )
    }
}

@main
private enum SpeechCaptureWorker {
    static func main() {
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8), let request = try? decoder.decode(Request.self, from: data) else {
                continue
            }
            emit(handle(request))
        }
        capture.stop()
    }
}
