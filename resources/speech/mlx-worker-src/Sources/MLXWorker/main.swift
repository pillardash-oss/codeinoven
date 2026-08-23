import Foundation
import MLXAudioCore
@preconcurrency import MLXAudioSTT
@preconcurrency import MLXAudioTTS

private struct WorkerRequest: Decodable {
    let id: String
    let operation: String
    let model: String
    let audio: String?
    let language: String?
    let transcript: String?
    let text: String?
    let voice: String?
    let output: String?
}

private struct WorkerResponse: Encodable {
    let id: String
    let ok: Bool
    let text: String?
    let error: String?
}

private final class ModelCache: @unchecked Sendable {
    private var whisper: [String: WhisperModel] = [:]
    private var kokoro: [String: SpeechGenerationModel] = [:]

    private func whisperModel(at path: String) async throws -> WhisperModel {
        if let loaded = whisper[path] { return loaded }
        let loaded = try await WhisperModel.fromDirectory(URL(fileURLWithPath: path))
        whisper[path] = loaded
        return loaded
    }

    private func kokoroModel(at path: String) async throws -> SpeechGenerationModel {
        if let loaded = kokoro[path] { return loaded }
        let cachePath = URL(fileURLWithPath: path)
            .appendingPathComponent("mlx-cache", isDirectory: true)
            .path
        setenv("HF_HUB_CACHE", cachePath, 1)
        let loaded = try await TTS.loadModel(modelRepo: path, modelType: "kokoro")
        kokoro[path] = loaded
        return loaded
    }

    func transcribe(modelPath: String, audioPath: String, language: String?) async throws -> String {
        let model = try await whisperModel(at: modelPath)
        let (_, samples) = try loadAudioArray(
            from: URL(fileURLWithPath: audioPath),
            sampleRate: 16_000
        )
        return model.generate(
            audio: samples,
            generationParameters: STTGenerateParameters(language: language)
        ).text
    }

    func synthesize(
        modelPath: String,
        text: String,
        voice: String,
        outputPath: String
    ) async throws {
        let model = try await kokoroModel(at: modelPath)
        let samples = try await model.generate(
            text: text,
            voice: voice,
            refAudio: nil,
            refText: nil,
            language: nil
        )
        try AudioUtils.writeWavFile(
            samples: samples.asArray(Float.self),
            sampleRate: model.sampleRate,
            fileURL: URL(fileURLWithPath: outputPath)
        )
    }
}

private let cache = ModelCache()
private let decoder = JSONDecoder()
private let encoder = JSONEncoder()

private func emit(_ response: WorkerResponse) {
    guard let data = try? encoder.encode(response) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private func cleanTranscript(_ transcript: String) -> String {
    let collapsed = transcript
        .split(whereSeparator: { $0.isWhitespace })
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = collapsed.first else { return collapsed }
    var cleaned = first.uppercased() + collapsed.dropFirst()
    if let last = cleaned.last, !".!?".contains(last) { cleaned.append(".") }
    return cleaned
}

private func handle(_ request: WorkerRequest) async throws -> WorkerResponse {
    switch request.operation {
    case "transcribe":
        guard let audio = request.audio else { throw WorkerError.missing("audio") }
        let language = request.language == "auto" ? nil : request.language
        let text = try await cache.transcribe(
            modelPath: request.model,
            audioPath: audio,
            language: language
        )
        return WorkerResponse(id: request.id, ok: true, text: text, error: nil)
    case "cleanup":
        guard let transcript = request.transcript else { throw WorkerError.missing("transcript") }
        return WorkerResponse(
            id: request.id,
            ok: true,
            text: cleanTranscript(transcript),
            error: nil
        )
    case "synthesize":
        guard let text = request.text else { throw WorkerError.missing("text") }
        guard let output = request.output else { throw WorkerError.missing("output") }
        try await cache.synthesize(
            modelPath: request.model,
            text: text,
            voice: request.voice ?? "af_heart",
            outputPath: output
        )
        return WorkerResponse(id: request.id, ok: true, text: nil, error: nil)
    default:
        throw WorkerError.unsupported(request.operation)
    }
}

private enum WorkerError: LocalizedError {
    case missing(String)
    case unsupported(String)

    var errorDescription: String? {
        switch self {
        case .missing(let field): "Missing required field: \(field)."
        case .unsupported(let operation): "Unsupported operation: \(operation)."
        }
    }
}

@main
private enum MLXWorker {
    static func main() async {
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8) else { continue }
            do {
                let request = try decoder.decode(WorkerRequest.self, from: data)
                emit(try await handle(request))
            } catch {
                let id = (try? decoder.decode(WorkerRequest.self, from: data).id) ?? "unknown"
                emit(WorkerResponse(id: id, ok: false, text: nil, error: error.localizedDescription))
            }
        }
    }
}
