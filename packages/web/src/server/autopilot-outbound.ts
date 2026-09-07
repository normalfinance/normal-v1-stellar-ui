// ---------------------------------------------------------------------------
// The server-side outbound pivot — the money-moving half (2026-09-07).
//
// Twin of server/autopilot-inbound.ts, closing the SECOND half of the
// closed-tab gap. Outbound (USDC on Stellar → BTC/ETH/SOL) signs its burn
// first, so the CCTP bridge finishes server-side — but the LI.FI pivot that
// turns the minted Base USDC into the asset the user actually asked for was
// triggered only by the browser tab (or a banner tap). Close the tab and the
// transfer parked in the banner's 'halt-finish' phase; a real row sat that way
// for 12 days.
//
// ONE core, TWO callers (the transaction-log lesson): the
// /api/cctp/autopilot/pivot route (open tab / banner tap, session auth on top)
// and the cron's stalled-pivot sweep. Every check the route historically
// performed lives HERE — readiness, wallet pin, delivery-address lookup from
// the user's OWN wallet row, share-scoping, gas — so both callers are
// protected identically.
//
// Double-pivot defence is unchanged from the route: callers serialize (route =
// one user tap; cron = CAS claim), ensureTransferGas holds the per-transfer
// top-up lock, and onBroadcast stamps dstSwapTxHash guarded on
// `dstSwapTxHash: null` — the moment one pivot broadcasts, every later actor
// reads "not ready".
// ---------------------------------------------------------------------------

import type { CctpTransfer } from '@prisma/client';
import type { AutopilotPivotResult } from '@/server/autopilot-pivot';

import { prisma } from '@/lib/prisma';
import { BigNumber } from 'bignumber.js';
import { scopedAmountWire } from '@/lib/cctp/amounts';
import { autopilotEnabled } from '@/server/autopilot-signer';
import { autopilotPivotSwap } from '@/server/autopilot-pivot';
import { CHAINS, chainForSymbol } from '@/lib/chains/registry';
import { ensureTransferGas } from '@/server/cctp-transfer-gas';
import { evmFallbackTransport } from '@/lib/chains/rpc-fallback';
import {
  sanitizeTool,
  sanitizeTxHash,
  sanitizeToolList,
  pivotRevertDetail,
} from '@/lib/cctp/failure-class';

export interface FinishOutboundOptions {
  /** Bridge-failover retries: tools to exclude from the LI.FI route. */
  denyBridges?: string[];
  denyExchanges?: string[];
}

export type FinishOutboundOutcome =
  | { ok: true; txHash: `0x${string}`; toAmountMin: string; result: AutopilotPivotResult }
  | {
      ok: false;
      reason:
        | 'autopilot-disabled'
        | 'not-ready'
        | 'no-pivot-asset'
        | 'wallet-mismatch'
        | 'no-destination-wallet'
        | 'no-usdc'
        | 'gas-failed'
        | 'pivot-failed';
      detail?: string;
      /** Present when the chain REVERTED the route — the caller offers
       *  failover rather than a pointless passkey prompt. */
      revert?: { tool: string | null; txHash: string | null; exchanges: string[] };
    };

