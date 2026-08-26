import Foundation
import FluidAudio

private struct WorkerRequest: Decodable {
    let id: String
    let operation: String
    let model: String
    let audio: String?
}

private struct WorkerResponse: Encodable {
    let id: String
    let ok: Bool
    let text: String?
    let error: String?
}

private enum WorkerError: LocalizedError {
    case missing(String)
    case unsupported(String)
    case invalidModel(String)

    var errorDescription: String? {
        switch self {
        case .missing(let field): "Missing required field: \(field)."
        case .unsupported(let operation): "Unsupported Core ML operation: \(operation)."
        case .invalidModel(let path):
            "Core ML Parakeet model is incomplete at \(path). Expected Preprocessor.mlmodelc, Encoder.mlmodelc, Decoder.mlmodelc, JointDecision.mlmodelc, and parakeet_vocab.json."
        }
    }
}

private actor ModelCache {
    private var managers: [String: AsrManager] = [:]

    func warmup(modelPath: String) async throws {
        _ = try await manager(for: modelPath)
    }

    func transcribe(modelPath: String, audioPath: String) async throws -> String {
        let manager = try await manager(for: modelPath)
        var decoderState = TdtDecoderState.make(decoderLayers: 2)
        let result = try await manager.transcribe(
            URL(fileURLWithPath: audioPath),
            decoderState: &decoderState
        )
        let transcript = result.text
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { throw WorkerError.invalidModel("empty transcript") }
        return transcript
    }

    private func manager(for modelPath: String) async throws -> AsrManager {
        if let cached = managers[modelPath] { return cached }
        let directory = URL(fileURLWithPath: modelPath, isDirectory: true)
        let version: AsrModelVersion = modelPath.lowercased().contains("v2") ? .v2 : .v3
        guard AsrModels.modelsExist(at: directory, version: version) else {
            throw WorkerError.invalidModel(modelPath)
        }
        let models = try await AsrModels.load(from: directory, version: version)
        let manager = AsrManager(config: .default)
        try await manager.loadModels(models)
        managers[modelPath] = manager
        return manager
    }
}

private let decoder = JSONDecoder()
private let encoder = JSONEncoder()
private let cache = ModelCache()

private func emit(_ response: WorkerResponse) {
    guard let data = try? encoder.encode(response) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private func handle(_ request: WorkerRequest) async throws -> WorkerResponse {
    switch request.operation {
    case "warmup":
        try await cache.warmup(modelPath: request.model)
        return WorkerResponse(id: request.id, ok: true, text: nil, error: nil)
    case "transcribe":
        guard let audio = request.audio else { throw WorkerError.missing("audio") }
        let text = try await cache.transcribe(modelPath: request.model, audioPath: audio)
        return WorkerResponse(id: request.id, ok: true, text: text, error: nil)
    default:
        throw WorkerError.unsupported(request.operation)
    }
}

@main
private enum CoreMLWorker {
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
