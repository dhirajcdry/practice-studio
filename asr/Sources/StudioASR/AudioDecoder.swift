import AVFoundation
import Foundation

/// 16 kHz mono float samples plus everything we learned about the source file
/// while decoding it.
struct DecodedAudio {
    /// Mono PCM samples in [-1, 1] at `AudioDecoder.targetSampleRate`.
    let monoSamples: [Float]
    /// Duration reported by the container (AVAsset, or ffprobe for containers
    /// AVFoundation cannot open). `nil` when the container did not report one.
    let containerReportedDurationSeconds: Double?
    /// Which decoding path produced the samples — useful in warnings/logs.
    let decoderName: String

    /// Duration the tool reports to the caller.
    ///
    /// IMPORTANT: this must NEVER come from `ASRResult.duration`. FluidAudio's
    /// chunked (>15s) path builds its result with `audioSamples: []`, so both
    /// `duration` and `rtfx` come back as 0 for exactly the long recordings we
    /// care about. Container duration (or, failing that, the decoded sample
    /// count) is always correct.
    var durationSeconds: Double {
        if let containerReportedDurationSeconds, containerReportedDurationSeconds > 0 {
            return containerReportedDurationSeconds
        }
        return Double(monoSamples.count) / Double(AudioDecoder.targetSampleRate)
    }

    /// Largest absolute sample value — the silence detector's input.
    var peakAmplitude: Float {
        var peak: Float = 0
        for sample in monoSamples where abs(sample) > peak {
            peak = abs(sample)
        }
        return peak
    }
}

enum AudioDecoder {
    /// Parakeet expects 16 kHz mono audio.
    static let targetSampleRate = 16_000

    /// Decodes any supported container to 16 kHz mono float samples.
    ///
    /// Two paths, in order:
    ///   1. AVFoundation (`AVAssetReader`) — handles .wav, .m4a, .mov, .mp4, .caf.
    ///   2. ffmpeg, if installed — handles .webm/Matroska, which AVFoundation
    ///      cannot open at all (browser `MediaRecorder` produces webm/opus).
    ///
    /// A container that neither path can open is reported as
    /// `unsupported_format` naming the extension, never as an empty transcript.
    static func decodeToMono16kHz(fileURL: URL) async throws -> DecodedAudio {
        let fileExtension = fileURL.pathExtension.lowercased()

        let asset = AVURLAsset(url: fileURL)
        let assetTracks: [AVAssetTrack]?
        do {
            assetTracks = try await asset.load(.tracks)
        } catch {
            // AVFoundation refused the container outright (typical for webm).
            assetTracks = nil
        }

        if let assetTracks, !assetTracks.isEmpty {
            let audioTracks = assetTracks.filter { $0.mediaType == .audio }

            guard !audioTracks.isEmpty else {
                // The container IS understood, and it definitively has no audio
                // stream. This is the loud failure the caller must never miss.
                let videoTrackCount = assetTracks.filter { $0.mediaType == .video }.count
                throw StudioASRError(
                    kind: "no_audio",
                    message:
                        "'\(fileURL.lastPathComponent)' has no audio track "
                        + "(\(assetTracks.count) track(s) found, \(videoTrackCount) of them video). "
                        + "Nothing can be transcribed from this file."
                )
            }

            let containerDurationSeconds = try? await CMTimeGetSeconds(asset.load(.duration))
            let monoSamples = try readMonoSamplesWithAssetReader(
                asset: asset,
                audioTracks: audioTracks,
                fileURL: fileURL
            )
            return DecodedAudio(
                monoSamples: monoSamples,
                containerReportedDurationSeconds: containerDurationSeconds.flatMap {
                    $0.isFinite && $0 > 0 ? $0 : nil
                },
                decoderName: "AVFoundation"
            )
        }

        // AVFoundation could not open the container (or opened it with zero
        // tracks, which it does for some Matroska files). Fall back to ffmpeg.
        return try decodeWithFFmpeg(fileURL: fileURL, fileExtension: fileExtension)
    }

    // MARK: - AVFoundation path

    private static func readMonoSamplesWithAssetReader(
        asset: AVURLAsset,
        audioTracks: [AVAssetTrack],
        fileURL: URL
    ) throws -> [Float] {
        let assetReader: AVAssetReader
        do {
            assetReader = try AVAssetReader(asset: asset)
        } catch {
            throw StudioASRError(
                kind: "decode_failed",
                message: "Could not open '\(fileURL.lastPathComponent)' for reading: \(error.localizedDescription)"
            )
        }

        let linearPCMOutputSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: Double(targetSampleRate),
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]

