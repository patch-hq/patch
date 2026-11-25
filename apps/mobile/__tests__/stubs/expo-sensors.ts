// expo-sensors stand-in for unit tests: no accelerometer, listeners do nothing.

export const Accelerometer = {
  setUpdateInterval(_ms: number): void {},
  addListener(_fn: (m: { x: number; y: number; z: number }) => void): { remove(): void } {
    return { remove(): void {} };
  },
};
