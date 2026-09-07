// ---------------------------------------------------------------------------
// Server-side finish — the decision half (2026-09-02, extended 2026-09-07).
//
// THE GAP THIS CLOSES (proved live): a CCTP swap has exactly one leg the
// browser tab used to drive, and it sits on the opposite side of the bridge in
// each direction:
//
//   INBOUND  (SOL/BTC/ETH → USDC)  arrival on Base → BURN     ← tab-driven
//   OUTBOUND (USDC → SOL/BTC/ETH)  mint on Base    → PIVOT    ← tab-driven
//
// Autopilot removed the signature PROMPTS, not the DRIVER — so a user who
// closed the tab parked the transfer (inbound at CREATED / 'halt-receive',
// outbound at 'halt-finish') until they came back for the banner's one-tap
// finish. One real outbound row sat that way for 12 days.
//
// This module decides WHEN the cron may attempt the finish, for BOTH
// directions. Pure on purpose: the money-moving halves
// (server/autopilot-inbound.ts, server/autopilot-outbound.ts) are shared with
// the routes the open tab calls, and this gate is what keeps the cron polite.
//
// NOTE on what `ageMs` means per direction — the callers differ deliberately:
//   inbound  → age since the row was created. Nothing writes the row between
//              creation and the burn, so creation-age IS idle time.
//   outbound → IDLE time (now − updatedAt). The row is written throughout its
//              bridge phase, and the attestation alone takes ~20 minutes, so
//              creation-age would be satisfied by every row the instant its
//              mint landed — the cron would race the tab that is about to
//              pivot one second later.
// ---------------------------------------------------------------------------

/** The live tab owns the first minutes: an open session runs its leg within
 *  moments, and the cron must not race a session that is actively working.
 *  Only a transfer this quiet is presumed abandoned by its tab. */
export const AUTOFINISH_MIN_AGE_MS = 10 * 60_000;

/** Never surprise-fire an old leg: a row that sat for days (e.g. the 12-day
 *  outbound row present when this shipped) keeps its money parked at the
 *  user's own address and is finished deliberately via the banner, not
 *  automatically by a deploy. */
export const AUTOFINISH_MAX_AGE_MS = 48 * 3_600_000;

/** ~3 hours of 15-minute cron ticks. A row that failed this many times is
 *  usually a non-autopilot user (their leg cryptographically needs their
 *  passkey — Turnkey rejects the delegate every time); the banner remains
 *  their path and the cron stops burning API calls on it. */
export const AUTOFINISH_MAX_ATTEMPTS = 12;

export interface AutofinishInput {
  /** Inbound: age since creation. Outbound: idle time. See the note above. */
  ageMs: number;
  /** Attempts so far — the CAS claim increments it per try. */
  retryCount: number;
}

export interface AutofinishDecision {
  attempt: boolean;
  reason: string;
}

export function autofinishDecision(input: AutofinishInput): AutofinishDecision {
  if (!Number.isFinite(input.ageMs) || input.ageMs < 0) {
    return { attempt: false, reason: 'unusable age' };
  }
  if (input.ageMs < AUTOFINISH_MIN_AGE_MS) {
    return { attempt: false, reason: 'too fresh — the live tab owns it' };
  }
  if (input.ageMs > AUTOFINISH_MAX_AGE_MS) {
    return { attempt: false, reason: 'too old — banner-only, never surprise-fire' };
  }
  if (input.retryCount >= AUTOFINISH_MAX_ATTEMPTS) {
    return { attempt: false, reason: 'attempts exhausted — banner-only' };
  }
  return { attempt: true, reason: 'eligible' };
}
