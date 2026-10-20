import { describe, expect, it } from 'vitest';
import { signInQuestion } from '../src/signin-question.js';

describe('signInQuestion', () => {
  it.each([
    ['Chrome on Mac', 'Approve a Patch sign-in from Chrome on a Mac?'],
    ['Firefox on Windows', 'Approve a Patch sign-in from Firefox on a Windows PC?'],
    ['Chrome on Linux', 'Approve a Patch sign-in from Chrome on a Linux PC?'],
    ['Chrome on Android', 'Approve a Patch sign-in from Chrome on an Android device?'],
    ['Safari on iOS', 'Approve a Patch sign-in from Safari on an iOS device?'],
    ['Edge', 'Approve a Patch sign-in from Edge?'],
  ])('%s', (label, expected) => {
    expect(signInQuestion(label)).toBe(expected);
  });
});
