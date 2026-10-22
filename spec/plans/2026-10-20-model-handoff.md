# Reliable model handoff for long chats

Task: switching chat 01M4XMY8HPWEZWG819QW9QCY15 (about 888k tokens of Claude context) to `openai/gpt-6-astra` failed with `context_length_exceeded`, on both the first attempt and the retry.

## Root cause

A cross-provider switch reconstructs the entire track as a native session on the target (`planHarnessReconstruction`). Nothing compares that to the target's window, so a long chat produces an impossible request. The retry rebuilds the identical request. The only smaller path ("switch and compact") is API-only, needs the source provider to be reachable and write a summary, and still has no budget check.

## Design

1. **Budget first.** Available input = target window − instructions − tool schemas − output headroom − 5% margin, from the model catalogue. Estimates are inflated 25% before comparing. A handoff may fill 60% of the available input, leaving room for the turn to grow.
2. **Deterministic ledger, built from Patch's own log.** Files changed, validation commands and whether they passed, open todos, permission mode, branch, and the source chat id with the seq range left behind. No model call, so it works with the source provider down or rate limited. A model-written narrative is added only when available, and the divider says when it was not.
3. **Recent window.** Whole track if it fits; otherwise the widest verbatim window (400/120/40/12 entries, starting at a user turn so no tool result loses its call) that fits with the ledger; otherwise ledger alone.
4. **Latest instruction is never summarised or trimmed.** It is the turn's own input. If it cannot fit, the switch is refused.
5. **Older history on demand.** The ledger names the chat id and omitted seq range; the target reads them with `patch_history`. Patch's log is the record and is never rewritten.
6. **Preflight, not hope.** The assembled request is estimated before sending. Over budget → refuse with a plain message, nothing sent, chat stays on the source model.
7. **Overflow retry re-plans.** On `context_length_exceeded` the host re-plans once at half the previous size (or half the reported limit); never resends the same request. A second overflow ends in a visible error.
8. **No duplicate side effects.** Each handoff has a key (chat, branch, from-seq, target model) and a persisted state (planned → sent → confirmed). A retry reuses the key; the pending user message is logged and delivered once. A 400 before any output means no tool ran, so re-planning is safe; failure after output began is surfaced, not resent.
9. **Recovery.** A failed switch leaves the source session id in `harnessSessions`; Switch back resumes it with only the delta. Offers on error: Retry, Switch back, Continue in a linked fresh chat.
10. **Verification.** After the first target reply the host records `handoff.verified`: reply received, reported input tokens against the estimate (flagged if more than 2× off), and a hash of the instruction as delivered.

## Same chat vs linked fresh chat

Same chat is the default: one history, one place, the divider marks the switch. A linked fresh chat (seeded with the same handoff, `continuedFrom` pointing back) is offered when the target is too small for even the ledger, when the user wants a clean context, or after two failed attempts. The old chat stays intact either way.

## User-visible states

Divider stages: "Preparing handoff (~38k of 190k)", "Sent to <model>", "Continued — carried 120 of 4,100 entries; older history readable on demand". Errors are plain and carry the recovery actions above.

## Alternatives

| Option                                                                 | Verdict                                                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Truncate oldest history                                                | Rejected: silent loss, no pointer back.                                                                           |
| Full reconstruction (today)                                            | Fails past the target window.                                                                                     |
| Source model writes a summary (today's compact)                        | Needs the source up; reads 888k of cache; summary can drop the last instruction. Kept only as optional narrative. |
| Linked fresh chat only                                                 | Loses continuity and the in-chat divider. Offered as recovery.                                                    |
| Deterministic ledger + recent window + on-demand history (recommended) | Works offline from the source, bounded, auditable.                                                                |

## Implementation plan

1. Done here: `packages/host/src/handoffPlan.ts` (budget, ledger, windowing, overflow re-plan, key) with unit tests.
2. Wire into `runQuery`'s switch block: read window/instructions/tools/output from the catalogue and request builder, call `planHandoff`, replace `planHarnessReconstruction`'s track with the plan's, persist handoff state, add the narrative only if `generateDigest` succeeds.
3. Overflow handling in the Codex backend error path: one re-plan, then error.
4. Divider and error copy in the web and mobile surfaces; linked-chat action.
5. `handoff.verified` record.

## Acceptance tests

Unit (passing): `handoffPlan.test.ts`. End-to-end (listed as todos, to become real as step 2–5 land): `handoff-acceptance.test.ts` — long cross-provider handoff, source unavailable, oversized first request and retry, recovery.
