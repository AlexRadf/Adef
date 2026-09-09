// One place that knows how fast the world runs. Content is authored in
// seconds and converted once at load, so changing the tick rate -- or
// moving to an engine that runs at 30 or 60 -- is this constant.

export const TICKS_PER_SECOND = 10;

export const toTicks = (seconds) => Math.round(seconds * TICKS_PER_SECOND);
export const toSeconds = (ticks) => ticks / TICKS_PER_SECOND;
