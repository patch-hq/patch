#!/usr/bin/env bash
# The synthetic meeting test (scripts/meeting-e2e/run.ts), for on demand and the nightly
# Patch job. Run it on the Mac: it needs the Electron shell and the audio helper. It plays
# its own audio into its own hidden Patch, so it is safe to run while the app is in use.
# Prints one line, PASS/FAIL/SKIP meeting-e2e: ..., and exits 0 pass, 1 fail, 2 cannot run.
# Keys come from the environment (CLAUDE_CODE_OAUTH_TOKEN, WHISPER_MODEL_PATH); no paid
# transcription is used.
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm exec tsx scripts/meeting-e2e/run.ts "$@"
