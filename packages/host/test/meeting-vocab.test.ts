import { describe, expect, it } from 'vitest';
import {
  glossaryTerm,
  learnedTerms,
  termsFromTranscript,
  vocabularyPrompt,
} from '../src/meetingVocab.js';

describe('learnedTerms', () => {
  it('picks out an acronym the clean-up pass fixed', () => {
    expect(learnedTerms('the weka board agreed', 'the WECA board agreed')).toEqual(['WECA']);
  });
  it('keeps a multi-word place name together', () => {
    expect(learnedTerms('over in south glove next year', 'over in South Glos next year')).toEqual([
      'South Glos',
    ]);
  });
  it('ignores a line that was not changed and changes that are not names', () => {
    expect(learnedTerms('hello there', 'hello there')).toEqual([]);
    expect(learnedTerms('we was late', 'we were late')).toEqual([]);
  });
  it('counts a case-only fix as a correction', () => {
    expect(learnedTerms('the xyz fund', 'the XYZ fund')).toEqual(['XYZ']);
  });
});

describe('termsFromTranscript', () => {
  it('keeps acronyms and repeated mid-sentence names, not sentence openers', () => {
    const terms = termsFromTranscript([
      'Thanks for joining. We met Marlow Quay about the ABC1 grant.',
      'Later Marlow Quay agreed. Then we spoke.',
    ]);
    expect(terms).toContain('Marlow Quay');
    expect(terms).toContain('ABC1');
    expect(terms).not.toContain('Thanks');
    expect(terms).not.toContain('Then');
  });
});

describe('vocabularyPrompt', () => {
  const vocab = { learned: ['WECA', 'South Glos'], earlier: ['Marlow Quay'] };
  it('lists participants first, then corrected, glossary and earlier terms', () => {
    const p = vocabularyPrompt({
      names: ['Priya Shah', 'priya shah', 'Dev Rao'],
      vocab,
      glossary: ['CRSTS: crests, crusts'],
    });
    expect(p).toBe(
      'Participants: Priya Shah, Dev Rao. Terms: South Glos, WECA, CRSTS, Marlow Quay.',
    );
  });
  it('is empty when there is nothing to say', () => {
    expect(vocabularyPrompt({ names: [], vocab: { learned: [], earlier: [] }, glossary: [] })).toBe(
      '',
    );
  });
  it('stays within the limit and drops the lowest priority terms first', () => {
    const earlier = Array.from({ length: 200 }, (_, i) => `Term${i}`);
    const p = vocabularyPrompt({
      names: ['Priya Shah'],
      vocab: { learned: ['WECA'], earlier },
      glossary: [],
      maxChars: 80,
    });
    expect(p.length).toBeLessThanOrEqual(80);
    expect(p.startsWith('Participants: Priya Shah. Terms: WECA')).toBe(true);
  });
  it('does not repeat a name as a term', () => {
    const p = vocabularyPrompt({
      names: ['Dev Rao'],
      vocab: { learned: ['dev rao'], earlier: [] },
      glossary: [],
    });
    expect(p).toBe('Participants: Dev Rao.');
  });
});

describe('glossaryTerm', () => {
  it('drops the mishearings', () => {
    expect(glossaryTerm('CRSTS: crests, crusts')).toBe('CRSTS');
  });
});
