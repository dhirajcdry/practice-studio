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
        // Pinned to an exact version, measured at ~489x realtime with Parakeet TDT 0.6B v2.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.15.5")
    ],
    targets: [
        .executableTarget(
            name: "StudioASR",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ],
            path: "Sources/StudioASR"
        )
    ]
)
