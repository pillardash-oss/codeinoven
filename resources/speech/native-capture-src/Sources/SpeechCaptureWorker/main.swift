import AVFoundation
import Foundation

private struct Request: Decodable {
    let id: String
    let operation: String
    let outputPath: String?
    /// The instant the user pressed record, as a wall clock both processes
    /// share. Only preroll audio captured at or after it belongs to the take.
    let since: Double?
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
    /// How many times the engine had to be rebuilt mid-take.
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

/// One converted chunk of audio waiting for a take's file to be opened.
private struct PrerollChunk {
    let capturedAt: Date
    let data: Data
    let frames: Int
}

/// One microphone recorder.
///
/// Three things decide whether a take loses its opening words, and all of them
/// live here:
///
/// - **Boot priming.** Opening CoreAudio's input device costs 150-800 ms on a
///   cold process and seconds when the process itself is still loading. The
///   worker is spawned and *primed* at launch: an engine, its tap and its device
///   object are built and started once, then stopped with everything retained.
///   Every later start is just `engine.start()` (tens of milliseconds), so the
///   first press of a session behaves like the twentieth.
/// - **Gesture arming.** The renderer arms the recorder on the gesture that
///   precedes a take (pointer down on a mic, the shortcut's first tap). The
///   device is already running then, and what it hears goes into a small
///   in-memory ring. Pressing record only opens the file, flushes the ring from
///   the instant of the press and keeps appending.
/// - **A dying feed.** The take's file outlives the engine: a configuration
///   change or a tap that stops delivering buffers rebuilds the engine, its
///   converter and its tap into the same take instead of ending the audio.
///
/// Threading: engine lifecycle (prime, arm, start, stop, rebuild) runs on
/// `controlQueue`; buffers are converted and written on `writeQueue`. The preroll
/// ring is owned by `writeQueue` alone; the flags both queues read are guarded by
/// `state`.
private final class CaptureSession {
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    )!

    private let controlQueue = DispatchQueue(label: "com.pillardash.codeinoven.speech-capture.control")
    private let writeQueue = DispatchQueue(label: "com.pillardash.codeinoven.speech-capture.write")
    /// Guards the values the audio thread's write reads while the control queue
    /// replaces them, plus the statistics the watchdog reads.
    private let state = NSLock()

    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var file: AVAudioFile?
    private var generation = 0
    private var tapInstalled = false
    private var tapFormat: AVAudioFormat?
    private var configurationObserver: NSObjectProtocol?
    private var stallTimer: DispatchSourceTimer?
    private var armIdleTimer: DispatchSourceTimer?
    private var recording = false
    private var armed = false
    private var framesWritten = 0
    private var lastFrameAt = Date()
    private var engineRestarts = 0
    private var writeFailures = 0
    private var lastWriteFailure: String?
    /// Written only on `writeQueue`.
    private var preroll: [PrerollChunk] = []
    private var prerollFrames = 0

    /// No buffer for this long while a take is live means the tap is dead: a
    /// device change CoreAudio never announced, a stalled HAL, or an engine
    /// that stopped its input unit. Well above the 2048-frame tap cadence
    /// (~43 ms), so ordinary scheduling delays cannot trip it.
    private let stallInterval: TimeInterval = 2.5
    /// How much audio an armed recorder keeps before the oldest is dropped. A
    /// press path that takes longer than this is already lost in other ways.
    private let prerollLimitFrames = 8 * 16_000
    /// An armed microphone that is never pressed releases the device again.
    private let armIdleTimeout: TimeInterval = 20

    /// The process is ready for its first recording.
    func ping() {
        // Spawning the worker is all this needs to do; the host calls it so a
        // press never pays process launch.
    }

    /// Pay the expensive part of a capture at launch, not on the first press.
    ///
    /// Builds the engine, installs the tap, starts the device so CoreAudio
    /// resolves it once, then stops it again. Everything stays retained, so the
    /// microphone is released (no indicator) while the next start costs tens of
    /// milliseconds instead of hundreds.
    func warm() {
        controlQueue.sync {
            guard !self.recording, !self.armed else { return }
            do {
                try self.ensureEngineLocked()
            } catch {
                log("priming the microphone failed: \(describe(error))")
                return
            }
            self.engine?.stop()
            self.state.lock()
            self.converter = nil
            self.state.unlock()
            log("microphone primed; a press only has to start the engine")
        }
    }

