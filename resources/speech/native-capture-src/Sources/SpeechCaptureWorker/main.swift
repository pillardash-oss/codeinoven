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

    var isRecording: Bool { engine != nil }

    func start(outputPath: String) throws {
        stop()

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)
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
        do {
            try engine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            self.engine = nil
            self.converter = nil
            self.file = nil
            throw error
        }
    }

    func stop() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        self.converter = nil
        writeQueue.sync {
            generation += 1
            self.file = nil
        }
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
        case "stop":
            capture.stop()
        default:
            throw NSError(domain: "SpeechCaptureWorker", code: 4, userInfo: [NSLocalizedDescriptionKey: "Unsupported capture operation."])
        }
        return Response(id: request.id, ok: true, error: nil)
    } catch {
        return Response(id: request.id, ok: false, error: error.localizedDescription)
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