export async function finishOutboundPivot(
  tr: CctpTransfer,
  opts: FinishOutboundOptions = {}
): Promise<FinishOutboundOutcome> {
  if (!autopilotEnabled()) return { ok: false, reason: 'autopilot-disabled' };

  // Banner's 'halt-finish' phase, verbatim: outbound, burn done, mint landed
  // (mintTxHash or bridge COMPLETED), pivot leg not yet executed.
  const mintLanded = !!tr.mintTxHash || tr.status === 'COMPLETED';
  if (
    tr.direction !== 'stellar_to_crosschain' ||
    !tr.burnTxHash ||
    !mintLanded ||
    tr.dstSwapTxHash ||
    tr.status === 'FAILED' ||
    tr.status === 'REFUNDED'
  ) {
    return { ok: false, reason: 'not-ready' };
  }

  const toSymbol = tr.dstAsset as 'BTC' | 'ETH' | 'SOL';
  const toChain = chainForSymbol(toSymbol);
  if (!toChain || toChain === 'stellar') return { ok: false, reason: 'no-pivot-asset' };

  // The signer address must be the user's OWN Turnkey EVM address (outbound
  // destAddress = their Base pivot address), and the delivery address is read
  // from the same row — the Turnkey policy cannot inspect LI.FI calldata, so
  // this lookup is what pins delivery to the user's own wallet.
  const wallet = await prisma.turnkeyWallet.findFirst({ where: { supabaseUid: tr.userId } });
  if (
    !wallet?.subOrgId ||
    !wallet.ethereumAddress ||
    wallet.ethereumAddress.toLowerCase() !== tr.destAddress.toLowerCase()
  ) {
    return { ok: false, reason: 'wallet-mismatch' };
  }
  const toAddress = wallet[CHAINS[toChain].addressField];
  if (!toAddress) return { ok: false, reason: 'no-destination-wallet' };

  // Pivot whatever actually landed (mirrors the banner's recover()).
  const { erc20Abi, createPublicClient } = await import('viem');
  const { base, baseSepolia } = await import('viem/chains');
  const network = tr.network === 'mainnet' ? 'mainnet' : 'testnet';
  const client = createPublicClient({
    chain: network === 'mainnet' ? base : baseSepolia,
    // Doc 95 Wave 4: fallback list, not viem's default public RPC — this read
    // decides how much money the leg moves.
    transport: await evmFallbackTransport('base', network),
  });
  const { EVM_USDC } = await import('@/lib/cctp/config');
  const bal = await client.readContract({
    address: EVM_USDC.base[network],
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [tr.destAddress as `0x${string}`],
  });
  if (bal === 0n) return { ok: false, reason: 'no-usdc' };

  // Doc 95 Wave 3: pivot only this row's share — a whole-balance read could
  // sweep a sibling transfer's freshly minted USDC into this swap.
  const pivotWire = scopedAmountWire(bal as bigint, BigInt(tr.amountWire));
  if (pivotWire === 0n) return { ok: false, reason: 'no-usdc' };

  // Dust gas for the approve + pivot — same locked core as /api/cctp/gas-topup,
  // with a real receipt wait instead of the banner's blind sleep.
  const gas = await ensureTransferGas(tr.id);
  if (gas.outcome === 'sent') {
    await client.waitForTransactionReceipt({ hash: gas.txHash });
  } else if (gas.outcome === 'in-progress') {
    await new Promise((r) => {
      setTimeout(r, 6000);
    });
  } else if (gas.outcome === 'failed') {
    return { ok: false, reason: 'gas-failed', detail: gas.error };
  } else if (gas.outcome === 'invalid') {
    return { ok: false, reason: 'not-ready', detail: gas.reason };
  }

  try {
    const result = await autopilotPivotSwap({
      subOrgId: wallet.subOrgId,
      evmAddress: tr.destAddress,
      toSymbol,
      toAddress,
      amountWire: pivotWire,
      denyBridges: opts.denyBridges?.length ? opts.denyBridges : undefined,
      denyExchanges: opts.denyExchanges?.length ? opts.denyExchanges : undefined,
      // Doc 95 Wave 3: record the pivot hash on broadcast, before the receipt
      // wait can lose it.
      onBroadcast: async (hash, label) => {
        if (label !== 'pivot') return;
        await prisma.cctpTransfer
          .updateMany({ where: { id: tr.id, dstSwapTxHash: null }, data: { dstSwapTxHash: hash } })
          .catch(() => {});
      },
    });

    // Mirror the PATCH route: hash + delivered amount land once; a racing
    // writer (banner tap) cannot be clobbered. No status flip here — outbound
    // rows are already COMPLETED bridge-side; delivery tracking is the
    // client's #66 LI.FI-status gate.
    const dstAmount = BigNumber(result.toAmountMin)
      .dividedBy(BigNumber(10).pow(CHAINS[toChain].decimals))
      .toFixed();
    await prisma.cctpTransfer.updateMany({
      where: { id: tr.id, dstSwapTxHash: null },
      data: { dstSwapTxHash: result.txHash, ...(tr.dstAmount ? {} : { dstAmount }) },
    });

    return { ok: true, txHash: result.txHash, toAmountMin: result.toAmountMin, result };
  } catch (e: any) {
    // Failure CLASS (Niko 2026-08-26 GO): a revert means the autopilot DID
    // sign and broadcast, and the CHAIN rejected the route — an interactive
    // passkey would just burn a biometric prompt on the same reverting route.
    // The class + failed bridge go onto the row so a later retry (banner tap
    // OR the cron's next sweep) excludes that bridge too.
    if (e?.__pivotRevert) {
      const tool = sanitizeTool(e.tool);
      const txHash = sanitizeTxHash(e.txHash);
      const exchanges = sanitizeToolList(e.exchanges);
      await prisma.cctpTransfer
        .updateMany({
          where: { id: tr.id, dstSwapTxHash: null },
          data: { errorDetail: pivotRevertDetail(tool, txHash, exchanges) },
        })
        .catch(() => {});
      return {
        ok: false,
        reason: 'pivot-failed',
        detail: String(e?.message ?? e).slice(0, 400),
        revert: { tool, txHash, exchanges },
      };
    }
    return { ok: false, reason: 'pivot-failed', detail: String(e?.message ?? e).slice(0, 400) };
  }
}
