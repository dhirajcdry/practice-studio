#!/bin/bash
#
# End-to-end fixture tests for studio-asr.
#
# Generates its own fixtures with `say` + ffmpeg (nothing is committed, nothing
# leaves the machine), then asserts the real binary's behaviour on each one.
#
#   ./Tests/run-fixture-tests.sh            # build (release) then test
#   SKIP_BUILD=1 ./Tests/run-fixture-tests.sh
#
# A regular XCTest target is deliberately not used: every meaningful assertion
# here is about the *process contract* (exit code, stdout being exactly one JSON
# document, stderr carrying the error document), which only a subprocess test
# can actually verify.

set -uo pipefail

PACKAGE_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY_PATH="$PACKAGE_DIRECTORY/.build/release/studio-asr"
FIXTURE_DIRECTORY="$PACKAGE_DIRECTORY/.fixtures"

passedTestCount=0
failedTestCount=0

fail() {
    echo "  FAIL: $1"
    failedTestCount=$((failedTestCount + 1))
}

pass() {
    echo "  ok: $1"
    passedTestCount=$((passedTestCount + 1))
}

require_tool() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "This test script requires '$1' on PATH." >&2
        exit 2
    fi
}

require_tool ffmpeg
require_tool ffprobe
require_tool python3

# ---------------------------------------------------------------- build

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    echo "Building studio-asr (release)..."
    (cd "$PACKAGE_DIRECTORY" && swift build -c release) || exit 2
fi
[[ -x "$BINARY_PATH" ]] || { echo "Missing binary at $BINARY_PATH" >&2; exit 2; }

# ---------------------------------------------------------------- fixtures

if [[ ! -f "$FIXTURE_DIRECTORY/.generated" ]]; then
    echo "Generating fixtures in ${FIXTURE_DIRECTORY}..."
    rm -rf "$FIXTURE_DIRECTORY"
    mkdir -p "$FIXTURE_DIRECTORY"
    pushd "$FIXTURE_DIRECTORY" >/dev/null || exit 2

    say -o short.aiff "The quick brown fox jumps over the lazy dog."
    say -o long.aiff "Today we are going to solve two sum. Given an array of integers and a target value, return the indices of the two numbers that add up to the target. The brute force approach checks every pair, which takes quadratic time. A hash map lets us do it in linear time by remembering the complement of each number as we scan. Let us walk through an example together, step by step, and see how the hash map evolves."

    # Speech, in each container the server will realistically receive.
    ffmpeg -v error -y -i short.aiff -ar 16000 -ac 1 short_speech.wav
    ffmpeg -v error -y -i short.aiff -c:a libopus -ar 48000 -ac 1 short_speech.webm
    ffmpeg -v error -y -i short.aiff -c:a aac -b:a 96k short_speech.m4a
    ffmpeg -v error -y -f lavfi -i color=c=blue:s=320x240:d=6 -i short.aiff \
        -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest speech_with_video.mov

    # Longer than the model's 15s window, to exercise chunked transcription.
    ffmpeg -v error -y -i long.aiff -ar 16000 -ac 1 long_speech.wav

    # Real speech recorded very quietly — must NOT be mistaken for silence.
    ffmpeg -v error -y -i short_speech.wav -af "volume=-40dB" quiet_speech.wav

    # Failure fixtures.
    ffmpeg -v error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 5 silent.wav
    ffmpeg -v error -y -f lavfi -i "anoisesrc=d=6:c=pink:a=0.05:r=16000" -ac 1 noise_only.wav
    ffmpeg -v error -y -f lavfi -i testsrc=s=320x240:d=5:r=15 -c:v libx264 -pix_fmt yuv420p -an no_audio_video.mov
    ffmpeg -v error -y -f lavfi -i testsrc=s=320x240:d=5:r=15 -c:v libvpx-vp9 -b:v 200k -an no_audio_video.webm
    head -c 4096 /dev/urandom > corrupt.wav

    rm -f short.aiff long.aiff
    touch .generated
    popd >/dev/null || exit 2
fi

# ---------------------------------------------------------------- helpers

standardOutputFile="$(mktemp)"
standardErrorFile="$(mktemp)"
trap 'rm -f "$standardOutputFile" "$standardErrorFile"' EXIT

run_binary() {
    "$BINARY_PATH" --input "$1" --json >"$standardOutputFile" 2>"$standardErrorFile"
    echo $?
}

