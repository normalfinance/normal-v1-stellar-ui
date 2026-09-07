// The CCTP transfer state machine. Server-only.
//
// A transfer row is created (and the burn intent persisted) BEFORE the burn is
// broadcast; from then on `advanceTransfer` can always move it forward, no
// matter how many times the process died in between — attestations are
// re-fetchable from Iris indefinitely (re-attested after ~24h expiry).
//
//   BURN_SUBMITTED ──(iris complete)──▶ ATTESTED ──(execute mint)──▶
//   MINT_SUBMITTED ──(tx confirmed)──▶ COMPLETED
//                                        └─(dst swap leg, Phase 2)─▶ DST_SWAP_PENDING
//
// Transitions use optimistic guards (updateMany with expected status) so the
// cron and an opportunistic status-read can race harmlessly.

import type { CctpTransfer } from '@prisma/client';
import type { NetworkType } from '@normalfinance/utils';

import { prisma } from '@/lib/prisma';
import { autofinishDecision } from '@/lib/cctp/autofinish';
import { parseFailedTool } from '@/lib/cctp/failure-class';
import { lifiSourceVerdict } from '@/lib/cctp/lifi-verdict';

import { IrisClient } from './iris';
import { wireToUsdc } from './decimals';
import {
  destChainOf,
  executeEvmMint,
  isEvmTxConfirmed,
  isStellarTxConfirmed,
  executeStellarMintAndForward,
} from './executor';

export const PENDING_STATUSES = [
  'BURN_SUBMITTED',
  'BURN_CONFIRMED',
  'ATTESTED',
  'MINT_SUBMITTED',
] as const;

