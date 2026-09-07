import type { NextRequest } from 'next/server';

import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/with-auth';
import { finishOutboundPivot } from '@/server/autopilot-outbound';
import { sanitizeTool, sanitizeToolList } from '@/lib/cctp/failure-class';

// #33 Stage 3 payoff — the server-side outbound pivot. Called by the engine
// (or cron) once the CCTP mint lands USDC on the user's Base address, INSTEAD
// of prompting a passkey 20–50 minutes after the swap started. Since
// 2026-09-07 the checks and the swap itself live in
// server/autopilot-outbound.ts, SHARED with the cron's closed-tab sweep — one
// core, two callers, no drift. This route adds session auth + ownership and
// keeps its historical response contract (the engine's failover and
// prompt-fallback branch on these exact statuses and fields).
export const dynamic = 'force-dynamic';
// Quote + top-up receipt + approve receipt + pivot receipt can span a couple
// of minutes on Base — the platform default timeout would kill the function
// mid-swap (the tx would still land; the row patch would not).
export const maxDuration = 300;

const RESPONSE_FOR: Record<string, { error: string; status: number }> = {
  'autopilot-disabled': { error: 'autopilot-disabled', status: 409 },
  'not-ready': { error: 'Not ready for pivot', status: 409 },
  'no-pivot-asset': { error: 'No pivot for this asset', status: 409 },
  'wallet-mismatch': { error: 'Wallet mismatch', status: 409 },
  'no-usdc': { error: 'No USDC on Base yet', status: 409 },
  'gas-failed': { error: 'Gas top-up failed', status: 502 },
};

export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const { transferId, denyBridges: rawDeny, denyExchanges: rawDenyEx } = await request.json();
    if (typeof transferId !== 'string' || !transferId) {
      return NextResponse.json({ success: false, error: 'Missing transferId' }, { status: 400 });
    }
    // Bridge-failover retries: slug-validated + bounded; junk drops to "no
    // filter" rather than erroring (the retry still runs, unfiltered).
    const denyBridges = Array.isArray(rawDeny)
      ? rawDeny
          .map(sanitizeTool)
          .filter((x): x is string => !!x)
          .slice(0, 4)
      : undefined;
    const denyExchanges = sanitizeToolList(rawDenyEx);

    const tr = await prisma.cctpTransfer.findUnique({ where: { id: transferId } });
    if (!tr || tr.userId !== user.id) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    const outcome = await finishOutboundPivot(tr, { denyBridges, denyExchanges });
    if (outcome.ok) {
      return NextResponse.json({ success: true, ...outcome.result });
    }

    if (outcome.reason === 'pivot-failed') {
      // A revert means the autopilot signed and the CHAIN rejected the route:
      // the engine uses the class + failed tool to retry a different bridge
      // instead of burning a biometric prompt on the same reverting route.
      if (outcome.revert) {
        return NextResponse.json(
          {
            success: false,
            failureClass: 'reverted',
            tool: outcome.revert.tool,
            txHash: outcome.revert.txHash,
            exchanges: outcome.revert.exchanges,
            error: outcome.detail ?? 'pivot reverted',
          },
          { status: 502 }
        );
      }
      return NextResponse.json(
        { success: false, failureClass: 'other', error: outcome.detail ?? 'pivot failed' },
        { status: 502 }
      );
    }

    if (outcome.reason === 'no-destination-wallet') {
      return NextResponse.json(
        { success: false, error: `No ${tr.dstAsset} wallet on file` },
        { status: 409 }
      );
    }

    const mapped = RESPONSE_FOR[outcome.reason] ?? { error: outcome.reason, status: 409 };
    return NextResponse.json({ success: false, error: mapped.error }, { status: mapped.status });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, failureClass: 'other', error: String(e?.message ?? e) },
      { status: 502 }
    );
  }
});
