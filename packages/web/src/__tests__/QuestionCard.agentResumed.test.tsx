// A background agent's question mirrored into the parent chat: once answered,
// the card says whether the agent has picked the answer up and resumed.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QuestionCard } from '../components/QuestionCard.js';
import { useChatStore, type ChatEventEntry } from '../stores/chatStore.js';

const questions = [
  {
    header: 'Pick',
    question: 'Which one?',
    multiSelect: false,
    options: [
      { label: 'A', description: 'a' },
      { label: 'B', description: 'b' },
    ],
  },
];

const entry: ChatEventEntry = {
  seq: 1,
  kind: 'permission',
  tool: 'AskUserQuestion',
  requestId: 'req-1',
  toolArgs: { questions },
  at: 0,
  permissionDescription: '(from subagent "Next Component") AskUserQuestion',
  permissionResolved: 'approve',
  permissionAnswers: { 'Which one?': 'Other text' },
};

function setStatus(status: 'awaiting-permission' | 'running'): void {
  useChatStore.setState({
    delegateUpdates: { parent: { agent1: { label: 'Next Component', status, since: 0 } } },
  });
}

afterEach(() => {
  cleanup();
  useChatStore.setState({ delegateUpdates: {} });
});

describe('QuestionCard — background agent resumed line', () => {
  it('says the agent is still waiting while its status has not left awaiting-permission', () => {
    setStatus('awaiting-permission');
    render(<QuestionCard entry={entry} onAnswer={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('question-agent-resumed').textContent).toContain('waiting for');
  });

  it('says the agent received the answer once it is running again', () => {
    setStatus('running');
    render(<QuestionCard entry={entry} onAnswer={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('question-agent-resumed').textContent).toContain(
      'Next Component received it and is working',
    );
  });

  it('adds nothing to an ordinary question', () => {
    const { permissionDescription: _d, ...plain } = entry;
    render(<QuestionCard entry={plain} onAnswer={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('question-agent-resumed')).toBeNull();
  });
});
