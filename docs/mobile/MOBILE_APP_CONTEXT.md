# Normal Mobile App — Context for Claude Code

Paste this into the mobile repo as `CLAUDE.md` (or reference it from one). It tells
Claude what we are building, what already exists, and the rules that must not be broken.
Written 2026-09-10 from the web repo `normalfinance/normal-v1-interface`.

---

## 1. What Normal is

Normal is a consumer savings + wallet app. Users sign up with email (Supabase Auth), get a
self-custodial Turnkey wallet secured by a passkey, and can:

- **Save**: deposit USDC into Normal Savings (DeFindex vault over Blend lending pools on
  Stellar, ~7% APY). This is the core product and the brand.
- **Hold** BTC, ETH, SOL, XLM, USDC across four chains (Bitcoin, Ethereum, Solana, Stellar).
- **Swap**: Stellar-native via Soroswap; BTC/ETH/SOL cross-chain via LI.FI; Stellar⇄BTC/ETH/SOL
  via a composite Soroswap → Circle CCTP → LI.FI route (our own state machine).
- **Send / receive** on all four chains.
- **On/off-ramp**: MoneyGram (SEP-10/SEP-24), Coinbase offramp.
- **Referrals**, activity feed, portfolio.

Web app: Next.js (App Router) on Vercel, MUI + Emotion UI, zustand state, Prisma/Postgres,
Supabase Auth. (PostHog is declared in env but NOT wired anywhere in code.) Production: `normalfinance.io`. Staging: Vercel preview on a
`*.normalfinance.io` subdomain. Repo is a yarn monorepo: `packages/web` (the app),
`packages/state|utils|types|contracts|goldsky`.

## 2. What we are building now

A **React Native app with Expo (EAS)** for iOS and Android, **mainnet-only in v1**, that is a
second client of the **existing Next.js backend**. We do not build a new backend and we do not
change the identity provider.

Feature scope for v1 (same as web, minus web-only bits): sign up / sign in, passkey wallet,
portfolio, savings deposit/withdraw, swap (Soroswap, LI.FI, CCTP composite), send/receive,
activity, MoneyGram ramp, referrals.

### Decisions already made (do not re-open without asking Niko)

| Decision | Why |
|---|---|
| **Auth = Supabase, NOT Clerk** | Every API route verifies a Supabase JWT; every DB row is keyed by the Supabase user id. Clerk tokens would 401 everywhere. Use `@supabase/supabase-js` in Expo with a SecureStore storage adapter. |
| **Backend = the existing Next.js API routes** | 73 routes, 58 behind `withAuth`. Auth is `Authorization: Bearer <supabase access_token>` (header, not cookie) so native clients work today. |
| **Turnkey passkeys, rpId `normalfinance.io`** | Wallets are passkey-only. The same passkey must work on web and in the app, so the app is associated with `normalfinance.io` (AASA + assetlinks) and uses Turnkey's React Native SDK / native passkey stamper. |
| **Mainnet only** | Testnet toggle, dev pages, and `normal-network` cookie logic stay web-only. Send `?network=mainnet` (or the cookie header) on requests; server falls back to its deployment default otherwise. |
| **API backward compatibility from app launch** | Installed apps cannot be force-updated. No breaking API changes without versioning once the app ships. |

## 3. Backend contract (what the app calls)

Base URL = the web deployment (`https://normalfinance.io` prod, staging URL for dev).
All JSON. Authed routes need `Authorization: Bearer <token>`; on 401 refresh the Supabase
session once and retry (web helper: `packages/web/src/utils/authed-fetch.ts`).

Routes the app needs (path under `/api/`):

- **Wallet / Turnkey**: `turnkey/wallet` (create sub-org + wallet at signup; also adds
  per-chain addresses lazily), `turnkey/wallets`, `turnkey/credentials` (passkey credential
  ids for `allowCredentials`), `turnkey/btc-pubkey`, `turnkey/build-btc-tx`,
  `turnkey/broadcast-btc`, `turnkey/import`, `turnkey/import-init`, `wallets/check-limit`,
  `wallets/link`, `wallets/linked`.
- **Portfolio / activity**: `wallet/portfolio`, `wallet/activity`, `portfolio/activity`,
  `activity/{bitcoin|ethereum|solana|stellar}`, `prices/history`.
- **Savings**: `savings/vault-info`, `savings/user-position`, `savings/deposit`,
  `savings/withdraw`, `savings/log-transaction`, `savings/earnings-history`.
