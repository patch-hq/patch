// The built-in principles prompt a Manager sweep run uses (spec/06 § The
// sweep). Shared between the server (which stores it as the setting's
// default) and the web Settings page (which needs the same text to offer
// "Reset to default" without the server round-tripping it first).
//
// This is where the sweep's judgement lives: which questions the Manager may
// answer for Tom. It ships with no principles, so by default every question
// goes in the digest. The reply format is not part of it — the host appends
// that to every run (`managerSweepGen.ts`), so editing this cannot break it.
export const DEFAULT_SWEEP_PROMPT = `You are the Manager, looking at chats that have just gone idle. For each one, read its last message.

If it ends by asking a question, answer it only when one of the principles below covers it. Otherwise do not answer: state the question in one plain line so it can go in Tom's digest.

If it does not end by asking a question, leave it.

Principles — the questions you may answer for Tom, and what to say. One per line, for example:
- Asked whether to carry on with the next step of a plan already agreed: "Yes, carry on."
- Asked whether to run the tests first: "Run the tests first."

(No principles yet. Add them here.)`;
