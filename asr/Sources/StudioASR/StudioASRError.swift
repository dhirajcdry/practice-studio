import Foundation

/// Every failure path in `studio-asr` funnels through this type so the caller
/// always receives a machine-readable `{"error":{"kind":...,"message":...}}`
/// document on stderr and a non-zero exit code — never a partial stdout JSON.
struct StudioASRError: Error {
    /// Stable machine-readable category. The Node server switches on this.
    /// Known kinds:
    ///   - `bad_usage`          — command line arguments were wrong
    ///   - `input_not_found`    — the --input path does not exist / is unreadable
    ///   - `unsupported_format` — container could not be decoded by any available decoder
    ///   - `decode_failed`      — the container was recognised but decoding failed
    ///   - `no_audio`           — no audio track at all, or the audio is pure silence
    ///   - `audio_too_short`    — decodable audio shorter than the model's minimum window
    ///   - `empty_transcript`   — audio had signal but the model produced no words
    ///   - `model_unavailable`  — the Parakeet model could not be downloaded or loaded
    ///   - `transcription_failed` — the model threw while transcribing
    let kind: String
    let message: String

    init(kind: String, message: String) {
        self.kind = kind
        self.message = message
    }
}

enum StudioASRErrorReporter {
    /// Writes the error document to stderr. Deliberately hand-rolled rather
    /// than `JSONEncoder`-based so that reporting an error can never itself
    /// fail and leave the caller with no diagnostic at all.
    static func writeErrorDocumentToStandardError(_ error: StudioASRError) {
        let errorDocument: [String: Any] = [
            "error": [
                "kind": error.kind,
                "message": error.message,
            ]
        ]

        let serializedDocument: Data
        if let jsonData = try? JSONSerialization.data(withJSONObject: errorDocument, options: [.sortedKeys]) {
            serializedDocument = jsonData
        } else {
            let escapedMessage = error.message
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            serializedDocument = Data(
                "{\"error\":{\"kind\":\"\(error.kind)\",\"message\":\"\(escapedMessage)\"}}".utf8
            )
        }

        FileHandle.standardError.write(serializedDocument)
        FileHandle.standardError.write(Data("\n".utf8))
    }
}

/// All human-facing progress/diagnostic chatter goes to stderr so stdout stays
/// a single clean JSON document that the caller can parse directly.
enum StandardErrorLog {
    static func write(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
