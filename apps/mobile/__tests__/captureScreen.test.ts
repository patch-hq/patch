import { beforeEach, describe, expect, it, vi } from 'vitest';

const shot = vi.fn();
const post = vi.fn();
vi.mock('react-native-view-shot', () => ({ captureScreen: (o: unknown) => shot(o) }));
vi.mock('../src/api/rest', () => ({ api: { captureScreen: (b: unknown) => post(b) } }));

import { captureScreenForAgents } from '../src/lib/captureScreen';

describe('captureScreenForAgents', () => {
  beforeEach(() => {
    shot.mockReset();
    post.mockReset();
  });
  it('posts the base64 png as a phone capture of the route', async () => {
    shot.mockResolvedValue('AAAA');
    post.mockResolvedValue({ id: 'c1' });
    await captureScreenForAgents('/chats/abc');
    expect(shot).toHaveBeenCalledWith({ format: 'png', result: 'base64' });
    const body = post.mock.calls[0]![0];
    expect(body).toMatchObject({ surface: 'phone', route: '/chats/abc', png: 'AAAA' });
    expect(body.viewport.width).toBeGreaterThan(0);
  });
  it('throws when the screenshot fails, without posting', async () => {
    shot.mockRejectedValue(new Error('no view'));
    await expect(captureScreenForAgents('/x')).rejects.toThrow('no view');
    expect(post).not.toHaveBeenCalled();
  });
});