/** Advance a single transfer one step if possible. Returns the fresh row. */
export async function advanceTransfer(transfer: CctpTransfer): Promise<CctpTransfer> {
  const network = transfer.network as NetworkType;

  try {
    switch (transfer.status) {
      // Niko 2026-08-28: an inbound row whose SOURCE leg reverted on-chain
      // stayed CREATED forever — the banner kept offering "finish once it
      // arrives" for money that provably never moved, and Try again dead-
      // ended on "No USDC found on Base". Every advance pass (the banner's
      // 30s poke, the cron) now asks LI.FI and retires the ghost, so the
      // banner clears without the user doing anything.
      case 'CREATED': {
        if (
          transfer.direction !== 'crosschain_to_stellar' ||
          !transfer.srcSwapTxHash ||
          transfer.burnTxHash
        )
          break;
        const vres = await fetch(
          `https://li.quest/v1/status?txHash=${encodeURIComponent(transfer.srcSwapTxHash)}`,
          {
            cache: 'no-store',
            signal: AbortSignal.timeout(15_000),
            headers: process.env.LIFI_API_KEY ? { 'x-lifi-api-key': process.env.LIFI_API_KEY } : {},
          }
        );
        if (!vres.ok) break;
        const vd = await vres.json();
        const verdict = lifiSourceVerdict(vd?.status, vd?.substatus);
        if (verdict) {
          await prisma.cctpTransfer.updateMany({
            where: { id: transfer.id, status: 'CREATED' },
            data: {
              status: 'FAILED',
              errorDetail:
                verdict === 'REFUNDED'
                  ? 'Source swap refunded — funds returned to the sender; nothing was bridged'
                  : 'Source transaction reverted on-chain — funds never left the sender; nothing was bridged',
            },
          });
          break;
        }

        // Closed-tab finish (2026-09-02, proved live the same day): the source
        // leg SUCCEEDED — USDC is sitting at the user's own Base address — but
        // the burn was historically fired only by the browser tab, so a closed
        // tab parked the transfer here until a banner tap. The cron now runs
        // the same shared core the autopilot burn route uses, gated so it never
        // races a live session and never surprise-fires an old row.
        if (vd?.status === 'DONE') {
          const decision = autofinishDecision({
            ageMs: Date.now() - transfer.createdAt.getTime(),
            retryCount: transfer.retryCount,
          });
          if (!decision.attempt) break;

          // Claim by CAS on retryCount — two overlapping advance passes (a
          // scheduled cron + a manual poke) increment it once between them;
          // the loser matches 0 rows and walks away. The increment doubles as
          // the attempt counter the gate above caps.
          const claimed = await prisma.cctpTransfer.updateMany({
            where: {
              id: transfer.id,
              status: 'CREATED',
              burnTxHash: null,
              retryCount: transfer.retryCount,
            },
            data: { retryCount: { increment: 1 } },
          });
          if (claimed.count === 0) break;

          // Lazy import: the finisher drags the Turnkey SDK with it, which has
          // no business loading for the 99% of advance passes that skip this.
          const { finishInboundBurn } = await import('@/server/autopilot-inbound');
          const result = await finishInboundBurn(transfer);
          if (!result.ok) {
            // Status stays CREATED — the banner path is untouched, and the
            // next tick retries until the gate's attempt cap. A non-autopilot
            // user lands here every time (their burn needs their passkey).
            await prisma.cctpTransfer.updateMany({
              where: { id: transfer.id, status: 'CREATED' },
              data: {
                errorDetail:
                  `autofinish ${result.reason}${result.detail ? `: ${result.detail}` : ''}`.slice(
                    0,
                    500
                  ),
              },
            });
          }
        }
        break;
      }

      case 'BURN_SUBMITTED':
      case 'BURN_CONFIRMED': {
        if (!transfer.burnTxHash) break;
        const iris = new IrisClient(network);
        const msg = await iris.getMessageByTxHash(
          transfer.sourceDomain,
          transfer.burnTxHash,
          transfer.destDomain
        );
        if (IrisClient.isComplete(msg)) {
          await prisma.cctpTransfer.updateMany({
            where: { id: transfer.id, status: transfer.status },
            data: {
              status: 'ATTESTED',
              messageHex: msg.message,
              attestationHex: msg.attestation,
              eventNonce: msg.eventNonce,
            },
          });
        }
        break;
      }

      case 'ATTESTED': {
        if (!transfer.messageHex || !transfer.attestationHex) break;
        // Claim the row first so two racing advancers can't double-submit.
        const claimed = await prisma.cctpTransfer.updateMany({
          where: { id: transfer.id, status: 'ATTESTED' },
          data: { status: 'MINT_SUBMITTED' },
        });
        if (claimed.count === 0) break;

        try {
          const destChain = destChainOf(transfer.destDomain);
          let mintTxHash: string;
          if (destChain === 'stellar') {
            mintTxHash = await executeStellarMintAndForward({
              network,
              message: transfer.messageHex as `0x${string}`,
              attestation: transfer.attestationHex as `0x${string}`,
            });
          } else if (destChain === 'base' || destChain === 'ethereum') {
            mintTxHash = await executeEvmMint({
              network,
              chain: destChain,
              message: transfer.messageHex as `0x${string}`,
              attestation: transfer.attestationHex as `0x${string}`,
            });
          } else {
            throw new Error(`destination ${destChain} not yet supported`);
          }
          await prisma.cctpTransfer.update({
            where: { id: transfer.id },
            data: { mintTxHash },
          });
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          // Someone else already executed the mint (destinationCaller is open)
          // — the recipient has their USDC; verify via balance rather than fail.
          if (/nonce already used|already received/i.test(msg)) {
            await prisma.cctpTransfer.update({
              where: { id: transfer.id },
              data: { status: 'COMPLETED', errorDetail: 'mint executed externally' },
            });
          } else {
            // Roll back the claim so the next tick retries.
            await prisma.cctpTransfer.update({
              where: { id: transfer.id },
              data: {
                status: 'ATTESTED',
                retryCount: { increment: 1 },
                errorDetail: msg.slice(0, 500),
              },
            });
          }
        }
        break;
      }

      case 'MINT_SUBMITTED': {
        if (!transfer.mintTxHash) break;
        const destChain = destChainOf(transfer.destDomain);
        const confirmed =
          destChain === 'stellar'
            ? await isStellarTxConfirmed({ network, txHash: transfer.mintTxHash })
            : await isEvmTxConfirmed({
                network,
                chain: destChain as 'base' | 'ethereum',
                txHash: transfer.mintTxHash as `0x${string}`,
              });
        if (confirmed) {
          await prisma.cctpTransfer.updateMany({
            where: { id: transfer.id, status: 'MINT_SUBMITTED' },
            data: {
              status: 'COMPLETED',
              // Inbound mints the burned amount 1:1 as USDC on Stellar, so the
              // delivered amount is known HERE, server-side. The client used to
              // be the only writer (after its status poll resolved) — a dead
              // tab or dropped poll left dstAmount null: the activity feed
              // showed $0 forever and the delivery-dedupe (which keys on
              // dstAmount) let the same USDC appear again as a Receive row.
              // Outbound stays client-written: its delivered amount comes from
              // the LI.FI pivot result, which only the client has.
              ...(transfer.direction === 'crosschain_to_stellar' &&
              transfer.dstAsset === 'USDC' &&
              !transfer.dstAmount
                ? { dstAmount: wireToUsdc(BigInt(transfer.amountWire)) }
                : {}),
            },
          });
        }
        break;
      }

      default:
        break;
    }
  } catch (e: any) {
    await prisma.cctpTransfer.update({
      where: { id: transfer.id },
      data: { retryCount: { increment: 1 }, errorDetail: String(e?.message ?? e).slice(0, 500) },
    });
  }

  return prisma.cctpTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
}

