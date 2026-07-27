export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function nowIso(clock: Clock): string {
  return clock.now().toISOString();
}
