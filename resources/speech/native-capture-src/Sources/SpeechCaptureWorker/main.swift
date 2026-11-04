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
    /// Audio frames this take actually wrote to its file. The host compares
    /// this with the elapsed recording time, so a take the microphone stopped
    /// feeding can never be handed on as a complete transcript again.
    let framesWritten: Int?
    /// How many times the engine had to be rebuilt mid-take, plus one when the
    /// final rebuild failed and the take lost its microphone for good.
    let engineRestarts: Int?
    /// Set when the take is known to be short: a lost microphone or a file that
    /// refused writes.
    let captureWarning: String?
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

/// One microphone recording.
///
/// The output file lives for the whole take while the engine, its converter and
/// its tap are disposable: a device switch, a tap that stops delivering buffers
/// or a file that starts failing all rebuild the capture *into the same file*
/// instead of ending the take. A take is only ever truncated if the microphone
/// cannot be brought back at all, and that is reported to the host.
///
/// Threading: engine lifecycle (start, stop, rebuild) runs on `controlQueue`;
/// audio buffers are converted and written on `writeQueue`. The handful of
/// values both queues touch are read and written under `state`.
private final class CaptureSession {
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    )!

    /// Serialises every lifecycle change. The worker's main thread blocks on
    /// stdin, so engine work can never run there.
    private let controlQueue = DispatchQueue(label: "com.pillardash.codeinoven.speech-capture.control")
    private let writeQueue = DispatchQueue(label: "com.pillardash.codeinoven.speech-capture.write")
    /// Guards the values the audio thread's writes read while the control queue
    /// replaces them, plus the write statistics the watchdog reads.
    private let state = NSLock()

    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var file: AVAudioFile?
    private var generation = 0
    private var configurationObserver: NSObjectProtocol?
    private var stallTimer: DispatchSourceTimer?
    private var recording = false
    private var framesWritten = 0
    private var lastFrameAt = Date()
    private var engineRestarts = 0
    private var writeFailures = 0
    private var lastWriteFailure: String?

    /// No buffer for this long while a take is live means the tap is dead: a
    /// device change CoreAudio never announced, a stalled HAL, or an engine
    /// that stopped its input unit. Well above the 2048-frame tap cadence
    /// (~43 ms), so ordinary scheduling delays cannot trip it.
    private let stallInterval: TimeInterval = 2.5

    func start(outputPath: String) throws {
        var failure: Error?
        controlQueue.sync {
            self.stopLocked()
            do {
                try self.beginLocked(outputPath: outputPath)
            } catch {
                self.stopLocked()
                failure = error
            }
        }
        if let failure { throw failure }
    }

    /// Ends the take and answers with what it actually captured.
    func stop() -> (frames: Int, restarts: Int, warning: String?) {
        var result: (frames: Int, restarts: Int, warning: String?) = (0, 0, nil)
        controlQueue.sync {
            self.stopLocked()
            self.state.lock()
            result = (self.framesWritten, self.engineRestarts, self.captureWarningLocked())
            self.state.unlock()
        }
        return result
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

    /// One attempt: open the take's file, then bind an engine and tap to it.
    private func beginLocked(outputPath: String) throws {
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
        state.lock()
        self.file = file
        self.framesWritten = 0
        self.engineRestarts = 0
        self.writeFailures = 0
        self.lastWriteFailure = nil
        self.lastFrameAt = Date()
        self.state.unlock()
        recording = true
        startStallWatchdogLocked()
        // Two attempts at the first engine too: a device switch between the
        // warmup and the start, or a HAL object invalidated under us, fails the
        // first `start` with CoreAudio's unspecified error ('what'). Rebuilding
        // binds to the current default device and recovers the common case
        // instead of degrading the whole recording to the browser path.
        var lastError: Error?
        for attempt in 0..<2 {
            do {
                try startEngineLocked()
                return
            } catch {
                lastError = error
                log("start attempt \(attempt + 1) failed: \(describe(error))")
                stopEngineLocked()
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

    /// Bind a fresh engine, converter and tap to the open output file.
    private func startEngineLocked() throws {
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

        state.lock()
        generation += 1
        let currentGeneration = generation
        self.converter = converter
        self.lastFrameAt = Date()
        state.unlock()

        inputNode.installTap(onBus: 0, bufferSize: 2_048, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            guard let copy = self.clone(buffer) else { return }
            self.writeQueue.async { [weak self] in
                self?.write(copy, generation: currentGeneration)
            }
        }
        engine.prepare()
        try engine.start()

        self.engine = engine
        // A device switch mid-recording stops the engine and its tap. CoreAudio
        // announces it, and the take now survives it: the engine is rebuilt and
        // keeps writing into the file this recording already owns.
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            log("audio engine configuration changed mid-recording")
            self.controlQueue.async {
                self.recoverLocked(reason: "the audio device configuration changed")
            }
        }
        log("recording started at \(inputFormat.sampleRate) Hz, \(inputFormat.channelCount) ch")
    }

    /// The whole take is over: no microphone, no watchdog, file closed.
    private func stopLocked() {
        recording = false
        stallTimer?.cancel()
        stallTimer = nil
        stopEngineLocked()
        // Releasing the file is what flushes its final header. Every queued
        // write has already landed (see `stopEngineLocked`).
        state.lock()
        self.file = nil
        state.unlock()
    }

    /// Drop the engine and tap, without touching the file the take writes to.
    private func stopEngineLocked() {
        if let observer = configurationObserver {
            NotificationCenter.default.removeObserver(observer)
            configurationObserver = nil
        }
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        // Everything the tap queued before it was removed must land in the file
        // before the converter it uses is released.
        writeQueue.sync {}
        state.lock()
        generation += 1
        converter = nil
        state.unlock()
    }

    /// Rebuild the microphone into the file this take is already writing to.
    private func recoverLocked(reason: String) {
        guard recording, stateHasOpenFile() else { return }
        stopEngineLocked()
        engineRestarts += 1
        log("rebuilding the capture engine: \(reason) (rebuild \(engineRestarts))")
        for attempt in 0..<2 {
            do {
                try startEngineLocked()
                return
            } catch {
                log("rebuild attempt \(attempt + 1) failed: \(describe(error))")
                stopEngineLocked()
            }
        }
        state.lock()
        writeFailures += 1
        lastWriteFailure = "the microphone could not be reopened after \(reason)"
        state.unlock()
        log("the microphone could not be reopened; this take no longer receives audio")
    }

    private func stateHasOpenFile() -> Bool {
        state.lock()
        defer { state.unlock() }
        return file != nil
    }

    /// Watches the tap, not the clock: a take that stops receiving buffers is a
    /// take that is silently losing audio, and rebuilding the engine is what
    /// keeps the rest of it.
    private func startStallWatchdogLocked() {
        guard stallTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: controlQueue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self, self.recording, self.engine != nil else { return }
            self.state.lock()
            let last = self.lastFrameAt
            self.state.unlock()
            guard Date().timeIntervalSince(last) > self.stallInterval else { return }
            self.recoverLocked(reason: "the microphone stopped delivering audio")
        }
        stallTimer = timer
        timer.resume()
    }

    private func write(_ input: AVAudioPCMBuffer, generation: Int) {
        state.lock()
        let isCurrent = generation == self.generation
        let converter = self.converter
        let file = self.file
        state.unlock()
        guard isCurrent, let converter, let file else { return }

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
        if let conversionError {
            recordWriteFailure("audio conversion failed: \(describe(conversionError))")
            return
        }
        guard status != .error, output.frameLength > 0 else {
            if status == .error { recordWriteFailure("audio conversion stopped with an error") }
            return
        }
        do {
            try file.write(from: output)
            state.lock()
            framesWritten += Int(output.frameLength)
            lastFrameAt = Date()
            state.unlock()
        } catch {
            recordWriteFailure("the recording file refused a write: \(describe(error))")
        }
    }

    private func recordWriteFailure(_ detail: String) {
        state.lock()
        writeFailures += 1
        let first = lastWriteFailure == nil
        lastWriteFailure = detail
        let count = writeFailures
        state.unlock()
        // One line for the first failure and every fiftieth after it: a broken
        // disk would otherwise bury the log.
        if first || count % 50 == 0 {
            log("\(detail) (failure \(count))")
        }
    }

    /// The take-level warning for whatever went wrong, or `nil` for a clean take.
    /// Called with `state` already locked.
    private func captureWarningLocked() -> String? {
        if let lastWriteFailure {
            return "the microphone recording lost audio: \(lastWriteFailure)"
        }
        return nil
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
            return Response(
                id: request.id,
                ok: true,
                error: nil,
                errorDomain: nil,
                errorCode: nil,
                framesWritten: nil,
                engineRestarts: nil,
                captureWarning: nil
            )
        case "prepare":
            capture.warm()
            return Response(
                id: request.id,
                ok: true,
                error: nil,
                errorDomain: nil,
                errorCode: nil,
                framesWritten: nil,
                engineRestarts: nil,
                captureWarning: nil
            )
        case "stop":
            let finished = capture.stop()
            return Response(
                id: request.id,
                ok: true,
                error: nil,
                errorDomain: nil,
                errorCode: nil,
                framesWritten: finished.frames,
                engineRestarts: finished.restarts,
                captureWarning: finished.warning
            )
        default:
            throw NSError(domain: "SpeechCaptureWorker", code: 4, userInfo: [NSLocalizedDescriptionKey: "Unsupported capture operation."])
        }
    } catch {
        let nsError = error as NSError
        log("operation \(request.operation) failed: \(describe(error))")
        return Response(
            id: request.id,
            ok: false,
            error: describe(error),
            errorDomain: nsError.domain,
            errorCode: nsError.code,
            framesWritten: nil,
            engineRestarts: nil,
            captureWarning: nil
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
        _ = capture.stop()
    }
}