        let audioMixOutput = AVAssetReaderAudioMixOutput(
            audioTracks: audioTracks,
            audioSettings: linearPCMOutputSettings
        )
        audioMixOutput.alwaysCopiesSampleData = false

        guard assetReader.canAdd(audioMixOutput) else {
            throw StudioASRError(
                kind: "decode_failed",
                message:
                    "AVFoundation cannot decode the audio in '\(fileURL.lastPathComponent)' "
                    + "to 16 kHz mono PCM."
            )
        }
        assetReader.add(audioMixOutput)

        guard assetReader.startReading() else {
            throw StudioASRError(
                kind: "decode_failed",
                message:
                    "Failed to start decoding '\(fileURL.lastPathComponent)': "
                    + (assetReader.error?.localizedDescription ?? "unknown AVAssetReader error")
            )
        }

        var monoSamples: [Float] = []
        while let sampleBuffer = audioMixOutput.copyNextSampleBuffer() {
            guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { continue }

            var totalByteLength = 0
            var rawDataPointer: UnsafeMutablePointer<Int8>?
            let status = CMBlockBufferGetDataPointer(
                blockBuffer,
                atOffset: 0,
                lengthAtOffsetOut: nil,
                totalLengthOut: &totalByteLength,
                dataPointerOut: &rawDataPointer
            )
            guard status == kCMBlockBufferNoErr, let rawDataPointer else { continue }

            let floatSampleCount = totalByteLength / MemoryLayout<Float>.size
            rawDataPointer.withMemoryRebound(to: Float.self, capacity: floatSampleCount) { floatPointer in
                monoSamples.append(contentsOf: UnsafeBufferPointer(start: floatPointer, count: floatSampleCount))
            }
        }

        if assetReader.status == .failed {
            throw StudioASRError(
                kind: "decode_failed",
                message:
                    "Decoding '\(fileURL.lastPathComponent)' failed part-way through: "
                    + (assetReader.error?.localizedDescription ?? "unknown AVAssetReader error")
            )
        }