// A row born CREATED that never gained a tx hash within this window is a
// swap that died at (or before) its first signature — nothing reached a
// chain, so nothing will ever advance it. Expire it instead of re-scanning
// it on every cron tick forever (and rendering an eternal "pending" row in
// the activity feed). Trade-off, documented: if a broadcast succeeded but
// the hash-attaching PATCH failed, this marks a live transfer FAILED — the
// funds are still safe (every recipient address is the user's own), only
// the row's label lies, and it takes two independent failures to get there.
const STALE_CREATED_MS = 60 * 60_000;

// Outbound rows are COMPLETED *bridge-side* the moment the Base mint confirms,
// so PENDING_STATUSES never sees them — yet the LI.FI pivot that delivers the
// asset the user actually asked for may still be unrun. That is the banner's
// 'halt-finish', and until 2026-09-07 only a browser tab or a manual tap could
// clear it: one real row sat there for 12 days. This sweep is the outbound twin
// of the inbound finish in advanceTransfer's CREATED case.
const STALLED_PIVOT_TAKE = 5;

async function finishStalledPivots(): Promise<number> {
  const rows = await prisma.cctpTransfer.findMany({
    where: {
      direction: 'stellar_to_crosschain',
      dstSwapTxHash: null,
      burnTxHash: { not: null },
      mintTxHash: { not: null },
      status: { notIn: ['FAILED', 'REFUNDED'] },
    },
    orderBy: { createdAt: 'desc' },
    take: STALLED_PIVOT_TAKE,
  });

  let finished = 0;
  for (const tr of rows) {
    // IDLE time, not age-since-creation. An outbound row is written throughout
    // its bridge phase (burn hash, status flips, mint hash), so "nothing has
    // touched this for 10 minutes" is the real abandonment signal. Age-since-
    // creation would be useless here: the attestation alone takes ~20 minutes,
    // so every row would qualify the instant its mint landed and the cron would
    // race the live tab that is about to pivot one second later.
    const decision = autofinishDecision({
      ageMs: Date.now() - tr.updatedAt.getTime(),
      retryCount: tr.retryCount,
    });
    if (!decision.attempt) continue;

    // Claim by CAS on retryCount — same contract as the inbound finish: two
    // overlapping passes increment once between them and the loser walks away,
    // while the increment doubles as the attempt counter the gate caps.
    const claimed = await prisma.cctpTransfer.updateMany({
      where: { id: tr.id, dstSwapTxHash: null, retryCount: tr.retryCount },
      data: { retryCount: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    // Lazy import: the finisher drags the Turnkey SDK with it, which has no
    // business loading on the ticks that sweep nothing.
    const { finishOutboundPivot } = await import('@/server/autopilot-outbound');
    // Exclude a bridge that already reverted for THIS row, exactly as the
    // banner's retry does — otherwise the cron re-runs the same failing route
    // until the attempt cap and wastes gas on every try.
    const denyBridges = [parseFailedTool(tr.errorDetail)].filter((x): x is string => !!x);
    const res = await finishOutboundPivot(tr, { denyBridges });
    if (res.ok) {
      finished += 1;
    } else if (!res.revert && (!tr.errorDetail || tr.errorDetail.startsWith('autofinish'))) {
      // Record why, but NEVER over a revert detail: the banner's retry parses
      // the failed tool back out of errorDetail, and clobbering it would lose
      // the failover hint.
      await prisma.cctpTransfer
        .updateMany({
          where: { id: tr.id, dstSwapTxHash: null },
          data: {
            errorDetail: `autofinish ${res.reason}${res.detail ? `: ${res.detail}` : ''}`.slice(
              0,
              500
            ),
          },
        })
        .catch(() => {});
    }
  }
  return finished;
}

/** Advance every in-flight transfer (cron entrypoint). */
export async function advancePendingTransfers(): Promise<{
  advanced: number;
  byStatus: Record<string, number>;
  pivotsFinished: number;
}> {
  await prisma.cctpTransfer.updateMany({
    where: {
      status: 'CREATED',
      burnTxHash: null,
      srcSwapTxHash: null,
      createdAt: { lt: new Date(Date.now() - STALE_CREATED_MS) },
    },
    data: {
      status: 'FAILED',
      errorDetail: 'Expired — no transaction was ever sent; no funds moved',
    },
  });

  // Repair COMPLETED inbound rows that predate the server-side dstAmount
  // write above (their client died before reporting) — bounded, and a no-op
  // once the backlog is drained.
  const missingAmount = await prisma.cctpTransfer.findMany({
    where: {
      status: 'COMPLETED',
      direction: 'crosschain_to_stellar',
      dstAsset: 'USDC',
      dstAmount: null,
    },
    take: 20,
  });
  for (const row of missingAmount) {
    await prisma.cctpTransfer.update({
      where: { id: row.id },
      data: { dstAmount: wireToUsdc(BigInt(row.amountWire)) },
    });
  }

  // CREATED inbound rows WITH a source hash are excluded from
  // PENDING_STATUSES on purpose (in-session rows belong to the modal) — but
  // a reverted source leg leaves them as permanent ghosts. Sweep them through
  // advanceTransfer, which retires any whose leg LI.FI reports terminal.
  const ghosts = await prisma.cctpTransfer.findMany({
    where: {
      status: 'CREATED',
      direction: 'crosschain_to_stellar',
      srcSwapTxHash: { not: null },
      burnTxHash: null,
    },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });

  const pending = await prisma.cctpTransfer.findMany({
    where: { status: { in: [...PENDING_STATUSES] } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  const byStatus: Record<string, number> = {};
  for (const t of [...ghosts, ...pending]) {
    const after = await advanceTransfer(t);
    byStatus[after.status] = (byStatus[after.status] ?? 0) + 1;
  }

  // Last, so a mint that landed earlier in THIS pass is already visible: the
  // outbound pivot sweep reads mintTxHash written moments ago.
  const pivotsFinished = await finishStalledPivots();

  return { advanced: pending.length, byStatus, pivotsFinished };
}
