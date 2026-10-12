import XCTest
import WhisperKit
@testable import StudioASR

final class WhisperTests: XCTestCase {
    func testSelectionPrecedence() {
        XCTAssertEqual(WhisperModelProvider.selection(environment: [:], preference: nil).model, "small.en")
        XCTAssertEqual(WhisperModelProvider.selection(environment: [:], preference: "base.en").reason, "justwisper pref")
        XCTAssertEqual(WhisperModelProvider.selection(environment: ["STUDIO_ASR_MODEL": "tiny.en"], preference: "base.en").model, "tiny.en")
    }

    func testExactCompleteCache() throws {
        let root = URL(fileURLWithPath: "/tmp/studio-asr-cache-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("models/argmaxinc/whisperkit-coreml/openai_whisper-small.en")
        for component in ["AudioEncoder.mlmodelc", "TextDecoder.mlmodelc"] {
            try FileManager.default.createDirectory(at: folder.appendingPathComponent(component), withIntermediateDirectories: true)
        }
        XCTAssertNil(WhisperModelProvider.cachedFolder(for: "small.en", in: root))
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("MelSpectrogram.mlmodelc"), withIntermediateDirectories: true)
        XCTAssertEqual(WhisperModelProvider.cachedFolder(for: "small.en", in: root)?.path, folder.path)
        XCTAssertNil(WhisperModelProvider.cachedFolder(for: "small", in: root))
        XCTAssertNil(WhisperModelProvider.cachedFolder(for: "../small.en", in: root))
    }

    func testArtifactsAndRealWords() {
        XCTAssertEqual(WhisperTranscript.clean("[BLANK_AUDIO] (music) <|endoftext|>"), "")
        XCTAssertEqual(WhisperTranscript.clean("Use a hash map (O(N))."), "Use a hash map (O(N)).")
        let timings = [WordTiming(word: " use", tokens: [], start: 0.2, end: 0.4, probability: 1)]
        XCTAssertEqual(WhisperTranscript.words(timings).first?.start, 0.2)
        XCTAssertTrue(WhisperTranscript.words([]).isEmpty)
    }
}