        return monoSamples
    }

    // MARK: - ffmpeg fallback path (webm / Matroska and anything else AVFoundation rejects)

    private static func decodeWithFFmpeg(fileURL: URL, fileExtension: String) throws -> DecodedAudio {
        let describedFormat = fileExtension.isEmpty ? "unknown container" : ".\(fileExtension)"

        guard let ffmpegExecutableURL = locateExecutable(named: "ffmpeg") else {
            throw StudioASRError(
                kind: "unsupported_format",
                message:
                    "'\(fileURL.lastPathComponent)' is a \(describedFormat) file, which macOS AVFoundation "
                    + "cannot decode, and no `ffmpeg` binary was found on PATH "
                    + "(/opt/homebrew/bin, /usr/local/bin, /usr/bin). Install ffmpeg or convert the file to "
                    + ".wav/.m4a/.mov first."
            )
        }

        // Ask ffprobe (if present) whether there is an audio stream at all, so
        // a no-audio webm/mkv reports `no_audio` rather than a vague decode error.
        var containerReportedDurationSeconds: Double?
        if let ffprobeExecutableURL = locateExecutable(named: "ffprobe") {
            let audioStreamProbe = runProcessCapturingOutput(
                executableURL: ffprobeExecutableURL,
                arguments: [
                    "-v", "error",
                    "-select_streams", "a",
                    "-show_entries", "stream=index",
                    "-of", "csv=p=0",
                    fileURL.path,
                ]
            )
            let audioStreamList = String(decoding: audioStreamProbe.standardOutput, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if audioStreamProbe.exitCode == 0 && audioStreamList.isEmpty {
                throw StudioASRError(
                    kind: "no_audio",
                    message:
                        "'\(fileURL.lastPathComponent)' (\(describedFormat)) has no audio stream. "
                        + "Nothing can be transcribed from this file."
                )
            }

            let durationProbe = runProcessCapturingOutput(
                executableURL: ffprobeExecutableURL,
                arguments: [
                    "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "csv=p=0",
                    fileURL.path,
                ]
            )
            containerReportedDurationSeconds = Double(
                String(decoding: durationProbe.standardOutput, as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }

        // Decode straight to raw 32-bit float, mono, 16 kHz on stdout.
        let decodeResult = runProcessCapturingOutput(
            executableURL: ffmpegExecutableURL,
            arguments: [
                "-v", "error",
                "-nostdin",
                "-i", fileURL.path,
                "-vn",
                "-map", "a:0",
                "-ac", "1",
                "-ar", String(targetSampleRate),
                "-f", "f32le",
                "-",
            ]
        )

        guard decodeResult.exitCode == 0 else {
            let ffmpegDiagnostics = String(decoding: decodeResult.standardError, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)

            // ffmpeg's own words when the stream selector matched nothing.
            if ffmpegDiagnostics.lowercased().contains("matches no streams")
                || ffmpegDiagnostics.lowercased().contains("does not contain any stream")
            {
                throw StudioASRError(
                    kind: "no_audio",
                    message:
                        "'\(fileURL.lastPathComponent)' (\(describedFormat)) has no audio stream. "
                        + "Nothing can be transcribed from this file."
                )
            }

            throw StudioASRError(
                kind: "decode_failed",
                message:
                    "ffmpeg could not decode '\(fileURL.lastPathComponent)' (\(describedFormat)): "
                    + (ffmpegDiagnostics.isEmpty ? "exit code \(decodeResult.exitCode)" : ffmpegDiagnostics)
            )
        }

        let rawFloatData = decodeResult.standardOutput
        guard !rawFloatData.isEmpty else {
            throw StudioASRError(
                kind: "no_audio",
                message:
                    "'\(fileURL.lastPathComponent)' (\(describedFormat)) decoded to zero audio samples — "
                    + "it has no usable audio stream."
            )
        }

        let floatSampleCount = rawFloatData.count / MemoryLayout<Float>.size
        let monoSamples: [Float] = rawFloatData.withUnsafeBytes { rawBufferPointer in
            let floatPointer = rawBufferPointer.bindMemory(to: Float.self)
            return Array(UnsafeBufferPointer(start: floatPointer.baseAddress, count: floatSampleCount))
        }

        return DecodedAudio(
            monoSamples: monoSamples,
            containerReportedDurationSeconds: containerReportedDurationSeconds.flatMap {
                $0.isFinite && $0 > 0 ? $0 : nil
            },
            decoderName: "ffmpeg"
        )
    }

    // MARK: - Subprocess helpers

    private struct ProcessOutput {
        let exitCode: Int32
        let standardOutput: Data
        let standardError: Data
    }

    private static func locateExecutable(named executableName: String) -> URL? {
        var candidateDirectories = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        if let pathEnvironmentVariable = ProcessInfo.processInfo.environment["PATH"] {
            candidateDirectories.append(contentsOf: pathEnvironmentVariable.split(separator: ":").map(String.init))
        }

        for candidateDirectory in candidateDirectories {
            let candidateURL = URL(fileURLWithPath: candidateDirectory).appendingPathComponent(executableName)
            if FileManager.default.isExecutableFile(atPath: candidateURL.path) {
                return candidateURL
            }
        }
        return nil
    }

    private static func runProcessCapturingOutput(executableURL: URL, arguments: [String]) -> ProcessOutput {
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments

        let standardOutputPipe = Pipe()
        let standardErrorPipe = Pipe()
        process.standardOutput = standardOutputPipe
        process.standardError = standardErrorPipe

        // Both pipes must be drained concurrently with the process running,
        // otherwise a large decode (tens of MB of PCM) deadlocks on a full pipe.
        let collectedOutput = CollectedProcessOutput()
        let outputCollectionGroup = DispatchGroup()

        do {
            try process.run()
        } catch {
            return ProcessOutput(
                exitCode: -1,
                standardOutput: Data(),
                standardError: Data("failed to launch \(executableURL.path): \(error.localizedDescription)".utf8)
            )
        }

        outputCollectionGroup.enter()
        DispatchQueue.global().async {
            collectedOutput.setStandardOutput(standardOutputPipe.fileHandleForReading.readDataToEndOfFile())
            outputCollectionGroup.leave()
        }
        outputCollectionGroup.enter()
        DispatchQueue.global().async {
            collectedOutput.setStandardError(standardErrorPipe.fileHandleForReading.readDataToEndOfFile())
            outputCollectionGroup.leave()
        }

        process.waitUntilExit()
        outputCollectionGroup.wait()

        return ProcessOutput(
            exitCode: process.terminationStatus,
            standardOutput: collectedOutput.standardOutput,
            standardError: collectedOutput.standardError
        )
    }
}

/// Thread-safe collector for the two pipes drained on background queues.
private final class CollectedProcessOutput: @unchecked Sendable {
    private let accessLock = NSLock()
    private var standardOutputStorage = Data()
    private var standardErrorStorage = Data()

    func setStandardOutput(_ data: Data) {
        accessLock.lock()
        standardOutputStorage = data
        accessLock.unlock()
    }

    func setStandardError(_ data: Data) {
        accessLock.lock()
        standardErrorStorage = data
        accessLock.unlock()
    }

    var standardOutput: Data {
        accessLock.lock()
        defer { accessLock.unlock() }
        return standardOutputStorage
    }

    var standardError: Data {
        accessLock.lock()
        defer { accessLock.unlock() }
        return standardErrorStorage
    }
}
