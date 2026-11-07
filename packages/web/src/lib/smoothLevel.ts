// One step of a peak-meter envelope: rises quickly with the voice, falls
// slowly after it, so a level bar reads as live without flickering.

const ATTACK = 0.6;
const RELEASE = 0.15;

export function smoothLevel(prev: number, next: number): number {
  const target = Math.max(0, Math.min(1, next));
  return prev + (target - prev) * (target > prev ? ATTACK : RELEASE);
}
