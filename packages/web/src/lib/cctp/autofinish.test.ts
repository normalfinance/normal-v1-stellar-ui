import {
  AUTOFINISH_MIN_AGE_MS,
  AUTOFINISH_MAX_AGE_MS,
  AUTOFINISH_MAX_ATTEMPTS,
  autofinishDecision,
} from './autofinish';

const MIN = AUTOFINISH_MIN_AGE_MS;
const MAX = AUTOFINISH_MAX_AGE_MS;

describe('autofinishDecision — when the cron may finish an inbound burn', () => {
  it('attempts an abandoned transfer inside the window', () => {
    expect(autofinishDecision({ ageMs: 37 * 60_000, retryCount: 0 })).toEqual({
      attempt: true,
      reason: 'eligible',
    });
  });

  it('leaves fresh rows to the live tab — an open session must never be raced', () => {
    expect(autofinishDecision({ ageMs: MIN - 1, retryCount: 0 }).attempt).toBe(false);
    expect(autofinishDecision({ ageMs: MIN, retryCount: 0 }).attempt).toBe(true);
  });

  it('never surprise-fires an old burn — the week-old ghost stays banner-only', () => {
    expect(autofinishDecision({ ageMs: MAX + 1, retryCount: 0 }).attempt).toBe(false);
    expect(autofinishDecision({ ageMs: 7 * 24 * 3_600_000, retryCount: 0 }).attempt).toBe(false);
  });

  it('gives up after the attempt cap — a non-autopilot user is a permanent no, not a retry loop', () => {
    expect(
      autofinishDecision({ ageMs: 60 * 60_000, retryCount: AUTOFINISH_MAX_ATTEMPTS }).attempt
    ).toBe(false);
    expect(
      autofinishDecision({ ageMs: 60 * 60_000, retryCount: AUTOFINISH_MAX_ATTEMPTS - 1 }).attempt
    ).toBe(true);
  });

  it('refuses a nonsensical age instead of guessing', () => {
    expect(autofinishDecision({ ageMs: -5, retryCount: 0 }).attempt).toBe(false);
    expect(autofinishDecision({ ageMs: Number.NaN, retryCount: 0 }).attempt).toBe(false);
  });
});