    /// Open the microphone ahead of the press and buffer what it hears.
    func arm() {
        controlQueue.sync {
            guard !self.recording, !self.armed else { return }
            self.state.lock()
            self.armed = true
            self.lastFrameAt = Date()
            self.state.unlock()
            do {
                try self.ensureEngineLocked()
            } catch {
                self.state.lock()
                self.armed = false
                self.state.unlock()
                log("arming the microphone failed: \(describe(error))")
                return
            }
            self.startArmIdleTimerLocked()
        }
    }

    /// Release the microphone of an arm the user never pressed.
    func disarm() {
        controlQueue.sync {
            guard !self.recording, self.armed else { return }
            self.state.lock()
            self.armed = false
            self.state.unlock()
            self.stopEngineLocked()
            self.clearPrerollLocked()
            self.armIdleTimer?.cancel()
            self.armIdleTimer = nil
        }
    }

    func start(outputPath: String, since: Date?) throws {
        var failure: Error?
        controlQueue.sync {
            if self.recording { self.endTakeLocked() }
            do {
                try self.beginLocked(outputPath: outputPath, since: since)
            } catch {
                self.fullStopLocked()
                failure = error
            }
        }
        if let failure { throw failure }
    }

    /// Ends the take and answers with what it actually captured.
    func stop() -> (frames: Int, restarts: Int, warning: String?) {
        var result: (frames: Int, restarts: Int, warning: String?) = (0, 0, nil)
        controlQueue.sync {
            self.fullStopLocked()
            self.state.lock()
            result = (self.framesWritten, self.engineRestarts, self.captureWarningLocked())
            self.state.unlock()
        }
        return result
    }

    /// Open the take's file, then bind the microphone to it: an already armed
    /// engine hands over its buffered opening, a primed one only starts.
    private func beginLocked(outputPath: String, since: Date?) throws {
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
        self.state.lock()
        self.file = file
        self.framesWritten = 0
        self.engineRestarts = 0
        self.writeFailures = 0
        self.lastWriteFailure = nil
        self.state.unlock()
        self.armIdleTimer?.cancel()
        self.armIdleTimer = nil

        // An armed engine is already running and already buffering: use it as it
        // is rather than paying the device open again, unless it stopped feeding
        // buffers while it waited. Anything else marks itself armed first, so the
        // audio the device delivers while it starts is buffered, not dropped.
        let reuseArmedEngine =
            self.armed && (self.engine?.isRunning ?? false) && !self.engineIsStale()
        if !reuseArmedEngine {
            self.state.lock()
            self.armed = true
            self.state.unlock()
            try startEngineLockedWithRetry()
        }
        // Queue order is what makes the handover exact: every buffer converted
        // while armed lands in the ring first, the ring is flushed into the file
        // here, and only then does the next buffer go straight to the file.
        let captureSince = since ?? Date.distantPast
        writeQueue.sync {
            self.flushPrerollLocked(into: file, since: captureSince)
            self.state.lock()
            self.recording = true
            self.armed = false
            self.lastFrameAt = Date()
            self.state.unlock()
        }
        self.startStallWatchdogLocked()
    }

    private func engineIsStale() -> Bool {
        state.lock()
        defer { state.unlock() }
        return Date().timeIntervalSince(lastFrameAt) > 2
    }

