import { describe, expect, it } from 'vitest';
import { modelHint, recommendedModels } from '../routes/WelcomeRoute.js';

const m = (id: string) => ({ id, label: id });

describe('recommendedModels', () => {
  it('shows the newest of each family first, Sonnet as the default, the rest behind More', () => {
    const { recommended, rest, def } = recommendedModels([
      m('claude-opus-5'),
      m('claude-sonnet-5'),
      m('claude-haiku-5'),
      m('claude-opus-4-1'),
      m('claude-sonnet-4-5'),
    ]);
    expect(recommended.map((x) => x.id)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-haiku-5',
    ]);
    expect(rest.map((x) => x.id)).toEqual(['claude-opus-4-1', 'claude-sonnet-4-5']);
    expect(def?.id).toBe('claude-sonnet-5');
  });

  it('describes each Claude family in a line', () => {
    expect(modelHint('claude-opus-5')).toMatch(/expensive/);
    expect(modelHint('claude-haiku-5')).toMatch(/cheapest/);
    expect(modelHint('openai/gpt-5.2')).toBeUndefined();
  });
});
