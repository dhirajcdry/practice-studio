import WhisperKit
import Foundation

// MARK: - Output document

/// The single JSON object printed to stdout on success.
private struct TranscriptionDocument: Encodable {
    struct WordEntry: Encodable {
        let word: String
        let start: Double
        let end: Double
    }

    let text: String
    let words: [WordEntry]
    let durationSeconds: Double
    let modelId: String
    /// Only present when there is something the caller should know about
    /// (e.g. word timings were unavailable). Never used to hide a failure.
    let warnings: [String]?
}

// MARK: - Argument parsing

private struct CommandLineOptions {
    let inputFilePath: String
}

private struct WorkerRequest: Decodable { let input: String }

private let usageText = """
usage: studio-asr --input <path> [--json]

Transcribes an audio or video file entirely on-device with WhisperKit
and justwisper's selected Core ML model and prints one JSON object to stdout:

  {"text":"...","words":[{"word":"...","start":0.0,"end":0.12}],
   "durationSeconds":12.3,"modelId":"..."}

Errors are printed to stderr as {"error":{"kind":"...","message":"..."}}
with a non-zero exit code. --json is accepted and is the only output mode.
"""

private func parseCommandLineOptions(_ arguments: [String]) throws -> CommandLineOptions {
    var inputFilePath: String?
    var argumentIndex = arguments.startIndex

    while argumentIndex < arguments.endIndex {
        let argument = arguments[argumentIndex]
        switch argument {
        case "--input", "-i":
            argumentIndex = arguments.index(after: argumentIndex)
            guard argumentIndex < arguments.endIndex else {
                throw StudioASRError(kind: "bad_usage", message: "--input requires a file path.\n\n\(usageText)")
            }
            inputFilePath = arguments[argumentIndex]
        case "--json":
            // JSON is the only output format; the flag exists so callers can be
            // explicit and so the interface can grow other formats later.
            break
        case "--help", "-h":
            throw StudioASRError(kind: "bad_usage", message: usageText)
        default:
            throw StudioASRError(kind: "bad_usage", message: "Unknown argument '\(argument)'.\n\n\(usageText)")
        }
        argumentIndex = arguments.index(after: argumentIndex)
    }

    guard let inputFilePath, !inputFilePath.isEmpty else {
        throw StudioASRError(kind: "bad_usage", message: "--input <path> is required.\n\n\(usageText)")
    }

    return CommandLineOptions(inputFilePath: inputFilePath)
}

// MARK: - Transcription pipeline

/// Anything quieter than -60 dBFS across the WHOLE file is treated as silence.
/// Real recordings — even a quiet room mic — peak far above this; only digital
/// silence or a muted track sits below it.
private let silencePeakAmplitudeThreshold: Float = 0.001

/// Whisper uses 10 ms audio frames; shorter audible inputs cannot form a frame.
private let minimumTranscribableSeconds: Double = 0.01