- **Swap**: `swap/quote` (Soroswap), `swap/submit-single`, `swap/log-transaction`,
  `lifi/quote`, `lifi/status`, `lifi/statuses`, `lifi/record`,
  `cctp/quote`, `cctp/transfers` (POST create / GET list, `?history=1`),
  `cctp/transfers/[id]` (GET advances the state machine; `?noAdvance=1` for a fast read;
  PATCH attaches tx hashes), `cctp/gas-topup`, `cctp/autopilot/burn`,
  `cctp/autopilot/pivot`, `autopilot/status`.
- **Send**: `send`, `send/execute`, `stellar/memo-required`, `fees/build-payment`,
  `fees/execute-pair`.
- **Ramps**: `mgi/*` (SEP-10 challenge/complete, SEP-24 deposit/withdraw, transactions),
  `ramp/transfers`, `coinbase/session`, `coinbase/offramp-status`, `offramp/fills`.
- **Other**: `referral/*`, `marketing/opt-in`, `crisp`, `transaction`.
- Server-only (never called by a client): `cron/*`.

## 4. Wallet model (Turnkey) — the part that must be exactly right

- One Turnkey **sub-organization per user**, stored in Postgres `turnkey_wallets`
  (`supabaseUid` unique ↔ `subOrgId` unique, plus `bitcoinAddress`, `ethereumAddress`,
  `solanaAddress`, `stellarAddress`, all nullable).
- **Passkey-only.** The user's passkey is the root authenticator of the sub-org. There is no
  password, no email OTP signer, no recovery passkey flow in code today.
- **rpId is `normalfinance.io`** on staging and prod (env `NEXT_PUBLIC_TURNKEY_RP_ID`).
  Localhost web dev uses rpId `localhost`. A passkey only ever works under the rpId it was
  created with.
- **Signing is client-side.** The web stamps requests with `@turnkey/webauthn-stamper`; the
  app must use Turnkey's React Native SDK + native passkey stamper. Parent-org API key on the
  server can create sub-orgs and read metadata; it **cannot move funds**.
- **Passkey prompt restriction**: fetch the account's credential ids from
  `turnkey/credentials` and pass them as `allowCredentials` so the OS prompt does not offer
  passkeys from other accounts (web: `lib/turnkey/passkey-stamper.ts`).
- **Lazy asset creation (HARD RULE)**: never create addresses for all chains at signup. A
  chain address is created on first use of that asset (Turnkey bills per address).
- **Autopilot** (optional, per user): a delegated "Normal Autopilot" API user + policy inside
  the user's sub-org lets the server sign the Base-chain legs of CCTP swaps. Server-side
  only; app just calls `autopilot/status` and the consent ceremony route.
- Wallet **export** on web uses `@turnkey/iframe-stamper` (browser only). Use Turnkey RN
  SDK's export flow instead.

## 5. Feature engines to port (logic, not UI)

Web source of truth, in `packages/web/src/`:

- `sections/swap/engines/` — `use-soroswap-engine.tsx`, `use-lifi-engine.tsx`,
  `use-cctp-engine.tsx`, `types.ts` (`canPair`, routing groups), `gas-reserve.ts`,
  `autopilot-gate.ts`, `lifi-tracker.ts`.
- `lib/cctp/` — burn builders (`burn-stellar.ts`, `burn-evm.ts`), `pivot-swap.ts`,
  `hookdata.ts`, `decimals.ts`, `addresses.ts`, `config.ts`.
- `lib/lifi/execute.ts` — executes a LI.FI quote per chain (BTC PSBT via Turnkey raw
  sighash signing; EVM via viem; Solana via web3.js).
- `lib/turnkey/` — `evm-signer.ts`, `stellar-signer.ts`, `passkey.ts`,
  `passkey-stamper.ts`, `add-account.ts`, `autopilot-consent.ts`.
- `lib/savings/`, `lib/send/`, `components/_common/send-adapters/{bitcoin,ethereum,solana,stellar}.ts`.
- `lib/chains/registry.ts` — **CHAINS registry (HARD RULE: every chain-varying value lives
  here, never hard-coded)**.

Client crypto libraries used: `@stellar/stellar-sdk`, `viem`, `@solana/web3.js`,
`bitcoinjs-lib` (v7, no Node Buffer), `bignumber.js`. In RN these need polyfills
(`react-native-get-random-values`, Buffer, TextEncoder, URL). Expect friction here.

### CCTP composite flow (so the UX makes sense)

Outbound USDC(Stellar) → BTC/ETH/SOL: user signs approve + `deposit_for_burn` on Stellar →
Circle attests (~7s) → our relayer mints USDC to the user's own Base address → LI.FI swap
Base USDC → target (user signs, or Autopilot signs) → done. Inbound reverses it: LI.FI to
USDC on Base → user burns on Base → relayer mints on Stellar (delivers **USDC on Stellar**,
never XLM). Minimum $10. Progress must survive the app being closed: rows live in
`cctp_transfers` and the server cron finishes them; the client shows a recovery surface for
any row needing a signature.

