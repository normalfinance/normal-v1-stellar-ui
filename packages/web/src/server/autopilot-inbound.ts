// ---------------------------------------------------------------------------
// The server-side inbound finish — the money-moving half (2026-09-02).
//
// ONE core, TWO callers, so the logic can never drift (the transaction-log
// lesson): the /api/cctp/autopilot/burn route (an open tab / banner tap, with
// session auth on top) and the cron's state machine (a closed tab, gated by
// lib/cctp/autofinish.ts). Every check the route historically performed lives
// HERE — validation, wallet pin, custody pin, share-scoping, gas — so both
// callers get identical protection.
//
// Double-burn defence in depth (no new lock: the hard guard is the same one
// the route always had):
//   1. callers serialize themselves (route = one user tap; cron = CAS claim
//      on retryCount before calling),
//   2. ensureTransferGas holds the per-transfer top-up lock,
//   3. onBroadcast stamps burnTxHash guarded on `burnTxHash: null` — the
//      moment one burn broadcasts, every later actor sees "Not burnable".
// Residual window: two burns broadcast within seconds of each other. Both are
// custody-pinned to the user's OWN Stellar wallet and share-scoped, so the
// worst case is the user's other Base USDC bridging to themselves early.
// ---------------------------------------------------------------------------

import type { CctpTransfer } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { wireToUsdc } from '@/lib/cctp/decimals';
import { scopedAmountWire } from '@/lib/cctp/amounts';
import { userOwnsWallet } from '@/lib/wallet-ownership';
import { autopilotBurnUsdc } from '@/server/autopilot-burn';
import { autopilotEnabled } from '@/server/autopilot-signer';
import { ensureTransferGas } from '@/server/cctp-transfer-gas';
import { evmFallbackTransport } from '@/lib/chains/rpc-fallback';

export type FinishInboundOutcome =
  | { ok: true; burnTxHash: `0x${string}` }
  | {
      ok: false;
      reason:
        | 'autopilot-disabled'
        | 'not-burnable'
        | 'wallet-mismatch'
        | 'recipient-not-owned'
        | 'no-usdc'
        | 'gas-failed'
        | 'burn-failed';
      detail?: string;
    };

