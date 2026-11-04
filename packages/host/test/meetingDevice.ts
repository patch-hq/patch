// Test stand-in for the device that hears a meeting. Meetings are transcribed on
// the surface's own machine and reach the host as text (`ingestLines`); these
// tests script what that device "heard" with `transcribe` (one text per call) or
// `transcribeVoices` (stretches by distinct voice), and `ingestAudio` sends it as
// lines said at the manager's current time.

import { MeetingManager, type MeetingDeps } from '../src/meeting.js';

export interface DeviceDeps extends MeetingDeps {
  transcribe?: (clip: Buffer) => Promise<string>;
  transcribeVoices?: (session: string, clip: Buffer) => Promise<{ text: string; voice: number }[]>;
}

export class TestMeetings extends MeetingManager {
  private readonly device: DeviceDeps;
  constructor(deps: DeviceDeps) {
    const { transcribe: _t, transcribeVoices: _v, ...rest } = deps;
    super(rest);
    this.device = deps;
  }

  async ingestAudio(
    chatId: string,
    source: 'mic' | 'system',
    clip: Buffer,
    speakerName?: string,
  ): Promise<void> {
    const spokenAt = (this.device.now ?? Date.now)();
    const stamp = speakerName && source === 'system' ? { speakerName } : {};
    if (this.device.transcribeVoices && source === 'system') {
      const runs = await this.device.transcribeVoices(`${chatId}`, clip);
      const merged: { text: string; voice: number }[] = [];
      for (const r of runs) {
        const last = merged.at(-1);
        if (last && last.voice === r.voice) last.text += ` ${r.text}`;
        else merged.push({ ...r });
      }
      this.ingestLines(
        chatId,
        source,
        merged.map((r) => ({ text: r.text, voice: r.voice, spokenAt, ...stamp })),
      );
      return;
    }
    const text = this.device.transcribe ? await this.device.transcribe(clip) : 'hello there';
    this.ingestLines(chatId, source, [{ text, spokenAt, ...stamp }]);
  }
}
