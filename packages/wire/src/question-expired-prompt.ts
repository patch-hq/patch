// What the agent is told when a question it asked goes unanswered for the
// configured window (spec/02 § Questions are not approvals). `{seconds}` is
// filled in with the window. Shared so Settings can offer "Reset to default"
// without a server round trip.
export const DEFAULT_QUESTION_EXPIRED_PROMPT = `No answer: the question timed out after {seconds} seconds without a reply. The user did not refuse — nobody saw it, and this chat may be unattended. Do not stop here. Do not assume any of the options. Carry on with everything that does not depend on the answer, pick the safest reasonable path where it does and say plainly in your report which assumption you made, and only ask again if the work cannot move without it.`;