export async function finishInboundBurn(tr: CctpTransfer): Promise<FinishInboundOutcome> {
  if (!autopilotEnabled()) return { ok: false, reason: 'autopilot-disabled' };

  // Doc 93 0b: REFUND rows (pure USDC→USDC returns) have no source-swap leg
  // by construction — srcSwapTxHash is only required for real inbound swaps.
  const isPureUsdcReturn = tr.srcAsset === 'USDC' && tr.dstAsset === 'USDC';
  if (
    tr.direction !== 'crosschain_to_stellar' ||
    (!tr.srcSwapTxHash && !isPureUsdcReturn) ||
    tr.burnTxHash ||
    tr.status === 'COMPLETED' ||
    tr.status === 'FAILED' ||
    tr.status === 'REFUNDED'
  ) {
    return { ok: false, reason: 'not-burnable' };
  }

  // The signer address must be the user's OWN Turnkey EVM address — cross-
  // checked against their wallet row, not trusted from the transfer alone.
  const wallet = await prisma.turnkeyWallet.findFirst({ where: { supabaseUid: tr.userId } });
  if (
    !wallet?.subOrgId ||
    !wallet.ethereumAddress ||
    wallet.ethereumAddress.toLowerCase() !== tr.srcAddress.toLowerCase()
  ) {
    return { ok: false, reason: 'wallet-mismatch' };
  }

  // CUSTODY PIN (scenario sweep 2026-08-21): the burn's hookData recipient
  // comes from the row, and the row's destAddress is CLIENT-supplied at
  // creation with no ownership check. The Turnkey policy cannot see inside
  // hookData — so the server must refuse recipients the user doesn't own.
  if (!(await userOwnsWallet(tr.userId, tr.destAddress))) {
    return { ok: false, reason: 'recipient-not-owned' };
  }

  // Burn whatever actually landed (mirrors the banner's recover()).
  const { erc20Abi, createPublicClient } = await import('viem');
  const { base, baseSepolia } = await import('viem/chains');
  const network = tr.network === 'mainnet' ? 'mainnet' : 'testnet';
  const client = createPublicClient({
    chain: network === 'mainnet' ? base : baseSepolia,
    // Doc 95 Wave 4: fallback list, not viem's default public RPC — this
    // read decides how much money the leg moves.
    transport: await evmFallbackTransport('base', network),
  });
  const { EVM_USDC } = await import('@/lib/cctp/config');
  const bal = await client.readContract({
    address: EVM_USDC.base[network],
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [tr.srcAddress as `0x${string}`],
  });
  if (bal === 0n) return { ok: false, reason: 'no-usdc' };

  // Doc 95 Wave 3 (live 2026-08-26): this used to burn the WHOLE balance,
  // so when two swaps landed together one row's burn swept the other's
  // minted USDC and orphaned it. Take only this row's share.
  const burnWire = scopedAmountWire(bal as bigint, BigInt(tr.amountWire));
  if (burnWire === 0n) return { ok: false, reason: 'no-usdc' };

  // Dust gas for the approve + burn — same locked core as /api/cctp/gas-topup
  // (fresh Base wallets hold zero ETH; the relayer fronts it, priced into the
  // quote). Server-side we wait for the actual receipt instead of a fixed
  // sleep, so the burn's gas estimate never races the top-up.
  const gas = await ensureTransferGas(tr.id);
  if (gas.outcome === 'sent') {
    await client.waitForTransactionReceipt({ hash: gas.txHash });
  } else if (gas.outcome === 'in-progress') {
    // Another actor (banner tap, retried call) is funding right now — give
    // its send a moment to land; the burn below fails loudly if it didn't.
    await new Promise((r) => {
      setTimeout(r, 6000);
    });
  } else if (gas.outcome === 'failed') {
    return { ok: false, reason: 'gas-failed', detail: gas.error };
  } else if (gas.outcome === 'invalid') {
    // e.g. the burn landed between our check and now — nothing left to do.
    return { ok: false, reason: 'not-burnable', detail: gas.reason };
  }

  try {
    const { burnTxHash } = await autopilotBurnUsdc({
      network,
      chain: 'base',
      subOrgId: wallet.subOrgId,
      evmAddress: tr.srcAddress,
      amountWire: burnWire,
      stellarRecipient: tr.destAddress,
      // Doc 95 Wave 3: persist the hash the moment it is broadcast. A
      // receipt-wait failure used to discard a real burn, after which the
      // engine signed a SECOND one.
      onBroadcast: async (hash, label) => {
        if (label !== 'depositForBurnWithHook') return;
        await prisma.cctpTransfer
          .updateMany({
            where: { id: tr.id, burnTxHash: null },
            data: { burnTxHash: hash, status: 'BURN_SUBMITTED' },
          })
          .catch(() => {});
      },
    });

    // Mirror the PATCH route exactly: the hash lands ONCE, and the status flip
    // to BURN_SUBMITTED is what puts the row inside PENDING_STATUSES so the
    // cron advances the bridge. Guarded on burnTxHash null so a racing writer
    // can't be clobbered.
    await prisma.cctpTransfer.updateMany({
      where: { id: tr.id, burnTxHash: null },
      data: {
        burnTxHash,
        status: 'BURN_SUBMITTED',
        ...(tr.dstAmount ? {} : { dstAmount: wireToUsdc(burnWire) }),
      },
    });

    return { ok: true, burnTxHash };
  } catch (e: any) {
    // Turnkey rejecting the delegate (user never granted autopilot) lands
    // here too — the caller records it and the interactive path stays open.
    return { ok: false, reason: 'burn-failed', detail: String(e?.message ?? e).slice(0, 400) };
  }
}