private func runTranscription(options: CommandLineOptions, loaded: (pipe: WhisperKit, modelId: String)? = nil) async throws -> TranscriptionDocument {
    let fileManager = FileManager.default
    let inputFileURL = URL(fileURLWithPath: (options.inputFilePath as NSString).expandingTildeInPath)
        .standardizedFileURL

    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: inputFileURL.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
        throw StudioASRError(
            kind: "input_not_found",
            message: "No readable file at '\(inputFileURL.path)'."
        )
    }
    guard fileManager.isReadableFile(atPath: inputFileURL.path) else {
        throw StudioASRError(
            kind: "input_not_found",
            message: "File at '\(inputFileURL.path)' exists but is not readable."
        )
    }

    // 1. Decode. Missing audio track fails loudly here.
    let decodedAudio = try await AudioDecoder.decodeToMono16kHz(fileURL: inputFileURL)
    StandardErrorLog.write(
        String(
            format: "studio-asr: decoded %.2fs of audio via %@ (%d samples @ %d Hz)",
            decodedAudio.durationSeconds,
            decodedAudio.decoderName,
            decodedAudio.monoSamples.count,
            AudioDecoder.targetSampleRate
        )
    )

    // 2. Silence check. An all-silent recording must fail, never return "".
    let peakAmplitude = decodedAudio.peakAmplitude
    guard peakAmplitude >= silencePeakAmplitudeThreshold else {
        throw StudioASRError(
            kind: "no_audio",
            message: String(
                format:
                    "'%@' has an audio track but it is silent (peak amplitude %.6f, below the %.4f "
                    + "silence threshold across all %.2fs). Nothing was said — refusing to return an empty transcript.",
                inputFileURL.lastPathComponent,
                peakAmplitude,
                silencePeakAmplitudeThreshold,
                decodedAudio.durationSeconds
            )
        )
    }

    // 3. Length check, so the model's own opaque error never surfaces.
    let decodedSeconds = Double(decodedAudio.monoSamples.count) / Double(AudioDecoder.targetSampleRate)
    guard decodedSeconds >= minimumTranscribableSeconds else {
        throw StudioASRError(
            kind: "audio_too_short",
            message: String(
                format: "'%@' contains only %.3fs of audio; the model needs at least %.3fs.",
                inputFileURL.lastPathComponent,
                decodedSeconds,
                minimumTranscribableSeconds
            )
        )
    }

    // Pad sub-second clips without changing the reported recording duration.
    var samples = decodedAudio.monoSamples
    if samples.count < AudioDecoder.targetSampleRate {
        samples += Array(repeating: 0, count: AudioDecoder.targetSampleRate - samples.count)
    }
    let loadedModel: (pipe: WhisperKit, modelId: String)
    if let loaded {
        loadedModel = loaded
    } else {
        loadedModel = try await WhisperModelProvider.load()
    }
    let started = Date()
    let results: [TranscriptionResult]
    do {
        // justwisper's final pass uses defaults. Only enable word timestamps.
        results = try await loadedModel.pipe.transcribe(audioArray: samples, decodeOptions: DecodingOptions(wordTimestamps: true))
    } catch {
        throw StudioASRError(kind: "transcription_failed",
                            message: "Transcription of '\(inputFileURL.lastPathComponent)' failed: \(error.localizedDescription)")
    }
    let processingTime = Date().timeIntervalSince(started)
    let transcriptText = WhisperTranscript.clean(results.map(\.text).joined(separator: " "))

    // 5. An empty transcript from audible audio is a failure, not a result.
    guard !transcriptText.isEmpty else {
        throw StudioASRError(
            kind: "empty_transcript",
            message: String(
                format:
                    "'%@' had audible signal (peak %.4f over %.2fs) but the model produced no words. "
                    + "The recording may be music, noise, or non-speech.",
                inputFileURL.lastPathComponent,
                peakAmplitude,
                decodedAudio.durationSeconds
            )
        )
    }

    // 6. Word timings from the model's own token timings — never fabricated.
    var warnings: [String] = []
    let wordTimings = results.flatMap { $0.segments }.flatMap { segment in
        WhisperTranscript.words(segment.words ?? [])
    }
    if wordTimings.isEmpty {
        warnings.append(
            "The model returned no token timings for this file, so `words` is empty. "
                + "Word-level timings are unavailable; no timings were fabricated."
        )
    }

    // Duration remains the original container / decoded sample duration.
    StandardErrorLog.write(
        String(
            format: "studio-asr: transcribed in %.2fs (%.0fx realtime), %d words with timings",
            processingTime,
            processingTime > 0
                ? decodedAudio.durationSeconds / processingTime : 0,
            wordTimings.count
        )
    )

    return TranscriptionDocument(
        text: transcriptText,
        words: wordTimings.map {
            TranscriptionDocument.WordEntry(word: $0.word, start: Double($0.start), end: Double($0.end))
        },
        durationSeconds: decodedAudio.durationSeconds,
        modelId: loadedModel.modelId,
        warnings: warnings.isEmpty ? nil : warnings
    )
}

private func writeWorkerDocument<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(value)
    ProtectedStandardOutput.writeDocument(data)
}

private func runWorker() async {
    do {
        let loaded = try await WhisperModelProvider.load()
        StandardErrorLog.write("studio-asr: worker ready (model \(loaded.modelId))")
        while let line = readLine() {
            guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            do {
                let request = try JSONDecoder().decode(WorkerRequest.self, from: Data(line.utf8))
                let document = try await runTranscription(
                    options: CommandLineOptions(inputFilePath: request.input), loaded: loaded
                )
                try writeWorkerDocument(document)
            } catch let error as StudioASRError {
                try? writeWorkerDocument(["error": ["kind": error.kind, "message": error.message]])
            } catch {
                try? writeWorkerDocument(["error": ["kind": "internal_error", "message": error.localizedDescription]])
            }
        }
    } catch let error as StudioASRError {
        StudioASRErrorReporter.writeErrorDocumentToStandardError(error)
        exit(1)
    } catch {
        StudioASRErrorReporter.writeErrorDocumentToStandardError(
            StudioASRError(kind: "model_unavailable", message: error.localizedDescription)
        )
        exit(1)
    }
}

// MARK: - Entry point

// FIRST statement the process runs: take stdout away from CoreML and friends
// so no stray native `printf` can corrupt the JSON document. See
// ProtectedStandardOutput for why this is necessary.
ProtectedStandardOutput.redirectStrayStandardOutputWritesToStandardError()

// Top-level `await` in main.swift keeps the async pipeline straightforward.
do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments.first == "--worker" {
        await runWorker()
        exit(0)
    }
    let options = try parseCommandLineOptions(arguments)
    let document = try await runTranscription(options: options)

    // Encode fully before writing a single byte, so stdout can never contain a
    // partial JSON document if encoding somehow fails.
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let encodedDocument = try encoder.encode(document)

    ProtectedStandardOutput.writeDocument(encodedDocument)
    exit(0)
} catch let studioError as StudioASRError {
    StudioASRErrorReporter.writeErrorDocumentToStandardError(studioError)
    exit(1)
} catch {
    StudioASRErrorReporter.writeErrorDocumentToStandardError(
        StudioASRError(kind: "internal_error", message: error.localizedDescription)
    )
    exit(1)
}
