// Acceptance tests for the budgeted provider-switch handoff, wired through
// Daemon (spec/04 § Provider switches — Handoff budget). The planning core is
// covered in handoffPlan.test.ts; these pin the end-to-end behaviour the
// wiring must deliver. Written as todos until chatRunner calls `planHandoff`;
// each becomes a real test using the mocks in provider-switch-native-cache.test.ts.
import { describe, it } from 'vitest';

describe('long cross-provider handoff (Claude ~888k → openai/gpt-6-astra)', () => {
  it.todo(
    'first request sent to the target is under its available input; no context_length_exceeded',
  );
  it.todo('the latest user message reaches the target byte-identical as the turn input');
  it.todo('the target request carries the ledger block naming the chat id and omitted seq range');
  it.todo('the target can read an omitted seq range through patch_history without replay');
  it.todo('events.jsonl is byte-identical before and after the switch except appended records');
  it.todo(
    'after the first target reply a handoff.verified record holds the reported input tokens and the instruction hash',
  );
  it.todo('the transcript divider shows carried vs omitted counts');
});

describe('source provider unavailable or rate limited', () => {
  it.todo(
    'Claude backend errors on every call: the switch still completes from the deterministic ledger',
  );
  it.todo('the divider states that no model-written summary was available, and why');
  it.todo(
    'an explicit compact-with-summary switch with the source down fails loudly with no session change',
  );
});

describe('oversized first request and retry', () => {
  it.todo(
    'target window smaller than ledger + instruction: fails before any request, history untouched, chat stays on the source model',
  );
  it.todo(
    'a 400 context_length_exceeded triggers exactly one tighter re-plan, not a resend of the same request',
  );
  it.todo(
    'two consecutive overflows end in a visible error offering retry, switch back, and linked fresh chat',
  );
  it.todo(
    'a retried switch delivers the pending user message once (same handoff key, no duplicate log record)',
  );
  it.todo('no tool call executes before the target has accepted the request');
});

describe('recovery', () => {
  it.todo('after a failed switch, switching back resumes the source session with only the delta');
  it.todo('a linked fresh chat is seeded with the same handoff and records continuedFrom');
  it.todo(
    'host restart mid-handoff resumes from the persisted planned/sent state without re-sending',
  );
});
