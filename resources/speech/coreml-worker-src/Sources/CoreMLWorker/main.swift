import CoreML
import FluidAudio
import Foundation

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
    case invalidVocabulary(String)

    var errorDescription: String? {
        switch self {
        case .missing(let field): "Missing required field: \(field)."
        case .unsupported(let operation): "Unsupported Core ML operation: \(operation)."
        case .invalidModel(let path):
            "Core ML Parakeet model is incomplete at \(path). Expected Preprocessor.mlmodelc, Encoder.mlmodelc, Decoder.mlmodelc, JointDecision.mlmodelc, and parakeet_vocab.json."
        case .invalidVocabulary(let path):
            "Core ML Parakeet vocabulary at \(path) is not a token table keyed by token id."
        }
    }
}

/// A Parakeet Core ML bundle installed by CodeInOven: the four compiled model
/// bundles plus the vocabulary the model itself declares, all directly inside the
/// directory the speech service hands to this worker.
///
/// Loading the bundle itself keeps every catalog artifact self-describing. Nothing
/// is resolved from a repository folder layout and nothing is fetched at load
/// time, which is also what lets a compressed Parakeet release run without a
/// dedicated loader branch in the runtime library.
private enum ParakeetBundle {
    static let preprocessorFile = "Preprocessor.mlmodelc"
    static let encoderFile = "Encoder.mlmodelc"
    static let decoderFile = "Decoder.mlmodelc"
    static let jointFile = "JointDecision.mlmodelc"
    static let vocabularyFile = "parakeet_vocab.json"

    /// The two transducer contracts differ in how many tokens they reserve, and
    /// each model publishes a vocabulary exactly that wide: the English 0.6B v2
    /// table holds 1031 entries and reserves blank id 1024, while the v3 table
    /// holds 8192 entries and reserves blank id 8192. Reading the width from the
    /// installed model keeps the contract honest for a compressed conversion whose
    /// folder name says nothing about which contract it follows.
    private static let v3VocabularyWidth = 8192

    static func isComplete(at directory: URL) -> Bool {
        let fileManager = FileManager.default
        let required = [preprocessorFile, encoderFile, decoderFile, jointFile, vocabularyFile]
        return required.allSatisfy { fileName in
            fileManager.fileExists(atPath: directory.appendingPathComponent(fileName).path)
        }
    }

    static func load(from directory: URL) throws -> AsrModels {
        let vocabulary = try loadVocabulary(at: directory.appendingPathComponent(vocabularyFile))
        let version: AsrModelVersion = vocabulary.count >= v3VocabularyWidth ? .v3 : .v2
        return AsrModels(
            encoder: try compiled(encoderFile, in: directory, computeUnits: .cpuAndNeuralEngine),
            preprocessor: try compiled(preprocessorFile, in: directory, computeUnits: .cpuOnly),
            decoder: try compiled(decoderFile, in: directory, computeUnits: .cpuAndNeuralEngine),
            joint: try compiled(jointFile, in: directory, computeUnits: .cpuAndNeuralEngine),
            configuration: configuration(computeUnits: .cpuAndNeuralEngine),
            vocabulary: vocabulary,
            version: version
        )
    }

    private static func compiled(
        _ fileName: String,
        in directory: URL,
        computeUnits: MLComputeUnits
    ) throws -> MLModel {
        try MLModel(
            contentsOf: directory.appendingPathComponent(fileName),
            configuration: configuration(computeUnits: computeUnits)
        )
    }

    /// Mirrors the runtime's own compute-unit policy: the mel preprocessor maps to
    /// the CPU, every other Parakeet component prefers the Neural Engine.
    private static func configuration(computeUnits: MLComputeUnits) -> MLModelConfiguration {
        let configuration = AsrModels.defaultConfiguration()
        configuration.computeUnits = computeUnits
        return configuration
    }

    /// Accepts the token table formats the Parakeet releases publish: a dictionary
    /// keyed by token id, or an array whose position is the token id.
    private static func loadVocabulary(at url: URL) throws -> [Int: String] {
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        var vocabulary: [Int: String] = [:]
        if let entries = json as? [String] {
            for (index, token) in entries.enumerated() { vocabulary[index] = token }
        } else if let entries = json as? [String: String] {
            for (key, token) in entries {
                guard let tokenId = Int(key) else { continue }
                vocabulary[tokenId] = token
            }
        }
        guard !vocabulary.isEmpty else { throw WorkerError.invalidVocabulary(url.path) }
        return vocabulary
    }
}

private actor ModelCache {
    private var managers: [String: AsrManager] = [:]

    func warmup(modelPath: String) async throws {
        _ = try await manager(for: modelPath)
    }

    /// A chunk with no speech is a normal answer, never a broken install:
    /// footage is full of silence, and the caller decides what an empty
    /// transcript means. Reporting it as an incomplete model sent the agent
    /// chasing a reinstall of a model that is perfectly fine.
    func transcribe(modelPath: String, audioPath: String) async throws -> String {
        let manager = try await manager(for: modelPath)
        var decoderState = TdtDecoderState.make(decoderLayers: 2)
        let result = try await manager.transcribe(
            URL(fileURLWithPath: audioPath),
            decoderState: &decoderState
        )
        return result.text
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func manager(for modelPath: String) async throws -> AsrManager {
        if let cached = managers[modelPath] { return cached }
        let directory = URL(fileURLWithPath: modelPath, isDirectory: true)
        let models: AsrModels
        if ParakeetBundle.isComplete(at: directory) {
            models = try ParakeetBundle.load(from: directory)
        } else {
            let version: AsrModelVersion = modelPath.lowercased().contains("v2") ? .v2 : .v3
            guard AsrModels.modelsExist(at: directory, version: version) else {
                throw WorkerError.invalidModel(modelPath)
            }
            models = try await AsrModels.load(from: directory, version: version)
        }
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
