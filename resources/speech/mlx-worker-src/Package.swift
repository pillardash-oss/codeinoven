// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "CodeInOvenMLXSpeechWorker",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "mlx-worker", targets: ["MLXWorker"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/Blaizzy/mlx-audio-swift.git",
            revision: "cae704f53bc32a3d0b606823828fbc5bedaaf388"
        ),
    ],
    targets: [
        .executableTarget(
            name: "MLXWorker",
            dependencies: [
                .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
                .product(name: "MLXAudioSTT", package: "mlx-audio-swift"),
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
            ]
        ),
    ]
)