## 6. Not portable — plan replacements

- **UI**: 276 MUI/Emotion component files. Full native rebuild. Reuse hooks + logic only.
- **External Stellar wallets** (Freighter, Lobstr, Ledger via `stellar-wallets-kit`):
  browser extensions. Only WalletConnect is possible on mobile. `packages/state` imports
  extension APIs directly and must be split into portable vs web-only.
- **Turnstile captcha** (web widget) → mobile-appropriate bot protection.
- **MoneyGram SEP-24** opens a browser flow → needs in-app browser + deep-link return.
- **Window events** (`nf:cctp-resume`, `nf:session-expired`, etc.) and `localStorage`
  caches in ~12 engine/lib files → replace with an event emitter + AsyncStorage/SecureStore.
- Analytics: PostHog is not actually integrated on web (dead env vars only); pick the mobile
  analytics stack fresh.

## 7. Environments and credentials

| Env | Backend (API base URL) | rpId | Whose passkeys work |
|---|---|---|---|
| localhost web | `http://localhost:8082` | `localhost` | only in a browser on localhost — **never in the app** |
| staging (develop branch) | `https://staging.normalfinance.io` | `normalfinance.io` | any account created on staging/prod web or in the app |
| production (master) | `https://www.normalfinance.io` | `normalfinance.io` | same as staging |

Mobile `EXPO_PUBLIC_API_BASE_URL` = the staging URL during development, the www URL in
production builds. The bare `normalfinance.io` redirects to www for everything except
`/.well-known/*` (association files, live since 2026-09-10).

Supabase Auth project is shared by localhost/staging/prod (one identity per email).
Mobile development targets **staging**, with a staging account. Passkeys must live in a
keychain the phone can reach (iCloud Keychain for iOS, Google Password Manager for Android),
or simply create a fresh account from the app.

## 8. Hard rules carried over from the web project

1. **Never git commit or push** for Niko; stage/merge is fine, hand over the message.
2. **Never write to `.env` or secrets files**; name the vars and exact lines instead.
3. **No guessing** — verify in code before asserting; label shortcuts and their trade-offs.
4. **Explain as cause → effect** ("if you do X you will see Y"), direct answer first, decode
   big diffs into categories with counts, give verifiable test steps.
5. **Scale-first**: thousands of users; think rate limits, N+1, blast radius.
6. **Never use the `**` operator on BigInt** (transpiles to `Math.pow`, crashes at runtime).
7. **Lazy asset creation** and **chain registry** rules above.
8. **LI.FI Bitcoin PSBTs**: sign exactly what LI.FI builds, never reorder or add outputs
   (Chainflip cannot refund malformed deposits — permanent loss).
9. Self-completing money state always has a UI surface owned by no modal; explicit user
   clicks bypass freshness heuristics; resume intent goes in the URL/route params, not an
   event.

## 9. Open items at hand-off (2026-09-10)

- Association files are prepared in the web repo (`packages/web/public/.well-known/
  apple-app-site-association` + `assetlinks.json`, validator
  `scripts/check-passkey-association.mjs`). Apple Team ID `FA938A596N` (Normal Finance, Inc.)
  is filled in; the Android cert SHA-256 is still the all-zero placeholder until
  `eas credentials -p android` produces the keystore.
- **Apex redirect: RESOLVED 2026-09-10.** The apex now serves the production deployment in
  Vercel; `next.config.mjs` redirects apex→www for everything except `/.well-known/*`.
  Verified live: `https://normalfinance.io/.well-known/apple-app-site-association` → 200 JSON,
  `https://normalfinance.io/savings` → 307 to www. Re-check any time with
  `node packages/web/scripts/check-passkey-association.mjs --live`.
- Bundle identifiers chosen: iOS `io.normalfinance.app` (prod) and `io.normalfinance.app.dev`
  (dev/staging builds); Android package `io.normalfinance.app`. Change in both the app
  config and the association files together if renamed.
- Mobile passkey stack: `@turnkey/http` + `@turnkey/react-native-passkey-stamper` +
  `react-native-passkey` (low-level, mirrors the web's `@turnkey/http` + webauthn-stamper).
  NOT `@turnkey/react-native-wallet-kit` (that is Turnkey's hosted auth-proxy model; our
  server creates sub-orgs itself via `POST /api/turnkey/wallet`).
- `createPasskey()` from the RN stamper returns `{ challenge, attestation: { credentialId,
  clientDataJson, attestationObject, transports } }` — exactly the body
  `POST /api/turnkey/wallet` already expects. Same route, no server change.
- Extract a shared `core` package from `packages/web` (API client, engines, signers) so web
  and mobile share one implementation.
