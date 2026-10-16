// A job's chat key is rendered from Mustache before any prompt is, so the
// "no HTML escaping" setting has to be in force the moment the dispatcher is
// loaded — not only after the first prompt render. Otherwise the first keyed
// fire after a restart slugs `Fix A/B & C` as `Fix-A-x2F-B-amp-C` and every
// later fire as `Fix-A-B-C`: two different chats for one subject.

import { describe, it, expect } from 'vitest';
import Mustache from 'mustache';
import '../src/jobs/dispatcher.js';

describe('dispatcher Mustache setup', () => {
  it('does not HTML-escape rendered values, even before any prompt has been rendered', () => {
    expect(Mustache.render('{{task}}', { task: 'Fix A/B & C <x> "y" \'z\'' })).toBe(
      'Fix A/B & C <x> "y" \'z\'',
    );
  });
});
