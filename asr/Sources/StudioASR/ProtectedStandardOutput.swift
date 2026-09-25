import Foundation

/// Guarantees that stdout contains EXACTLY the one JSON document this tool
/// prints, and nothing else.
///
/// This is not paranoia. Apple's CoreML "E5RT" runtime prints diagnostics such
/// as `E5RT encountered an STL exception. msg = Failed to
/// PropagateInputTensorShapes: ...` straight to file descriptor 1 with C
/// `printf`, bypassing anything we control in Swift. Those lines land after our
/// JSON and make the document unparseable for the Node server that spawns us.
///
/// So: as the very first thing the process does, we duplicate the real stdout
/// to a private descriptor and point fd 1 at stderr. Every stray write from
/// CoreML (or any dependency) becomes harmless stderr noise, and the JSON
/// document is written to the private descriptor at the end.
enum ProtectedStandardOutput {
    /// The real stdout, saved before fd 1 is redirected.
    private nonisolated(unsafe) static var savedStandardOutputDescriptor: Int32 = -1

    /// Must be called before any dependency has a chance to write to stdout.
    static func redirectStrayStandardOutputWritesToStandardError() {
        guard savedStandardOutputDescriptor == -1 else { return }

        let duplicatedDescriptor = dup(STDOUT_FILENO)
        guard duplicatedDescriptor >= 0 else { return }
        savedStandardOutputDescriptor = duplicatedDescriptor

        // Anything that writes to fd 1 from here on shows up on stderr.
        _ = dup2(STDERR_FILENO, STDOUT_FILENO)
    }

    /// Writes the final JSON document to the real stdout.
    static func writeDocument(_ documentData: Data) {
        let destinationDescriptor =
            savedStandardOutputDescriptor >= 0 ? savedStandardOutputDescriptor : STDOUT_FILENO

        var payload = documentData
        payload.append(Data("\n".utf8))

        payload.withUnsafeBytes { rawBufferPointer in
            var bytesRemaining = rawBufferPointer.count
            var writeOffset = 0
            while bytesRemaining > 0 {
                let bytesWritten = write(
                    destinationDescriptor,
                    rawBufferPointer.baseAddress!.advanced(by: writeOffset),
                    bytesRemaining
                )
                if bytesWritten <= 0 { break }
                writeOffset += bytesWritten
                bytesRemaining -= bytesWritten
            }
        }
    }
}