    private func startEngineLockedWithRetry() throws {
        // Two attempts: a device switch between priming and the press, or a HAL
        // object invalidated under us, fails the first start with CoreAudio's
        // unspecified error ('what'). Rebuilding binds to the current default
        // device and recovers the common case instead of losing the take.
        var lastError: Error?
        for attempt in 0..<2 {
            do {
                try ensureEngineLocked()
                return
            } catch {
                lastError = error
                log("start attempt \(attempt + 1) failed: \(describe(error))")
                teardownLocked()
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

    /// Make sure a running engine and tap exist for the current input device.
    ///
    /// Everything installed here is retained across takes: the engine object,
    /// the tap and the CoreAudio device object. That is what makes a later start
    /// tens of milliseconds instead of a fresh device open.
    private func ensureEngineLocked() throws {
        let boundAt = Date()
        let engine = self.engine ?? AVAudioEngine()
        self.engine = engine
        let inputNode = engine.inputNode
        // The tap is installed with the node's OUTPUT format. The hardware
        // format is what CoreAudio rejects at tap time once the default device
        // has moved, and that rejection is the 'what' failure.
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
            throw NSError(
                domain: "SpeechCaptureWorker",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "The selected microphone has no usable input format."]
            )
        }
        // A device that moved while the engine was idle leaves the installed tap
        // bound to the old format. Rebuild from a fresh engine in that case.
        if tapInstalled, let tapFormat,
           tapFormat.sampleRate != inputFormat.sampleRate || tapFormat.channelCount != inputFormat.channelCount {
            log("the input device changed from \(tapFormat.sampleRate) Hz to \(inputFormat.sampleRate) Hz; rebuilding the microphone")
            teardownLocked()
            try ensureEngineLocked()
            return
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
        self.converter = converter
        self.lastFrameAt = Date()
        state.unlock()

        if !tapInstalled {
            state.lock()
            generation += 1
            let currentGeneration = generation
            state.unlock()
            inputNode.installTap(onBus: 0, bufferSize: 2_048, format: inputFormat) { [weak self] buffer, _ in
                guard let self else { return }
                guard let copy = self.clone(buffer) else { return }
                self.writeQueue.async { [weak self] in
                    self?.write(copy, generation: currentGeneration)
                }
            }
            tapInstalled = true
            tapFormat = inputFormat
        }
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        // A device switch mid-recording stops the engine and its tap. CoreAudio
        // announces it, and the take survives it: the engine is rebuilt and keeps
        // writing into the file this recording already owns.
        if configurationObserver == nil {
            configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange,
                object: engine,
                queue: nil
            ) { [weak self] _ in
                guard let self else { return }
                log("audio engine configuration changed")
                self.controlQueue.async {
                    self.recoverLocked(reason: "the audio device configuration changed")
                }
            }
        }
        log("microphone live at \(inputFormat.sampleRate) Hz, \(inputFormat.channelCount) ch (\(Int(Date().timeIntervalSince(boundAt) * 1000)) ms)")
    }

    /// The take is over: no microphone, no watchdog, file closed and flushed.
    /// The engine, tap and device stay retained for the next take.
    private func fullStopLocked() {
        if recording { endTakeLocked() } else { stopEngineLocked() }
        state.lock()
        recording = false
        armed = false
        state.unlock()
        clearPrerollLocked()
        stallTimer?.cancel()
        stallTimer = nil
        armIdleTimer?.cancel()
        armIdleTimer = nil
        state.lock()
        self.file = nil
        state.unlock()
    }

    /// End the current take, keeping the engine, tap and device warm.
    private func endTakeLocked() {
        // The engine is stopped first and the queued writes are drained while
        // `recording` is still true, so the take's tail lands in its file.
        stopEngineLocked()
        writeQueue.sync {}
        state.lock()
        recording = false
        file = nil
        state.unlock()
        stallTimer?.cancel()
        stallTimer = nil
    }

    private func stopEngineLocked() {
        writeQueue.sync {}
        engine?.stop()
    }

    /// Drop the engine, tap and converter. Only a rebuild needs this: everything
    /// else keeps them so the next start is cheap.
    private func teardownLocked() {
        if let observer = configurationObserver {
            NotificationCenter.default.removeObserver(observer)
            configurationObserver = nil
        }
        if let engine {
            if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
            engine.stop()
        }
        tapInstalled = false
        tapFormat = nil
        writeQueue.sync {}
        state.lock()
        generation += 1
        converter = nil
        state.unlock()
        engine = nil
    }

    /// Rebuild the microphone into the file this take is already writing to.
    private func recoverLocked(reason: String) {
        let live = recording || armed
        guard live, engine != nil else { return }
        teardownLocked()
        if recording {
            engineRestarts += 1
            log("rebuilding the capture engine: \(reason) (rebuild \(engineRestarts))")
        }
        for attempt in 0..<2 {
            do {
                try ensureEngineLocked()
                return
            } catch {
                log("rebuild attempt \(attempt + 1) failed: \(describe(error))")
                teardownLocked()
            }
        }
        if recording {
            state.lock()
            writeFailures += 1
            lastWriteFailure = "the microphone could not be reopened after \(reason)"
            state.unlock()
        }
        log("the microphone could not be reopened; this take no longer receives audio")
    }

    /// Watches the tap, not the clock: a take that stops receiving buffers is a
    /// take that is silently losing audio, and rebuilding the engine is what
    /// keeps the rest of it.
    private func startStallWatchdogLocked() {
        stallTimer?.cancel()
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

    private func startArmIdleTimerLocked() {
        armIdleTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: controlQueue)
        timer.schedule(deadline: .now() + armIdleTimeout)
        timer.setEventHandler { [weak self] in
            guard let self, self.armed, !self.recording else { return }
            self.state.lock()
            self.armed = false
            self.state.unlock()
            self.stopEngineLocked()
            self.clearPrerollLocked()
            log("microphone released after an arm that was never pressed")
        }
        armIdleTimer = timer
        timer.resume()
    }

    private func write(_ input: AVAudioPCMBuffer, generation: Int) {
        state.lock()
        let isCurrent = generation == self.generation
        let recording = self.recording
        let armed = self.armed
        let converter = self.converter
        state.unlock()
        guard isCurrent, let converter, recording || armed else { return }

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
        guard recording else {
            appendPrerollLocked(output)
            return
        }
        state.lock()
        let file = self.file
        state.unlock()
        guard let file else { return }
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

    /// Runs on `writeQueue` only.
    private func appendPrerollLocked(_ output: AVAudioPCMBuffer) {
        guard let channel = output.floatChannelData?[0] else { return }
        let frames = Int(output.frameLength)
        let data = Data(bytes: channel, count: frames * MemoryLayout<Float>.size)
        preroll.append(PrerollChunk(capturedAt: Date(), data: data, frames: frames))
        prerollFrames += frames
        while prerollFrames > prerollLimitFrames, let oldest = preroll.first {
            prerollFrames -= oldest.frames
            preroll.removeFirst()
        }
    }

    /// Runs on `writeQueue` only, inside the handover that starts a take.
    private func flushPrerollLocked(into file: AVAudioFile, since: Date) {
        let kept = preroll.filter { $0.capturedAt >= since }
        preroll.removeAll()
        prerollFrames = 0
        guard !kept.isEmpty else { return }
        var written = 0
        for chunk in kept {
            guard let buffer = self.buffer(from: chunk) else { continue }
            do {
                try file.write(from: buffer)
                written += chunk.frames
            } catch {
                recordWriteFailure("the recording file refused a preroll write: \(describe(error))")
                break
            }
        }
        guard written > 0 else { return }
        state.lock()
        framesWritten += written
        lastFrameAt = Date()
        state.unlock()
        log("recovered \(written * 1000 / 16_000) ms buffered before the press")
    }

    private func clearPrerollLocked() {
        preroll.removeAll()
        prerollFrames = 0
    }

    private func buffer(from chunk: PrerollChunk) -> AVAudioPCMBuffer? {
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: targetFormat,
            frameCapacity: AVAudioFrameCount(chunk.frames)
        ) else { return nil }
        buffer.frameLength = AVAudioFrameCount(chunk.frames)
        guard let channel = buffer.floatChannelData?[0] else { return nil }
        chunk.data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            channel.update(from: base.assumingMemoryBound(to: Float.self), count: chunk.frames)
        }
        return buffer
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

private func failure(_ id: String, _ error: Error) -> Response {
    let nsError = error as NSError
    log("operation failed: \(describe(error))")
    return Response(
        id: id,
        ok: false,
        error: describe(error),
        errorDomain: nsError.domain,
        errorCode: nsError.code,
        framesWritten: nil,
        engineRestarts: nil,
        captureWarning: nil
    )
}

private func success(_ id: String) -> Response {
    Response(
        id: id,
        ok: true,
        error: nil,
        errorDomain: nil,
        errorCode: nil,
        framesWritten: nil,
        engineRestarts: nil,
        captureWarning: nil
    )
}

private func handle(_ request: Request) -> Response {
    switch request.operation {
    case "ping":
        capture.ping()
        return success(request.id)
    case "prepare":
        capture.warm()
        return success(request.id)
    case "arm":
        capture.arm()
        return success(request.id)
    case "disarm":
        capture.disarm()
        return success(request.id)
    case "start":
        guard let outputPath = request.outputPath, !outputPath.isEmpty else {
            return failure(
                request.id,
                NSError(
                    domain: "SpeechCaptureWorker",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Missing recording output path."]
                )
            )
        }
        let since = request.since.map { Date(timeIntervalSince1970: $0 / 1000) }
        do {
            try capture.start(outputPath: outputPath, since: since)
        } catch {
            return failure(request.id, error)
        }
        return success(request.id)
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
        return failure(
            request.id,
            NSError(
                domain: "SpeechCaptureWorker",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "Unsupported capture operation."]
            )
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
