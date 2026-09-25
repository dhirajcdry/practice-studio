import FluidAudio
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

private let usageText = """
usage: studio-asr --input <path> [--json]

Transcribes an audio or video file entirely on-device with the Parakeet
TDT 0.6B v2 CoreML model and prints one JSON object to stdout:

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

/// FluidAudio rejects clips shorter than this outright (ASRError.invalidAudioData).
private let minimumTranscribableSeconds: Double = 0.3

private func runTranscription(options: CommandLineOptions) async throws -> TranscriptionDocument {
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
                format: "'%@' contains only %.3fs of audio; the model needs at least %.1fs.",
                inputFileURL.lastPathComponent,
                decodedSeconds,
                minimumTranscribableSeconds
            )
        )
    }

    // 4. Load the model (downloading on first run) and transcribe.
    let asrManager = try await ParakeetModelProvider.makeWarmAsrManager()

    var decoderState = TdtDecoderState.make()
    let transcriptionResult: ASRResult
    do {
        transcriptionResult = try await asrManager.transcribe(decodedAudio.monoSamples, decoderState: &decoderState)
    } catch ASRError.invalidAudioData {
        throw StudioASRError(
            kind: "no_audio",
            message:
                "The model rejected the audio in '\(inputFileURL.lastPathComponent)' as unusable "
                + "(too short or not speech-like)."
        )
    } catch {
        throw StudioASRError(
            kind: "transcription_failed",
            message: "Transcription of '\(inputFileURL.lastPathComponent)' failed: \(error.localizedDescription)"
        )
    }

    let transcriptText = transcriptionResult.text.trimmingCharacters(in: .whitespacesAndNewlines)

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
    let tokenTimings = transcriptionResult.tokenTimings ?? []
    let wordTimings = buildWordTimings(from: tokenTimings)
    if wordTimings.isEmpty {
        warnings.append(
            "The model returned no token timings for this file, so `words` is empty. "
                + "Word-level timings are unavailable; no timings were fabricated."
        )
    }

    // 7. Duration ALWAYS from the container / decoded samples.
    //    FluidAudio's chunked (>15s) path returns `duration == 0` and `rtfx == 0`
    //    because it builds its ASRResult with an empty sample array, so that
    //    field is unusable exactly where it matters most.
    if transcriptionResult.duration == 0 {
        StandardErrorLog.write(
            "studio-asr: note — ASRResult.duration was 0 (known FluidAudio chunked-path bug); "
                + String(format: "using container duration %.2fs instead.", decodedAudio.durationSeconds)
        )
    }

    StandardErrorLog.write(
        String(
            format: "studio-asr: transcribed in %.2fs (%.0fx realtime), %d words with timings",
            transcriptionResult.processingTime,
            transcriptionResult.processingTime > 0
                ? decodedAudio.durationSeconds / transcriptionResult.processingTime : 0,
            wordTimings.count
        )
    )

    return TranscriptionDocument(
        text: transcriptText,
        words: wordTimings.map {
            TranscriptionDocument.WordEntry(word: $0.word, start: $0.startTime, end: $0.endTime)
        },
        durationSeconds: decodedAudio.durationSeconds,
        modelId: ParakeetModelProvider.modelIdentifier,
        warnings: warnings.isEmpty ? nil : warnings
    )
}

// MARK: - Entry point

// FIRST statement the process runs: take stdout away from CoreML and friends
// so no stray native `printf` can corrupt the JSON document. See
// ProtectedStandardOutput for why this is necessary.
ProtectedStandardOutput.redirectStrayStandardOutputWritesToStandardError()

// Top-level `await` in main.swift keeps the async pipeline straightforward.
do {
    let options = try parseCommandLineOptions(Array(CommandLine.arguments.dropFirst()))
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
