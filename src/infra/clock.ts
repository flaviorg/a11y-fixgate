import type { Clock } from "../domain/ports.ts";

export const systemClock: Clock = { now: () => new Date() };

/** A clock that only moves when advance() is called (loop and logger tests). */
export function steppingClock(startIso: string): Clock & { advance(ms: number): void } {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}
