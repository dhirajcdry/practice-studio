// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "studio-asr",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "studio-asr", targets: ["StudioASR"])
    ],
    dependencies: [
        // Match justwisper so its downloaded Core ML models can be reused.
        .package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", exact: "0.18.0")
    ],
    targets: [
        .executableTarget(
            name: "StudioASR",
            dependencies: [
                .product(name: "WhisperKit", package: "argmax-oss-swift")
            ],
            path: "Sources/StudioASR"
        ),
        .testTarget(name: "StudioASRTests", dependencies: ["StudioASR"], path: "Tests/StudioASRTests")
    ]
)
