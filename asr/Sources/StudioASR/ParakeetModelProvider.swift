import FluidAudio
import Foundation

/// Loads the on-device Parakeet TDT 0.6B v2 CoreML model from FluidAudio's shared
/// cache directory, so any other FluidAudio app on the machine never downloads a
/// second multi-gigabyte copy.
enum ParakeetModelProvider {

    /// Model version used everywhere in this tool.
    static let modelVersion: AsrModelVersion = .v2

    /// Human/machine readable model identifier echoed back in the JSON output.
    /// This is the Hugging Face repo FluidAudio pulls the CoreML files from.
    static let modelIdentifier = "FluidInference/parakeet-tdt-0.6b-v2-coreml"

    /// FluidAudio 0.15.5 caches this repo in
    /// `~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v2`
    /// — note there is NO `-coreml` suffix on the directory even though the
    /// repo name has one (`Repo.folderName` strips it). Verified against
    /// `Repo.folderName` in FluidAudio's ModelNames.swift.
    static var modelCacheDirectory: URL {
        AsrModels.defaultCacheDirectory(for: modelVersion)
    }

    /// Returns a warm `AsrManager`, downloading the model on first run.
    /// All progress chatter goes to stderr — stdout must stay a clean JSON doc.
    static func makeWarmAsrManager() async throws -> AsrManager {
        let cacheDirectory = modelCacheDirectory

        if !AsrModels.modelsExist(at: cacheDirectory, version: modelVersion) {
            StandardErrorLog.write(
                "studio-asr: Parakeet model not found at \(cacheDirectory.path) — downloading (~600 MB, one time)…"
            )
            do {
                _ = try await AsrModels.download(
                    to: cacheDirectory,
                    version: modelVersion,
                    progressHandler: { downloadProgress in
                        let percentComplete = Int((downloadProgress.fractionCompleted * 100).rounded())
                        let phaseDescription: String
                        switch downloadProgress.phase {
                        case .listing:
                            phaseDescription = "listing files"
                        case .downloading(let completedFiles, let totalFiles):
                            phaseDescription = "downloading \(completedFiles)/\(totalFiles) files"
                        case .compiling(let modelName):
                            phaseDescription = "compiling \(modelName)"
                        }
                        StandardErrorLog.write("studio-asr: model download \(percentComplete)% — \(phaseDescription)")
                    }
                )
            } catch {
                throw StudioASRError(
                    kind: "model_unavailable",
                    message:
                        "Failed to download the Parakeet model (\(modelIdentifier)) to "
                        + "\(cacheDirectory.path): \(error.localizedDescription)"
                )
            }
        }

        do {
            let loadedModels = try await AsrModels.load(from: cacheDirectory, version: modelVersion)
            return AsrManager(config: .default, models: loadedModels)
        } catch {
            throw StudioASRError(
                kind: "model_unavailable",
                message:
                    "Failed to load the Parakeet model (\(modelIdentifier)) from "
                    + "\(cacheDirectory.path): \(error.localizedDescription)"
            )
        }
    }
}
