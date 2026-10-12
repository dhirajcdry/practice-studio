import Foundation
import WhisperKit

/// Reuses justwisper's compiled models without giving its cache to a downloader.
enum WhisperModelProvider {
    static func selection(environment: [String: String], preference: String?) -> (model: String, reason: String) {
        if let model = environment["STUDIO_ASR_MODEL"], !model.isEmpty { return (model, "env STUDIO_ASR_MODEL") }
        if let model = preference, !model.isEmpty { return (model, "justwisper pref") }
        return ("small.en", "default")
    }

    // Same exact-name and component checks as justwisper's ModelCache.
    static func cachedFolder(for model: String, in root: URL) -> URL? {
        guard !model.isEmpty, !model.contains("/"), !model.contains("\\") else { return nil }
        return [root.appendingPathComponent("models/argmaxinc/whisperkit-coreml"), root]
            .map { $0.appendingPathComponent("openai_whisper-\(model)", isDirectory: true) }
            .first { folder in
                ["AudioEncoder.mlmodelc", "TextDecoder.mlmodelc", "MelSpectrogram.mlmodelc"].allSatisfy {
                    var directory: ObjCBool = false
                    return FileManager.default.fileExists(atPath: folder.appendingPathComponent($0).path, isDirectory: &directory) && directory.boolValue
                }
            }
    }

    static func load() async throws -> (pipe: WhisperKit, modelId: String) {
        let choice = selection(environment: ProcessInfo.processInfo.environment,
                               preference: UserDefaults(suiteName: "com.justwisper.app")?.string(forKey: "modelName"))
        StandardErrorLog.write("studio-asr: model \(choice.model) (\(choice.reason))")
        guard !choice.model.contains("/"), !choice.model.contains("\\") else {
            throw StudioASRError(kind: "model_unavailable", message: "Invalid Whisper variant: \(choice.model)")
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let wispr = base.appendingPathComponent("Wispr/Models", isDirectory: true)
        let studio = base.appendingPathComponent("PracticeStudio/ASRModels", isDirectory: true)
        let shared = cachedFolder(for: choice.model, in: wispr)
        let cached = shared ?? cachedFolder(for: choice.model, in: studio)
        do {
            let folder: URL
            if let cached { folder = cached } else {
                StandardErrorLog.write("studio-asr: downloading \(choice.model) into \(studio.path)")
                folder = try await WhisperKit.download(variant: choice.model, downloadBase: studio)
            }
            let config = WhisperKitConfig(
                model: choice.model, modelFolder: folder.path,
                tokenizerFolder: studio.appendingPathComponent("Tokenizers", isDirectory: true),
                prewarm: cached == nil || !["tiny.en", "base.en", "small.en"].contains(choice.model),
                load: false, download: false
            )
            let loadStarted = Date()
            let pipe = try await StudioWhisperKit(config)
            if shared != nil { pipe.sharedTokenizers = wispr.appendingPathComponent("Tokenizers", isDirectory: true) }
            try await pipe.loadModels()
            StandardErrorLog.write("studio-asr: loaded openai_whisper-\(choice.model) from \(folder.path) (load \(String(format: "%.2f", Date().timeIntervalSince(loadStarted)))s)")
            return (pipe, "openai_whisper-\(choice.model)")
        } catch {
            throw StudioASRError(kind: "model_unavailable", message: "Failed to load/download Whisper \(choice.model): \(error.localizedDescription)")
        }
    }
}

/// WhisperKit 0.18's download:false covers models, not tokenizer fallback.
/// Supply Wispr only as a read-only additional tokenizer search path; the Hub
/// download destination always remains Studio's Tokenizers directory.
private final class StudioWhisperKit: WhisperKit {
    var sharedTokenizers: URL?

    override func loadTokenizerIfNeeded() async throws {
        let originalModelFolder = modelFolder
        defer { modelFolder = originalModelFolder }
        if let sharedTokenizers, let logits = textDecoder.logitsSize, let encoder = audioEncoder.embedSize {
            // WhisperKit 0.18 keeps its variant-to-tokenizer helpers internal.
            // Match its vocabulary/encoder dimension mapping (including large v3).
            let size = [384: "tiny", 512: "base", 768: "small", 1024: "medium"][encoder] ?? "base"
            let variant = logits == 51866 ? "large-v3"
                : logits == 51865 && encoder == 1280 ? "large-v2"
                : size + (logits == 51864 ? ".en" : "")
            let name = "openai/whisper-\(variant)"
            // super uses modelFolder only as an additional tokenizer search path
            // here; the compiled models have already loaded from the real folder.
            modelFolder = sharedTokenizers.appendingPathComponent("models/\(name)")
            StandardErrorLog.write("studio-asr: read-only tokenizer search at \(modelFolder!.path); fallback cache \(tokenizerFolder!.path)")
        }
        try await super.loadTokenizerIfNeeded()
    }
}
