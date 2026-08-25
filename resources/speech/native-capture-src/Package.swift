// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NativeSpeechCapture",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "speech-capture-worker", targets: ["SpeechCaptureWorker"])
    ],
    targets: [
        .executableTarget(name: "SpeechCaptureWorker")
    ]
)
