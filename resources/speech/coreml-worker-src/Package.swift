// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CodeInOvenCoreMLSpeechWorker",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "coreml-worker", targets: ["CoreMLWorker"])
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.15.5")
    ],
    targets: [
        .executableTarget(
            name: "CoreMLWorker",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ]
        )
    ]
)
