import type { NextRequest } from 'next/server';

import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/with-auth';
import { finishInboundBurn } from '@/server/autopilot-inbound';

// #33 Stage 3 payoff — the server-side inbound burn. Called by the engine
// (or cron) once USDC lands on the user's Base address, INSTEAD of prompting
// a passkey mid-flow. Since 2026-09-02 the checks and the burn itself live in
// server/autopilot-inbound.ts, SHARED with the cron's closed-tab finisher —
// one core, two callers, no drift. This route adds session auth + ownership
// and keeps its historical response contract (the engine's prompt-fallback
// depends on these exact statuses).
export const dynamic = 'force-dynamic';
// Top-up receipt + approve receipt + allowance loop + burn receipt can span
// a couple of minutes on Base — the platform default timeout would kill the
// function mid-burn (the tx would still land; the row patch would not).
export const maxDuration = 300;

const RESPONSE_FOR: Record<string, { error: string; status: number }> = {
  'autopilot-disabled': { error: 'autopilot-disabled', status: 409 },
  'not-burnable': { error: 'Not burnable', status: 409 },
  'wallet-mismatch': { error: 'Wallet mismatch', status: 409 },
  'recipient-not-owned': { error: 'Recipient is not one of your wallets', status: 409 },
  'no-usdc': { error: 'No USDC on Base yet', status: 409 },
  'gas-failed': { error: 'Gas top-up failed', status: 502 },
};

export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const { transferId } = await request.json();
    if (typeof transferId !== 'string' || !transferId) {
      return NextResponse.json({ success: false, error: 'Missing transferId' }, { status: 400 });
    }

    const tr = await prisma.cctpTransfer.findUnique({ where: { id: transferId } });
    if (!tr || tr.userId !== user.id) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    const result = await finishInboundBurn(tr);
    if (result.ok) {
      return NextResponse.json({ success: true, burnTxHash: result.burnTxHash });
    }
    if (result.reason === 'burn-failed') {
      // Historical contract: a burn/signing failure surfaced as a 502 with the
      // underlying message, and the engine fell back to interactive prompts.
      return NextResponse.json(
        { success: false, error: result.detail ?? 'burn failed' },
        { status: 502 }
      );
    }
    const mapped = RESPONSE_FOR[result.reason] ?? { error: result.reason, status: 409 };
    return NextResponse.json({ success: false, error: mapped.error }, { status: mapped.status });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message ?? e) }, { status: 502 });
  }
});
