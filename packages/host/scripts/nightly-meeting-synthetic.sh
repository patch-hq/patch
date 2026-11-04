#!/usr/bin/env bash
# Nightly run of test/meeting-synthetic.real.test.ts: real Kokoro audio through
# real Groq STT, and a saved transcript through the real analysis model. It
# spends money, so it is scheduled (not in the PR gate). Run on a host that has
# Kokoro installed. Keys come from the environment (GROQ_API_KEY,
# CLAUDE_CODE_OAUTH_TOKEN); a missing one skips that half loudly in the report.
set -euo pipefail
cd "$(dirname "$0")/.."
PATCH_SYNTHETIC_MEETING=1 exec pnpm exec vitest run test/meeting-synthetic.real.test.ts --retry=0 "$@"
