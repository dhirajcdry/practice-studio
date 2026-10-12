import Foundation
import WhisperKit

/// Remove only explicit Whisper artifacts, never dictated capitalization or prose.
enum WhisperTranscript {
    private static let artifacts = try! NSRegularExpression(
        pattern: #"<\|[^|]*\|>|[\[(]\s*(?:blank_audio|no audio|silence|music|upbeat music|background music|inaudible|noise|applause|laughter)\s*[\])]"#,
        options: [.caseInsensitive])

    static func clean(_ raw: String) -> String {
        artifacts.stringByReplacingMatches(in: raw, range: NSRange(raw.startIndex..., in: raw), withTemplate: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func words(_ timings: [WordTiming]) -> [WordTiming] {
        // Match across words too, since e.g. [BLANK_AUDIO] may span tokens.
        let raw = timings.map(\.word).joined()
        let removed = artifacts.matches(in: raw, range: NSRange(raw.startIndex..., in: raw)).map(\.range)
        var offset = 0
        return timings.compactMap { timing in
            let range = NSRange(location: offset, length: (timing.word as NSString).length)
            offset += range.length
            guard !removed.contains(where: { NSIntersectionRange($0, range).length > 0 }) else { return nil }
            let word = timing.word.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !word.isEmpty else { return nil }
            return WordTiming(word: word, tokens: timing.tokens, start: timing.start, end: timing.end, probability: timing.probability)
        }
    }
}