# assert_transcribes <fixture> <expected substring> <min duration> <max duration>
assert_transcribes() {
    local fixtureName="$1" expectedSubstring="$2" minimumDuration="$3" maximumDuration="$4"
    echo "$fixtureName"
    local exitCode
    exitCode="$(run_binary "$FIXTURE_DIRECTORY/$fixtureName")"

    [[ "$exitCode" == "0" ]] || { fail "expected exit 0, got $exitCode ($(cat "$standardErrorFile"))"; return; }
    pass "exit code 0"

    python3 - "$standardOutputFile" "$expectedSubstring" "$minimumDuration" "$maximumDuration" <<'PYTHON'
import json, sys
outputPath, expectedSubstring, minimumDuration, maximumDuration = sys.argv[1:5]
raw = open(outputPath).read()
# json.loads is strict: any stray byte on stdout (e.g. CoreML's E5RT chatter)
# makes this raise, which is exactly the regression we want to catch.
document = json.loads(raw)
problems = []
for requiredKey in ("text", "words", "durationSeconds", "modelId"):
    if requiredKey not in document:
        problems.append(f"missing key {requiredKey!r}")
if expectedSubstring.lower() not in document.get("text", "").lower():
    problems.append(f"transcript {document.get('text')!r} does not contain {expectedSubstring!r}")
duration = document.get("durationSeconds", -1)
if not (float(minimumDuration) <= duration <= float(maximumDuration)):
    problems.append(f"durationSeconds {duration} outside [{minimumDuration}, {maximumDuration}]")
words = document.get("words", [])
if not words:
    problems.append("word timings are empty")
else:
    if not all(w["start"] <= w["end"] for w in words):
        problems.append("a word has start > end")
    if words[-1]["end"] > duration + 1.0:
        problems.append(f"last word ends at {words[-1]['end']} beyond duration {duration}")
    if any(w["end"] > 0 for w in words) is False:
        problems.append("all word timings are zero")
for problem in problems:
    print(f"  FAIL: {problem}")
sys.exit(1 if problems else 0)
PYTHON
    if [[ $? -eq 0 ]]; then
        pass "stdout is exactly one valid JSON document with a correct transcript, duration and word timings"
    else
        failedTestCount=$((failedTestCount + 1))
    fi
}

# assert_fails <fixture> <expected error kind>
assert_fails() {
    local fixtureName="$1" expectedKind="$2"
    echo "$fixtureName"
    local exitCode
    exitCode="$(run_binary "$FIXTURE_DIRECTORY/$fixtureName")"

    [[ "$exitCode" != "0" ]] || { fail "expected a non-zero exit code, got 0"; return; }
    pass "non-zero exit code ($exitCode)"

    if [[ -s "$standardOutputFile" ]]; then
        fail "stdout must be empty on failure, got: $(cat "$standardOutputFile")"
    else
        pass "stdout is empty"
    fi

    local actualKind
    actualKind="$(grep -o '"kind":"[^"]*"' "$standardErrorFile" | head -1 | cut -d'"' -f4)"
    if [[ "$actualKind" == "$expectedKind" ]]; then
        pass "stderr error kind is '$expectedKind'"
        echo "     $(grep -o '"message":"[^"]*"' "$standardErrorFile" | head -1 | cut -d'"' -f4)"
    else
        fail "expected error kind '$expectedKind', got '${actualKind:-<none>}' — $(cat "$standardErrorFile")"
    fi
}

# ---------------------------------------------------------------- tests

echo
echo "### speech transcribes correctly, in every container"
assert_transcribes short_speech.wav       "quick brown fox" 2.5 3.2
assert_transcribes short_speech.webm      "quick brown fox" 2.5 3.2
assert_transcribes short_speech.m4a       "quick brown fox" 2.5 3.2
assert_transcribes speech_with_video.mov  "quick brown fox" 2.5 3.2

echo
echo "### >15s audio: chunked path, duration must come from the container (not ASRResult.duration, which reads 0)"
assert_transcribes long_speech.wav "hash map" 24.0 27.0

echo
echo "### very quiet real speech must NOT be misread as silence"
assert_transcribes quiet_speech.wav "quick brown fox" 2.5 3.2

echo
echo "### no audio / silence must be loud, explicit failures"
assert_fails no_audio_video.mov  no_audio
assert_fails no_audio_video.webm no_audio
assert_fails silent.wav          no_audio

echo
echo "### audible but speechless audio must fail rather than return an empty transcript"
assert_fails noise_only.wav empty_transcript

echo
echo "### undecodable input names the problem"
assert_fails corrupt.wav decode_failed

echo
echo "### missing input"
echo "missing.wav"
exitCode="$(run_binary "$FIXTURE_DIRECTORY/definitely-missing.wav")"
[[ "$exitCode" != "0" ]] && pass "non-zero exit code" || fail "expected non-zero exit"
grep -q '"kind":"input_not_found"' "$standardErrorFile" \
    && pass "stderr error kind is 'input_not_found'" \
    || fail "expected input_not_found, got $(cat "$standardErrorFile")"

echo
echo "======================================"
echo "passed: $passedTestCount   failed: $failedTestCount"
[[ "$failedTestCount" -eq 0 ]] || exit 1
