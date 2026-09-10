# Answers for the mobile app agent

**From:** the Claude Code session in `normalfinance/normal-v1-interface` (web)
**To:** the Claude Code session in `normalfinance/mobile`
**Date:** 2026-09-10

Every answer below was verified in code today. Paths are relative to `packages/web/` unless
prefixed with `../` (sibling monorepo packages) or `docs/`. "Not found in code" means exactly
that. No secret values appear here; env vars are named only.

**Strong recommendation before anything else:** clone `normal-v1-interface` on the MacBook next
to the mobile repo and add to the mobile `CLAUDE.md`: "The web app source is at
`../normal-v1-interface`; read it before asking." Most of these fifty questions are file reads.

---

## P0 — Environment, auth, API conventions

### Environment

**Q1. Network.** All three are still read. `NEXT_PUBLIC_NETWORK` → `getCurrentNetwork()`
(`../utils/src/network/index.ts:3-9`): **anything other than exactly `mainnet` (case-insensitive)
falls back to `testnet`**. The `normal-network` cookie is written by the client store
(`../state/src/state/network/store.ts:5-36`) and read by `networkFromCookie` in
`src/server/network-cookie.ts:31-40` (order: `?network=` override → cookie → deployment default),
used by 15 route files (swap, send/execute, cctp/*, savings/*, fees/*, mgi/sep10/complete,
transaction). `?network=` is honoured on only five routes: `savings/vault-info`,
`savings/user-position`, `savings/earnings-history`, `portfolio/activity`, `wallet/portfolio`;
three routes (`wallet/portfolio`, `savings/earnings-history`, `activity/stellar`) have their own
literal that defaults to **mainnet** instead of the deployment default.
The deployed `NEXT_PUBLIC_NETWORK` value is Vercel env, not in the repo; the team runs staging
and production as mainnet. **Rule for mobile:** send the header `Cookie: normal-network=mainnet`
on every request (RN `fetch` lets you set it), and `?network=mainnet` on the five routes that
take it. That makes the answer independent of any deployment default. Omitting both works only
as long as every deployment stays mainnet-locked.

**Q2. Env var list.** The authoritative list is what code reads, guarded by
`src/utils/turbo-env-audit.test.ts:61-79` which asserts every `process.env.X` read in
`packages/web/src` and `packages/utils/src` is declared in `turbo.jsonc`. **`.env.example` is
stale and partly wrong**: it lists dead vars (`*_LONG_SHORT_PAIR_FACTORY`, `*_INDEX_FACTORY`,
`*_TREASURY`, `*_DEPLOYER`, `*_POL`, `*_SIGNING_KEY`, `NEXT_PUBLIC_ONRAMPER_API_KEY`,
`ADMIN_SECRET`, `NEXT_PUBLIC_STELLAR_STARTING_BALANCE`, `NEXT_PUBLIC_CRISP_WEBSITE_ID`,
`NEXT_PUBLIC_*_NETWORK_PASSPHRASE`) and it **misnames the Supabase vars**:
`.env.example:97-104` has `NEXT_PUBLIC_SUPABASE_TESTNET_URL`, code reads
`NEXT_PUBLIC_TESTNET_SUPABASE_URL` (`src/lib/createSupabaseClient.ts:6-13`). Copying it
verbatim yields no Supabase URL. Server-only vars (58) include `TURNKEY_*`, `AUTOPILOT_*`,
`CCTP_*`, `LIFI_API_KEY`, `LIFI_FEE`, `SOROSWAP_*`, `DEFINDEX_API_KEY`, `COINGECKO_API_KEY`,
`HELIUS_API_KEY`, `ETHERSCAN_API_KEY`, `UPSTASH_*`, `DATABASE_*`, `CRON_SECRET`,
`NORMAL_FEES_DEPOSIT_ADDRESS`, `NORMAL_SWAP_FEE_BPS`, `GEOIP_*`, `CRISP_SECRET_KEY`,
`CUSTOMERIO_*`, `COINBASE_*`, `MGI_ACCESS_HOST`, `EDGE_CONFIG`. The Turnkey API base URL is a
hardcoded literal, not an env var. **PostHog is dark**: no client, no key read anywhere; the
only reference is a commented import (`src/middleware.ts:21`). Ignore any doc saying otherwise.
Edge Config (`src/lib/edge-config.ts`, fails open to fallbacks): keys `maintenance.*`,
`features.*`, `api.<endpoint>`, `rateLimit.*`, `security`, `circuitBreaker.*`; wired onto only
`referral/*` and `send` via `createEdgeConfigHandler` (maintenance → 503, endpoint disabled →
503). **No `features.*` flag gates anything today**; the Edge Config rate-limit numbers are read
and ignored (hardcoded limiters win).

**Q3. `EXPO_PUBLIC_*` set for mobile** (what web ships in its bundle, so shippable in an APK):

| Web var | Used for | Mobile |
|---|---|---|
| `NEXT_PUBLIC_MAINNET_SUPABASE_URL`, `NEXT_PUBLIC_MAINNET_SUPABASE_ANON_KEY` | Supabase (`createSupabaseClient.ts:6-13`) | required |
| `NEXT_PUBLIC_TURNKEY_RP_ID` | passkey rpId (`passkey-stamper.ts:24`) | required, `normalfinance.io` |
| `NEXT_PUBLIC_ETH_RPC_URL`, `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_BASE_RPC_URL` | client RPC (`src/lib/chains/rpc-fallback.ts:12-30`) | required for LI.FI/CCTP/send |
| `NEXT_PUBLIC_CDN_URL` | icons/assets (`../utils/src/cdn.ts:2`) | required |
| `NEXT_PUBLIC_AUTOPILOT_PUBLIC_KEY` | autopilot consent (`autopilot-card.tsx:57`); absent = feature dark | optional |
| `NEXT_PUBLIC_MAINNET_*` Stellar constants (Horizon URL, Soroban RPC URL, USDC issuer/address, XLM address, DeFindex vault, oracles) | `../utils/src/constants/stellar.ts:24-92` | required for Stellar flows |
| `NEXT_PUBLIC_NETWORK` | network default | set `mainnet` |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile widget | not portable, see Q9 |
| `NEXT_PUBLIC_LIFI_INTEGRATOR` | read **server-side only** (`src/server/lifi-quote.ts:71`) | not needed |
| Turnkey **org id** | `TURNKEY_ORGANIZATION_ID` is **server-only**; sub-org ids arrive as data | not needed |
| PostHog key, Crisp website id | not read anywhere | not needed |

Copy values from the web `.env` mainnet entries. Never ship `TURNKEY_API_PRIVATE_KEY`,
`LIFI_API_KEY`, `DEFINDEX_API_KEY`, `DATABASE_*` or any of the 58 server-only vars.

**Q4. Staging and safe testing.** Staging = `https://staging.normalfinance.io` (Vercel, develop
branch). **Staging runs mainnet with real funds**; it shares the mainnet Supabase project with
production. Safety mechanisms in code: CCTP min $10 always (`cctp/quote/route.ts:43-46`,
`cctp/transfers/route.ts:81-84`); CCTP pilot cap `CCTP_PILOT_MAX_USD` (quote route defaults
to $50, create route caps only when the env is set, `cctp/transfers/route.ts:85-96`); autopilot
`AUTOPILOT_MAX_TX_USD` / `AUTOPILOT_MAX_DAILY_USD` (unset = unlimited) and kill switch
`AUTOPILOT_DISABLED=1` (`src/server/autopilot-signer.ts:87-91,132`); Stellar send plan blocks
below 1 XLM activation minimum and missing trustlines (`src/lib/stellar/send-plan.ts:30-48`).
**No mocks, no dry-run flags, no MSW** anywhere. The team tests with small real amounts
($10–$50) on staging accounts. Do the same.

### Auth

**Q5. Supabase methods used** (all in `src/services/auth.ts`): `signInWithOAuth` **Google only**
(`:11-16`; no Apple), `exchangeCodeForSession` PKCE (`:28`), `signInWithPassword` (`:38-42`),
`signUp` (`:51-58`), `resend` (`:67-71`), `signInWithOtp` with `shouldCreateUser: true` (OTP
and magic link, `:76-83`), `verifyOtp` type `email` (`:88-92`), `resetPasswordForEmail`
(`:101-104`), `updateUser` (`:114-116`). All take `captchaToken`. UI: `auth-login-modal.tsx`
(`:165,169,185,214,249`) and `onboarding-wizard.tsx` (`:578-638`); there are **no `/auth/sign-in`
pages**, auth is modal/wizard only. Client config `flowType: 'pkce'`, `detectSessionInUrl: false`
(`createSupabaseClient.ts:15-22`). Apple Sign-In will be required by App Store review if you
offer Google; that is new Supabase dashboard config plus a provider row, not a code conflict.

**Q6. Redirect URLs.** Every redirect is `${window.location.origin}/auth/callback` or
`/auth/reset-password` at runtime (`src/services/auth.ts:4-5,48-49,64-65,81,98-102`);
`NEXT_PUBLIC_SITE_URL` plays no part. The Supabase allowlist is **dashboard config, not in the
repo**. No objection to adding `normalapp://auth/callback`; ask Niko to add it in Supabase Auth →
URL Configuration. Use the PKCE flow with `expo-auth-session` / `WebBrowser.openAuthSessionAsync`.

**Q7. `withAuth`** (`src/lib/with-auth.ts:43-55`) checks exactly one thing: `Authorization`
header, `split(' ')[1]` (scheme not validated, `src/utils/http.ts:15-19`) → `supabase.auth.getUser(token)`
with a 30s positive / 5s negative cache and 5s timeout (`createSupabaseServerClient.ts:60-147`).
**Nothing checks cookies, Origin/Referer, CSRF, Turnstile, the network cookie, geo, or user
status** (banned/KYC/waitlist do not exist in code). Ownership is per route, e.g.
`userOwnsWallet` in `swap/submit-single/route.ts:51`, `send/execute/route.ts:197-205`.
**No route needs a cookie session**; `createSupabaseServerClient` is imported by zero API routes.
Middleware (`src/middleware.ts:201-364`) enforces nothing today: it early-exits on header
`x-mobile-app: true` (`:203`), resolves an IP, and returns `next()`; geo and referral code is
commented out. Public routes (11 of 73): the four `activity/{chain}`, `prices/history`,
`mgi/info`, `savings/vault-info`, `savings/user-position`, `savings/earnings-history`,
`lifi/quote` and `swap/quote` (IP-limited); the four `cron/*` need `CRON_SECRET`.

**Q8. `authedFetch`** (`src/utils/authed-fetch.ts`, 42 lines): sets `Authorization` +
`Content-Type` from `buildAuthHeaders`, caller headers override, `credentials: 'include'`. **Only
401 triggers anything**: `refreshSession()` once, retry once if a session came back, then if
still 401 dispatch `nf:session-expired` (debounced 5s). Never throws, never redirects. The sole
listener (`SupabaseAuthProvider.tsx:68-153`) renders a top banner "Your session expired" with a
Sign in button that reloads `/`. Port this as an event emitter + a banner.
Status semantics: **401** only from `withAuth`/cron auth. **403** = "not your wallet/resource",
never retry (`swap/submit-single:51-56`, `send/execute:197-205`, `cctp/transfers:69-78`, etc.).
**409** = three families: `{ embedded_unavailable: true }` from `swap/quote`/`submit-single` →
fall back to the two-signature path; CCTP autopilot refusals with a `reason`
(`autopilot-disabled`, `not-burnable`, `wallet-mismatch`, `no-usdc`, `not-ready`, ...) →
interactive fallback; in-flight duplicates (`send/execute:216-222`, `cctp/gas-topup:27`).
**423** not found in code. **429** = our limiter (`Too many requests`), or DeFindex upstream busy
(`savings/deposit:104`, retry after a pause), or wallet-link quota (`{ error, reset }`,
`wallets/link:69-79`). **503** = maintenance/disabled endpoint or unconfigured cron secret.

**Q9. Turnstile: client-side widget only, verified by Supabase, not by us.** Rendered in
`auth-login-modal.tsx:643`, `onboarding-wizard.tsx:1301`, `settings-security.tsx:106` with
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`; the token goes to Supabase as `options.captchaToken`
(`src/services/auth.ts:41,55,80,103`). **No API route verifies a Turnstile token**; no
`siteverify`, no `TURNSTILE_SECRET`. So the question for mobile is purely: does the Supabase
project have captcha protection enabled? That is dashboard config. If yes, the RN app must
produce a Turnstile token (a WebView widget works) or the team disables captcha for mobile via
Supabase settings. App Attest / Play Integrity are not integrated anywhere and would be new work.

**Q10. Geo-fencing: coded, parked, not enforced.** `GEOIP_ENDPOINT`/`GEOIP_KEY` are read only
inside `lookup()` in `src/middleware.ts:75-102`, which is never called; the whole block
`:218-361` is commented out pending "finding #35". No API route does a geo check. If re-enabled
it would `NextResponse.redirect` to `/blocked` (`:254-257`), an HTML redirect, which would need a
JSON variant for `/api/*` before mobile could rely on it.

**Q11. Rate limiting** (Upstash Redis, `src/server/rateLimiter.ts`, network-scoped): wallet/user
limiter 30 per 10s sliding; IP limiter 50 per 10s; `quoteRateLimiter` 30 per 10s **by IP** on
`swap/quote` and `lifi/quote`; `faucetRateLimiter` 3 per rolling 24h on `wallets/link`. Most
money routes key on `user.id` (savings/deposit, savings/withdraw, fees/*, swap/submit-single,
lifi/status, ramp/transfers). Routes keying on **wallet + IP together**: `send` (dead), `transaction`,
`referral/*`. **Carrier-NAT risk is real only for the two public quote routes**, which are
per-IP at 30 per 10s: many mobile users behind one IP hammering quotes will collide. Mitigation
is a per-user quote route or a higher IP ceiling for mobile; flag it early. `FORCE_RATE_LIMIT`
affects only `wallets/link`/`check-limit`. Edge Config `rateLimit.*` values are decorative.

### API conventions

**Q12. Shared request/response types.**
`../types/src` is barely used by API routes: only `src/app/api/transaction/route.ts:2,9` imports
it (`NetworkConfig`, `ContractErrorType`). Its API-relevant exports are `ApiToken`/`Token`
(`../types/src/state/token.ts:1-26`) and on-ramp payload types (`../types/src/onramp/*`).
Zod appears in only 5 of 73 routes, all referral/wallet-link: `src/app/api/wallets/link/route.ts:11,19`,
`src/app/api/referral/{activate,actions,codes,user,stats}/route.ts`. Everything else validates by
hand (regex / `typeof`), e.g. `src/app/api/wallet/portfolio/route.ts:52`.
The two ready-made contract types live in web's own `src/types/`, not the types package:
- `src/types/portfolio.ts:1-32` — `PortfolioAsset`, `PortfolioPayload` (documented as shared client/server, free of server imports).
- `src/types/wallet-activity.ts:1-34` — `WalletActivityItem` (discriminated union on `kind`), `WalletActivityResponse`.
Copy these two files into mobile verbatim; redefine nothing else, there is nothing else typed.

**Q13. Error shape.** Not consistent. Two families:
- `{ success: false, error: string }` in 32 of 73 route files, e.g. `src/app/api/wallet/portfolio/route.ts:178-181`, `src/app/api/prices/history/route.ts:93,97,127`.
- Bare `{ error: string, ...extra }` in the CCTP / Coinbase / MGI cluster, e.g. `src/app/api/cctp/quote/route.ts:36-55` (machine codes `below_minimum` + `minAmountWire`, `above_pilot_cap` + `maxAmountWire`), `src/app/api/mgi/sep24/deposit/route.ts:68,86` (`{ error, status }`, `{ error, details }`).
The `j()` helper (`src/utils/http.ts:21-23`) enforces nothing. **Rule for mobile:** `error` is the
only reliable key; never depend on `success` being present; a few errors are codes, most are prose.

**Q14. Browser-only behaviour in routes.** None. No `NextResponse.redirect`, no `Set-Cookie`
(`cookies()` is used read-only for the network cookie, e.g. `src/app/api/portfolio/activity/route.ts:19`),
no HTML, no streaming. MGI routes fetch the anchor with `redirect: 'manual'` and return the
`Location` inside JSON (`src/app/api/mgi/sep24/deposit/route.ts:53,68`). No cookie jar is needed
for the API; auth is the Bearer header only (`src/utils/http.ts:15-19`).

### Legacy — the prototype

**Q15.** `api.normalfinance.io`, `localhost:8095`, `/api/check-wallet`, `/health`, `/status`: **not
found in code** anywhere in `packages/*`. Dead. There is no health endpoint at all under
`src/app/api`. Do not build against any of it.

**Q16.** `cdn.normalapi.com` is the general static-asset host, addressed via
`NEXT_PUBLIC_CDN_URL` (`../utils/src/cdn.ts:1-5`). Token icons: `getCryptoIconUrl(symbol)`
(`../utils/src/ui.ts:10-43`; natives stored by name: `tokens/bitcoin.webp`, `tokens/ethereum.webp`,
`tokens/solana.webp`, `tokens/XLM.webp`, `tokens/USDC.webp`) and `assetDisplay` in
`src/lib/portfolio/display.ts:18-28`. **nBTC / nETH / nSOL are the discontinued synthetics**: the
in-app migration modal says so (`src/components/_common/migration-modal.tsx:37,43`); they survive
only in `public/.well-known/stellar.toml` and a doc comment. `nSOL` not found in code. Use the CDN
for icons, yes; ignore the `tokens/normal/*` path.

**Q17.** Prisma models (`prisma/schema.prisma`): `User`, `Referral`, `ReferralAction`, `LinkedWallet`,
`VaultDeposit`, `SwapLog`, `CctpTransfer`, `MoneyGramTransaction`, `SendLog`, `RampTransfer`,
`OfframpFill`, `TurnkeyWallet` (`:254`), `TurnkeyWalletSeed` (`:274`), `normal_contract_events`.
No `salt` column anywhere. No table stores a seed phrase (`TurnkeyWalletSeed.origin` is a
provenance flag only, `:279`). No legacy prototype registration table exists in the schema.
**Row counts cannot be checked from code**; nothing in this repo reveals whether legacy users
exist. Given the schema has no place for them, a migration path is very unlikely to be needed,
but only a DB query settles it.

---

## P1 — Portfolio, prices, activity

**Q18. `GET /api/wallet/portfolio`** (`src/app/api/wallet/portfolio/route.ts`, `withAuth`, `force-dynamic`).
Request: `Authorization: Bearer <token>`; optional `?stellar=G…` (regex-gated `:52`, else DB address),
`?network=testnet|mainnet` (`:41`), `?refresh=1` bypasses the 15s cache subject to a 5s per-user floor (`:76,:113`).
Response: `{ success: true, ...PortfolioPayload }` (`src/types/portfolio.ts:21-32`):
`updatedAt`, `assets: PortfolioAsset[]` (exactly 5 in fixed order BTC, ETH, SOL, XLM, USDC —
`src/lib/portfolio/aggregate.ts:273-291`), `companionStellar | null`, and on a floored refresh
`floored: true, retryAfterMs`. Each asset: `balance` (string, coin units), `price` (string USD),
`usdValue` (string), `change24h`, `decimals`, `status: 'ok'|'stale'|'error'`.
**Yes, one call returns balances and USD values for all four chains.**
Prices: CoinGecko `simple/price` (`aggregate.ts:42-111`), optional `COINGECKO_API_KEY` (server).
Server cache (Upstash Redis): response 15s, last-good snapshot 24h, spot prices 45s + 7-day
last-good (`route.ts:31-36,169-170`; `aggregate.ts:31,86-89`). Client SWR: `refreshInterval 30s`,
`dedupingInterval 10s`, `revalidateOnFocus` (`src/hooks/use-wallet-balances.ts:120-128`) plus a
localStorage snapshot (`src/lib/portfolio/client-cache.ts`). **No lazy address creation** — the
route only reads `turnkey_wallets` (`route.ts:46-49`). Chains with no address are skipped and
reported as `balance: "0", status: "ok"` (`src/lib/portfolio/normalize.ts:29-38`).

**Q19. Current prices endpoint: none.** `src/app/api/prices/` contains only `history`. USD values
in the UI come from the portfolio payload above. To price an asset the user does not hold, call
`/api/prices/history?symbol=X&range=1d` and take the last point, or add a route.

**Q20. `GET /api/prices/history`** (`src/app/api/prices/history/route.ts`, **public, no auth**).
Params: `symbol` = ticker `BTC|ETH|SOL|XLM|USDC` (`:16-22`); `range` = `1d|1w|1m|1y|5y|all`,
default `1w` (`:32-39`). Response `{ success: true, prices: [timestampMs, priceUsd][], stale?: true }`.
Source: CoinGecko `market_chart` for ≤1y (`:51-63`), Kraken weekly OHLC for `5y|all` (`:67-86`).
Redis TTL 600s (1d/1w), 1800s (1m), 6h (1y/5y/all), 7-day stale copy (`:42-49,:132`). Errors:
404 `Unsupported asset`, 400 `Invalid range`, 502 `Price provider error`.

**Q21. Activity routes.**
- `/api/wallet/activity` — `withAuth` + wallet-ownership check (`:51-56`); reads OUR DB
  (`vault_deposits` + `swap_logs`); params `walletAddress` (Stellar, required), `limit` (default 50, max 100).
- `/api/portfolio/activity` — **dead, zero client callers** (its own header comment `:15-16` says so). Do not use.
- `/api/activity/{bitcoin,ethereum,solana,stellar}` — **public**, external indexers (mempool.space,
  Etherscan v2, Helius, Horizon), params `address`, `refresh=1`; server TTL 45s/300s/300s/60s.
The web feed is `useUserActivity` (`src/hooks/stellar/use-user-activity.ts:289`) merging eight
sources (`:650-672`): wallet/activity, the four chain routes, `cctp/transfers?history=1`,
`ramp/transfers?active=1` + MGI, `coinbase/offramp-status`, `POST lifi/statuses`. Sorted
client-side by timestamp. **There is no pagination anywhere** (no cursor, limits hardcoded,
chain routes capped upstream at 25). Infinite scroll on mobile needs a new endpoint.

**Q22. `src/lib/chains/registry.ts`: zero imports, 188 lines, fully portable as-is.** Chains
(`:63-119`): bitcoin (BTC, 8 dp, `utxo`), ethereum (ETH, 18 dp, `evm`, chainId 1, cctpDomain 0),
solana (SOL, 9 dp, `svm`, cctpDomain 5), stellar (XLM, 7 dp). Each has `addressField`,
`activityPath`, `turnkeyAddressFormat`, `explorerTx()`, `brandColor`. **No icon field** — icons
come from `getCryptoIconUrl` / `assetDisplay` (Q16). USDC is added outside the registry in
`src/lib/portfolio/normalize.ts:18-26` (`chain: 'stellar', decimals: 7`).

**Q23. Formatting helpers.** `../utils/src/format/*` (`fTokenAmount` BigNumber-based,
`shortenAddress`, `fTruncate`, dayjs time helpers) and `../utils/src/helpers/conversion.ts` are
**portable**, no browser or Next imports. `src/utils/format-number.ts` is **not**: line 1 imports
`@/locales` which drags i18next + React providers; its `Intl.NumberFormat` body is otherwise
portable, so port it with the locale passed as an argument. Beware the name collision: two
different `fTokenAmount` functions exist (utils package vs web `format-number.ts:147`).

---

## P1 — Turnkey wallet

**Q24. Config and packages.**
Server (never `NEXT_PUBLIC_`): `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_API_PUBLIC_KEY`,
`TURNKEY_ORGANIZATION_ID` (`src/lib/turnkey/server.ts:12-17`). API base URL is a hardcoded
literal `https://api.turnkey.com` in every client (`stellar-signer.ts:31`, `evm-signer.ts:17`,
`add-account.ts:44,156`, etc.), not an env var. rpId = `NEXT_PUBLIC_TURNKEY_RP_ID`, resolved in
exactly one place, `src/lib/turnkey/passkey-stamper.ts:23-27` (`||` fallback to hostname, then
`localhost`). Autopilot: server `AUTOPILOT_API_PUBLIC_KEY`/`AUTOPILOT_API_PRIVATE_KEY`
(`src/server/autopilot-signer.ts:30-31`), client `NEXT_PUBLIC_AUTOPILOT_PUBLIC_KEY`.
Packages (`package.json:73-77`): `@turnkey/crypto` 2.10.0, `@turnkey/http` 4.1.0,
`@turnkey/iframe-stamper` 2.11.1, `@turnkey/sdk-server` 6.1.0, `@turnkey/webauthn-stamper` 0.6.0.
Mobile equivalents: keep `@turnkey/http` and `@turnkey/crypto`; replace `webauthn-stamper` with
`@turnkey/react-native-passkey-stamper` + `react-native-passkey`; `iframe-stamper` has no RN
equivalent (see Q32); `sdk-server` is server-only.

**Q25. Sign-up, in order.**
1. Supabase account, browser: `src/services/auth.ts:47-51` (`signUp`), also OTP `:76,:88`; driven by `src/components/_common/onboarding-wizard.tsx:578`.
2. Passkey creation, browser: `src/lib/turnkey/passkey.ts:32-78`, WebAuthn `create()` with `rp.id = resolveRpId()`, 32-byte challenge, ES256 + RS256, `attestation: 'direct'`. Returns `{ challenge, attestation: { credentialId, clientDataJson, attestationObject, transports } }`, base64url.
3. Failed-attempt attestation is parked in storage and reused so a retry never mints a second passkey (`src/lib/turnkey/add-account.ts:190-195`, `pending-registration.ts`).
4. Sub-org + wallet, **server**: `POST /api/turnkey/wallet` (`src/app/api/turnkey/wallet/route.ts:45-157`) calls `createSubOrganization` with the parent-org key (`:80-97`): `rootQuorumThreshold: 1`, one root user built by `buildPasskeyRootUser` (`src/lib/turnkey/server.ts:45-70`, `userName = email ?? id`, one authenticator named `Passkey`), wallet `Normal Wallet` with **only the requested chain's account** (`:90-96`).
5. Browser clears the parked registration, re-reads the wallet, marks it as needing backup (`add-account.ts:209-222`).
Request body (`route.ts:54-63`): `{ challenge, attestation: {credentialId, clientDataJson, attestationObject, transports[]}, chain?: 'bitcoin'|'stellar'|'ethereum'|'solana' }`; `chain` defaults to `bitcoin` (`:72`), callers always pass it. **Idempotent**: if a `turnkey_wallets` row exists it returns 200 `{ wallet }` without touching Turnkey (`:47-52`).
Response 201 `{ wallet: { bitcoinAddress, ethereumAddress, solanaAddress, stellarAddress } }` (nulls for unprovisioned chains; `subOrgId`/`walletId` deliberately absent, re-read via GET). 500 `{ error: 'Failed to create wallet' }`.
`GET /api/turnkey/wallet` → `{ wallet: { subOrgId, walletId, ...addresses } | null }` (`:29-38`). `GET /api/turnkey/wallets` → `{ success, wallets: [{ walletId, label, origin, isPrimary, addresses }], subOrgId }` (`src/app/api/turnkey/wallets/route.ts:19-30`), display only.
**The RN passkey stamper's `createPasskey()` returns the same `{ challenge, attestation }` shape, so mobile posts to the same route unchanged.**

**Q26. Signing.** The browser posts passkey-stamped requests **directly to `https://api.turnkey.com`**; no Next route proxies signing. Routes only build unsigned payloads (`api/turnkey/build-btc-tx`), broadcast (`api/turnkey/broadcast-btc`, `api/send/execute`) or read with the parent key. The one server-side signer is autopilot (`src/server/autopilot-signer.ts:181-192`, Base legs only).
Activity per chain:
- **Stellar**: `SIGN_RAW_PAYLOAD_V2`, payload = hex of `tx.hash()` (SHA-256 of the signature base), `PAYLOAD_ENCODING_HEXADECIMAL`, `HASH_FUNCTION_NOT_APPLICABLE` (`src/lib/turnkey/stellar-signer.ts:26,39-47`).
- **EVM**: `SIGN_TRANSACTION_V2`, `TRANSACTION_TYPE_ETHEREUM`, RLP-serialised unsigned tx with `0x` stripped (`src/lib/turnkey/evm-signer.ts:26-42`).
- **Solana**: `SIGN_RAW_PAYLOAD_V2`, payload = hex of `serializeMessage()` with **no pre-hash**, `HASH_FUNCTION_NOT_APPLICABLE`; `r||s` padded to 64 bytes (`src/components/_common/send-adapters/solana.ts:129-162`; LI.FI variant `src/lib/lifi/execute.ts:427-445`).
- **Bitcoin send**: server builds PSBT (`POST /api/turnkey/build-btc-tx`, inputs carry both `witnessUtxo` and `nonWitnessUtxo` because Turnkey's parser needs it, `route.ts:136-145`); client signs `SIGN_TRANSACTION_V2` `TRANSACTION_TYPE_BITCOIN` (`send-adapters/bitcoin.ts:136-143`); broadcast via `POST /api/turnkey/broadcast-btc`.
- **Bitcoin LI.FI swap**: **not** `TRANSACTION_TYPE_BITCOIN` (Turnkey's PSBT parser rejects LI.FI's OP_RETURN output, `src/lib/lifi/execute.ts:336-341`). Sighashes computed locally (`btc-sign.ts:202`), signed in **one** `SIGN_RAW_PAYLOADS` activity with `HASH_FUNCTION_NO_OP` (`:210-224`), DER-encoded and injected as `partialSig`, verified locally before broadcast.
Full activity inventory (17 types) is in `src/lib/turnkey/*`, `send-adapters/*`, `lib/lifi/*`, `autopilot-consent.ts`, `autopilot-revoke.ts`, `wallet-export-dialog.tsx`.

**Q27. Passkey per request; no session.** No `createReadWriteSession`, no client-side API-key stamper, no Turnkey OTP anywhere in `src/`. A fresh `WebauthnStamper` is built per call (`passkey-stamper.ts:112-139`). `runWebauthnCeremony` (`src/lib/turnkey/webauthn-guard.ts:88-103`) serialises ceremonies and retries once on fast `NotAllowedError`, but does not reduce prompts. Autopilot (`src/lib/turnkey/autopilot-consent.ts`) is a one-time ceremony (1 or 2 prompts) creating an API-only user on the user's own sub-org with policy `chain_id == 8453 && value == 0 && to in [USDC, TokenMessengerV2, LiFiDiamond]` (`:49-54`); afterwards Base legs are signed server-side. Stellar legs always take a passkey.
CCTP prompt counts (`use-cctp-engine.tsx`; approvals are MAX/once-ever per spender):

| Direction | No autopilot, first | No autopilot, repeat | Autopilot, first | Autopilot, repeat |
|---|---|---|---|---|
| Outbound USDC(Stellar) → BTC/ETH/SOL | 4 | 2 | 2 | 1 |
| Inbound BTC/ETH/SOL → USDC(Stellar) | 3 | 2 | 1 | 1 |

Extras: a nonce-race rebuild costs one more prompt; a missing chain address costs one in `ChainSetupDialog` before the swap.

**Q28. Stellar signer** (`src/lib/turnkey/stellar-signer.ts`, 60 lines): `TransactionBuilder.fromXDR(xdr, passphrase)` → `tx.hash()` hex → `SIGN_RAW_PAYLOAD_V2` (ed25519, `HASH_FUNCTION_NOT_APPLICABLE`) → `DecoratedSignature` from `r+s` (64 bytes) + `signatureHint()` → appended to `tx.signatures`, returns XDR (`:24-59`). Gotchas: passphrase defaults via `??` to the compiled constant (`:24`), so always pass it explicitly; **Soroban auth entries are not handled**, contract calls rely on invoker `require_auth` after `prepareTransaction` (`src/lib/cctp/burn-stellar.ts:139`), no `SorobanAuthorizationEntry` signing exists; only one signature is appended, existing ones preserved.

**Q29. Lazy address creation.** `ensureChainAccount(chain, uid, email)` (`src/lib/turnkey/add-account.ts:114-230`), four branches: address exists → no-op; wallet exists, chain missing → passkey-stamped `CREATE_WALLET_ACCOUNTS` (`:58-63`) then `POST /api/turnkey/import { walletId, chain }` so the **server** re-reads addresses from Turnkey and writes the DB (a client can never write a spoofed address, `api/turnkey/import/route.ts:17-20`); sub-org without wallet → `CREATE_WALLET`; nothing → passkey + `POST /api/turnkey/wallet`. Derivation paths in `src/lib/turnkey/account-specs.ts` (BIP-84 BTC, BIP-44 ETH, Solana `m/44'/501'/0'/0'`, SEP-0005 Stellar). UI triggers: `chain-setup-dialog.tsx:87` (all three swap engines, savings, asset pages), `normal-wallet-setup-dialog.tsx:177`, `bitcoin-wallet-setup.tsx:33`, `onboarding-wizard.tsx:674`. **Idempotent and retry-safe**: existing-row short-circuit, Turnkey error 6 "path already exists" treated as success (`add-account.ts:65-69`), chain-scoped additive DB write, strict wallet read to avoid a second wallet (`:120-127`).

**Q30. rpId.** `resolveRpId()` is used for both creation (`passkey.ts:41,45`) and signing (`passkey-stamper.ts:113-121`). Source: `NEXT_PUBLIC_TURNKEY_RP_ID`. **No `www.normalfinance.io` or any hardcoded rpId in `src/`** (full grep). Deployed value on staging and production is `normalfinance.io` (deployment env, not readable from the repo; confirmed by the team); local dev sets `localhost`. The apex is served by this Next.js app: `www` is Production, and as of 2026-09-10 the bare `normalfinance.io` also serves Production with an in-app redirect to www that exempts `/.well-known/*` (`next.config.mjs:69-81`). `/.well-known/` holds `apple-app-site-association` (Content-Type forced to JSON, `next.config.mjs:101-113`), `assetlinks.json`, and a pre-existing `stellar.toml`. **Both association files still carry placeholders** (Team ID `TEAMID0000`, all-zero SHA-256); validator `scripts/check-passkey-association.mjs --live`. Live-verified today: apex AASA → 200 JSON, apex `/savings` → 307 www.

**Q31. Import and linked wallets.** Import is a **BIP-39 mnemonic, never a raw private key** (`src/lib/turnkey/import-mnemonic.ts:45-141`): `POST /api/turnkey/import-init` (creates a sub-org with no wallet if needed, returns `{ subOrgId, userId, accounts }`, `import-init/route.ts:81-87`) → `INIT_IMPORT_WALLET` → `encryptWalletToBundle` from `@turnkey/crypto` in the browser (HPKE to the enclave; **not** iframe-based) → `IMPORT_WALLET` → `POST /api/turnkey/import { walletId, expectedStellarAddress?, chain? }` (server re-reads addresses; 201 `{ wallet, stellarMatch, secondary? }`). 2 prompts, 3 first-time. `wallets/link` (POST/PATCH/DELETE) and `wallets/linked` (GET) manage **external Stellar wallets** (Lobstr/Freighter) in `linked_wallets`; DELETE refuses the user's own Turnkey address (`link/route.ts:196-205`). `wallets/check-limit` = **3 wallet links per rolling 24h**, not wallet creation (`check-limit/route.ts:13-63`).

**Q32. Export** (`src/components/_common/wallet-export-dialog.tsx`): reveals the **BIP-39 phrase of one seed**, not per-chain keys. Mechanism: `IframeStamper` at `https://export.turnkey.com` (`:48,176-183`) → passkey-stamped `EXPORT_WALLET { walletId, targetPublicKey }` (`:214-226`, one prompt) → `injectWalletExportBundle` decrypts inside Turnkey's origin; our code sees only ciphertext. UI: Settings → Accounts (`settings-accounts.tsx:860`) and the mandatory post-creation backup gate (`wallet-backup-gate.tsx:46`). **Mobile needs Turnkey's RN export path (`@turnkey/crypto` decrypt with a local ephemeral key); the iframe does not exist in RN.**

**Q33. Recovery if the passkey is lost: NONE, explicitly.** Searched `CREATE_AUTHENTICATORS`, `createAuthenticators`, `addAuthenticator`, `initUserEmailRecovery`, `recoverUser`, `emailRecovery`, `initOtp`, `otpAuth`, `createReadWriteSession`, `stampLogin`: zero matches. Exactly one authenticator is ever registered (`server.ts:55-68`), quorum 1. Supabase password recovery exists (`src/app/auth/reset-password/page.tsx`) but recovers the login, not the wallet. What exists instead: export the phrase beforehand (why the backup gate is mandatory), or support wipes the `turnkey_wallets` row and the user starts with a **new empty wallet** (`api/turnkey/wallet/route.ts:82-86`), or re-import the phrase.
**Consequence for mobile, read twice:** an existing web user can sign in the app **only** if their passkey is a synced platform credential (iCloud Keychain / Google Password Manager) that the phone can present under rpId `normalfinance.io`. The app cannot register an additional passkey for an existing sub-org, because no add-authenticator flow exists on either side. Users who created their passkey in Chrome on Windows have no path into the app today. Building `CREATE_AUTHENTICATORS_V2` (approved by the existing passkey, from a device that has it) is the fix, and it is new code on web too.

---

## P2 — Savings, swap, send

**Q34. Savings deposit, step by step** (hook `src/hooks/stellar/use-defindex-savings.tsx`):
1. Fee split client-side: `feeAmount = getSavingsDepositFee(amount)`, `netAmount = amount - fee` (`:203-204`).
2. USDC balance/issuer pre-flight straight against Horizon from the client (`:226-282`).
3. `POST /api/savings/deposit { amount: net (7dp string), caller }` → `{ success, xdr }`, **one unsigned XDR** built server-side by the DeFindex SDK (`src/app/api/savings/deposit/route.ts:44,80-101`; vault from `NEXT_PUBLIC_MAINNET_DEFINDEX_VAULT`, key `DEFINDEX_API_KEY` server-only). **The route submits nothing.**
4. `POST /api/fees/build-payment { caller, amount: fee, assetCode:'USDC', assetIssuer, sourceSequence: seq(depositXdr), timeoutSeconds: 900 }` → fee XDR chained at sequence+1 (`:321-336`).
5. Client signs **both** before submitting anything (`:341-344`). Signer: Turnkey passkey via `signStellarXdrWithTurnkey` for Normal wallets, Wallets Kit for external.
6. `submitFeePair` (`src/lib/stellar/fee-pair.ts:89-160`) → `POST /api/fees/execute-pair { signedServiceXdr, signedFeeXdr, kind:'savings_deposit', record }`. **The server submits to Horizon** after validating same source, consecutive sequences, fee destination = `NORMAL_FEES_DEPOSIT_ADDRESS`, and writes the DB row `pending` before broadcast (`src/app/api/fees/execute-pair/route.ts:249-334`). Client only polls Horizon if the server reports `servicePending` (`fee-pair.ts:53-76`).
`savings/log-transaction` is **DEPRECATED with no client caller** (`route.ts:14-19`); recording happens inside execute-pair.
Withdraw is identical with `POST /api/savings/withdraw`; commission from `getYieldCommission` (`:494-500`); if commission is 0 it is a single tx sent through the same funnel with `signedFeeXdr: null` (`:590-600`, allowed only for `savings_withdraw`).

**Q35. Fees.** Savings fees are **always a separate classic payment transaction chained at seq+1** (`src/lib/build-fee-payment.ts:86-117`), so the user signs **twice** (deposit) and twice or once (withdraw). Soroswap has two modes (Q37): embedded fee = 1 signature, fee-pair = 2. Definitions in `src/utils/normal-fees.ts`: deposit fee 50 bps (`:9-15`), swap fee 50 bps (`:20-26`), yield commission tiers `≥50,000 → 5%`, `≥2,500 → 10%`, `≥500 → 15%`, else `20%` (`:32-45`), commission = `withdraw × (earnings/currentValue) × tier` (`:53-63`). If the fee tx fails to broadcast it is escrowed in Redis for the cron sweeper and is **not** a user error (`execute-pair/route.ts:318-334`).

**Q36. New Stellar accounts: nobody sponsors them.** `NEXT_PUBLIC_STELLAR_STARTING_BALANCE` appears only in `.env.example` and `turbo.jsonc`, **not found in `src/`**. No `beginSponsoringFutureReserves`, no server `createAccount`. Wallet creation is Turnkey-only, no on-chain op. Funding and trustline happen at first use from the **user's own money** (`src/lib/normal-wallet-setup.ts`, `normal-wallet-setup-dialog.tsx`): activate with XLM from a connected wallet or any exchange via QR (default 4 XLM, min 2), then `changeTrust` sourced by the new account and **signed by the passkey**, submitted client-side to Horizon (`normal-wallet-setup.ts:100-123`). Signup does not force this; the wizard lands on buy/receive (`onboarding-wizard.tsx:666-697`). Mobile must replicate the same "fund first, then trustline" gate before any USDC action.

**Q37. Soroswap.** `POST /api/swap/quote` (unauthenticated, IP-limited; `src/app/api/swap/quote/route.ts:44-62`): body `{ token_in_address, token_out_address, amount, mode, sender?, gross_amount? }`. Without `sender` → quote only. With `sender` → also returns a built **unsigned XDR** (`:199-247`). Fee paths: **embedded** when `SOROSWAP_EMBEDDED_FEE=1` (server env): `feeBps` quote param + `referralId = fees address` build param, fee skimmed inside the same tx, response carries `embedded_fee` (`:119,203,312`) → **1 signature**; **fee-pair** fallback: client quotes net amount and pairs a separate payment (`src/hooks/stellar/use-swap.tsx:121-134,307-392`) → 2 signatures. Circuit breaker degrades embedded → fee-pair for 10 min on upstream failure, signalled `embedded_unavailable` 409. `POST /api/swap/submit-single { signedXdr, record }` **submits server-side** (`withAuth`, ownership by tx source, pending row before broadcast, `{ success, hash }`; `submit-single/route.ts:33-133`). Engine: `src/sections/swap/engines/use-soroswap-engine.tsx` (Soroban-fee affordability gate `:150-158`, trustline/activation gates `:249-288`).

**Q38. LI.FI.** `src/lib/lifi/execute.ts` is `'use client'` and runs in the browser: **ETH** via viem public client (nonce, gas, fee re-pricing, `sendRawTransaction`, `:98-176,247-251`); **SOL** via `Connection(SOL_RPC_URL)` and `sendRawTransaction` (`:413,448`); **BTC** signs locally but broadcasts via `POST /api/turnkey/broadcast-btc` (`:389-393`). The tracker (`src/sections/swap/engines/lifi-tracker.ts:101-134`) also polls chain RPCs from the browser. Client RPC vars (`src/lib/chains/rpc-fallback.ts`): `NEXT_PUBLIC_ETH_RPC_URL` (`:19`), `NEXT_PUBLIC_SOLANA_RPC_URL` / legacy `NEXT_PUBLIC_SOL_RPC_URL` (`:27-30`), `NEXT_PUBLIC_BASE_RPC_URL` (`:12`). **Yes they are shippable in a binary**: they are already in the public web bundle. Bitcoin: no env var, `mempool.space` is hardcoded (server routes, plus one client call for fee rates at `use-cctp-engine.tsx:403`). Keyed server-only `CCTP_RPC_URL_*` stay server-side. `POST /api/lifi/record { fromSymbol, toSymbol, amountIn, amountOut, txHash, feeAmount }` is **not needed for the money but is the swap's only activity row** (`lifi-tracker.ts:245-262`, retried 3×); skip it and the feed has no "Swap A → B" entry. `POST /api/lifi/quote` (unauthenticated, IP-limited): `{ fromSymbol, toSymbol, fromAmount (base units), fromAddress, toAddress, denyBridges?, denyExchanges? }` → `{ success, quote, feePercent }`; integrator = `NEXT_PUBLIC_LIFI_INTEGRATOR`, fee = server `LIFI_FEE`, feeless retry on LI.FI error 1011 (`src/server/lifi-quote.ts:71-129`).

**Q39. CCTP.** Client drives every signature-bearing leg (`use-cctp-engine.tsx`): inbound = LI.FI leg → `PATCH {srcSwapTxHash}` → poll Base USDC arrival (10s, 45 min cap) → autopilot burn or `gas-topup` + `burnUsdcOnEvm` + `PATCH {burnTxHash}` → `pollStatus('COMPLETED')` → `PATCH {dstAmount}` (`:726-876`); outbound = `burnUsdcOnStellar` + `PATCH {burnTxHash}` → `pollStatus` → autopilot pivot or `executePivotSwap` + `PATCH {dstSwapTxHash}` → `pollPivotDelivery` (`:975-1108`). Cron (`api/cron/cctp-advance`, `CRON_SECRET`) owns the bridge middle and every abandoned row via `advancePendingTransfers` (`src/lib/cctp/state.ts:347-416`): expiry of never-broadcast rows, attestation → mint → confirm, closed-tab inbound burn, stalled outbound pivot. Every `GET cctp/transfers/[id]` also advances unless `?noAdvance=1`.
Polling: inbound bridging 15 s, outbound bridging 5 s, arrival 10 s, pivot delivery 10 s, recovery banner 30 s (`use-cctp-engine.tsx:873,993,826-830`; `cctp-resume-banner.tsx:199`).
"Needs a signature" is the pure table `bannerPhase` in **`src/sections/swap/cctp-phase.ts:25-46`**: REFUNDED/FAILED → hidden; outbound: `dstSwapTxHash` set → hidden, no `burnTxHash` → hidden, `mintTxHash` set or COMPLETED → **`halt-finish`** (needs pivot signature); inbound: COMPLETED → hidden, `burnTxHash` set → `auto` (spinner), `srcSwapTxHash` set → **`halt-receive`** (needs burn signature). **Port this file verbatim.**
Resume: both halts start with `POST /api/cctp/gas-topup { transferId }` then ~6 s. `halt-receive`: read Base USDC; 0 → `PATCH { markSourceRefunded: true }`; else `burnUsdcOnEvm` → `PATCH { burnTxHash, dstAmount }`. `halt-finish`: `executePivotSwap` → `PATCH { dstSwapTxHash, dstAmount }`; on revert `PATCH { pivotRevertTool, pivotRevertTxHash, pivotRevertExchanges }`. Refund ("Bring back as USDC", outbound only, `src/lib/cctp/refund.ts:17-130`): `POST /api/cctp/transfers { direction:'crosschain_to_stellar', refund:true, refundOfTransferId, ... }` → topup → burn → `PATCH new { burnTxHash, dstAmount }` + `PATCH original { markRefunded:'true' }`.

**Q40. Autopilot.** The consent ceremony is **not a server route**; it runs in the browser against Turnkey (`src/lib/turnkey/autopilot-consent.ts:73`, `grantAutopilotConsent(NEXT_PUBLIC_AUTOPILOT_PUBLIC_KEY)`). The passkey signs up to two activities on the user's sub-org: `CREATE_API_ONLY_USERS` (user "Normal Autopilot" with the server's P-256 public key, `:101-114`) and `CREATE_POLICY_V3` (`normal-autopilot-base-legs`, allow when approver is that user and `eth.tx.chain_id == 8453 && eth.tx.value == 0 && eth.tx.to in [USDC-Base, Circle TokenMessengerV2, LI.FI Diamond]`, `:49-54,125-136`). `GET /api/autopilot/status` → `{ active, autopilotUserId, subOrgId }`, truth read from Turnkey, masked by the `AUTOPILOT_DISABLED` kill-switch. Payoff routes `POST /api/cctp/autopilot/burn` and `/pivot` `{ transferId }`. Revoke = one prompt `DELETE_USERS` (`autopilot-revoke.ts:20-27`). Mobile can run the same ceremony with the RN stamper unchanged.

**Q41. Send.** `POST /api/send` is a **pre-flight rate-limit gate with zero callers** (`src/app/api/send/route.ts`); ignore it. `POST /api/send/execute { chain:'ethereum'|'solana', signedTx, symbol, amount, destination }` is the real funnel for **native ETH/SOL** (`src/app/api/send/execute/route.ts:164-260`): decodes the signed tx and cross-checks destination + amount (`:52-102`), asserts sender = the user's Turnkey address (`:192-206`), 409 if a prior send is still unsettled (`:212-224`), pending row before broadcast, returns `{ success, txHash, confirming }`. Stellar and Bitcoin sends do **not** use it (Stellar via `useSendToken` client-side; BTC via `turnkey/build-btc-tx` + `broadcast-btc`). `GET /api/stellar/memo-required?address=G…` (stellar.expert tag + SEP-29 data entry, Redis-cached) is checked in the send modal before enabling the button (`send-modal.tsx:505-524,639`), via `src/lib/stellar/memo-required.ts` which consults a seed list first and fails open to it.

---

## P3 — Ramps, extras, code sharing

**Q42. MoneyGram SEP-24.** Web opens the anchor in a **full browser tab** (not a popup: their
frontend renders blank in small popups, `src/lib/mgi/flow.ts:10-15`), pre-opened synchronously in
the click handler as a placeholder then navigated (`flow.ts:29-41`), because WebAuthn steals focus
otherwise. Completion is learned by **`postMessage`** from the anchor (`flow.ts:96-116`, two
shapes: legacy `event.data.transaction` or `{ type:'COMMIT_RESULT', payload:{ transaction } }`;
closes when `status === 'pending_user_transfer_start'`; **no origin check**), plus polling:
`getTransaction` every 4s ×45 (`src/lib/mgi/client.ts:330-352`), a 15s dialog watcher only when a
SEP-10 token is cached (`onramp-dialog.tsx:215-238`), and `GET /api/mgi/transactions` SWR at 60s.
Single-tx reads send the SEP-10 token in header `x-mgi-token` (`src/lib/mgi/history.ts:13-15`).
**No `callback` URL is sent anywhere** (`sep24/deposit/route.ts:42-49`, `withdraw/route.ts:38-44`):
the SEP-24 `callback` param is standard and MoneyGram likely honours it, but adding it is new
code, and mobile cannot rely on `postMessage`. Plan: in-app browser + poll `mgi/transactions/[id]`.

**Q43. Coinbase.** `POST /api/coinbase/session { address, asset='USDC', blockchain='stellar' }`
(`withAuth`; allowlist stellar/bitcoin/ethereum/solana) → Coinbase's `{ token }` verbatim
(`src/app/api/coinbase/session/route.ts:10-63`). The pay URL is built client-side by
`createCoinbasePayOnrampURL` / `createCoinbasePayOfframpURL` in `../utils/src/onramp/coinbase.ts:36-93`
with **`redirectUrl` set per call** (e.g. `onramp-dialog.tsx:336`, `offramp-dialog.tsx:345`);
`partnerUserRef` = Supabase uid, never email (`offramp-status/route.ts:25-30`). Coinbase's
redirect allowlist is CDP dashboard config; a native scheme must be added there. Gotcha: the
session URL is single-use; never hand it to anything that prefetches (`offramp-dialog.tsx:289-295`).
**Onramper is dead** (`src/global-config.ts:14-16`; `createOnramperURL` returns a hardcoded string
with zero callers). Live ramps: Coinbase, MoneyGram, static Stripe link.

**Q44. Referrals.** Code = 8 chars `[A-Z0-9]` via `Math.random()` (`src/lib/referral-service.ts:258-265`),
custom codes allowed. URL params `ref` / `referral` / `referrer` (`src/hooks/use-referral-tracking.ts:47`).
**No share-link UI exists.** Middleware referral capture is dead (`handleReferralTracking` defined
`src/middleware.ts:104-150`, never called; would also set an `httpOnly` cookie the client cannot
read). Live capture is client-side into a zustand persist store + cookie
(`use-referral-tracking.ts:46-61`, `../state/src/state/persist/createReferralActions.ts`).
Applied on **wallet connect, not signup** (`use-referral-tracking.ts:121-128` → `POST /api/referral/user`,
`GET /api/referral/codes`, `POST /api/referral/activate { code, refereeWalletAddress }`, then records
a `signup` action). Server guards: unknown/used/inactive/self-referral (`referral-service.ts:89-104`).
Mobile: capture from the install/deep link, then call the same three routes after wallet creation.

**Q45. PostHog: not wired.** No `capture`, no `identify`, no init anywhere; only a declared
dependency and a commented import (`src/middleware.ts:21`). Running analytics = Vercel Analytics +
Speed Insights and the Dune cron. **There is no event taxonomy to reuse**; design one fresh.

**Q46. Crisp.** `POST /api/crisp` (`withAuth`) returns `{ signature }` = HMAC-SHA256 of the
user's email with `CRISP_SECRET_KEY` (`src/app/api/crisp/route.ts:11-23`), i.e. Crisp's verified
email hash. **No Crisp widget is mounted anywhere in web**; the route has zero callers. Mobile can
call it for the Crisp SDK's `user_hash`.

**Q47. Customer.io.** `src/lib/customerio.ts` does `identify` only (`POST track.customer.io/api/v2/entity`,
person id = Supabase uid; no-op if `CUSTOMERIO_SITE_ID`/`API_KEY` unset). `GET /api/marketing/opt-in`
→ `{ optIn }` from `user_metadata`; `POST { optIn }` → `cioSetMarketingOptIn`. Called at signup
when the consent box is ticked (`onboarding-wizard.tsx:281-298`) and from Settings
(`settings-general.tsx:53-97`). Contract: the caller must also `supabase.auth.updateUser({ data:
{ marketing_opt_in } })` (route comment `:21-23`).

**Q48. Portability map** (scan for `next/`, `react-dom`, `window`, `document`, storage,
`navigator`, `@mui`, wallets-kit, freighter, lobstr, iframe/webauthn stampers):

| Directory | Files | Offenders | Label |
|---|---:|---|---|
| `../types/src` | 26 | none (but `package.json` declares 7 unused `@mui/*` deps: remove) | portable |
| `../utils/src` | 40 | `stellar/normal-wallet.ts` (`window`) | portable, 1 file to split |
| `../state/src` | 14 | `network/store.ts`, `persist/createDisclaimerActions.ts`, `persist/createReferralActions.ts` (document/localStorage); `stellar-wallet-kit/actions.ts` (wallets-kit + ledger/walletconnect modules) | needs split |
| `src/lib/chains` | 3 | none | portable |
| `src/lib/cctp` | 23 | `active-transfer.ts`, `burn-stellar.ts` (`window`); others only `'use client'` banners | needs split; `hookdata`, `amounts`, `addresses`, `config` are clean |
| `src/lib/lifi` | 13 | `'use client'` banners only, no browser APIs | portable |
| `src/lib/turnkey` | 22 | `passkey-stamper.ts` (webauthn-stamper), `passkey.ts`, `webauthn-guard.ts` (navigator), `pending-registration.ts`, `wallet-backup.ts` (window/storage) | needs split: WebAuthn layer is web-only, **signers are portable** |
| `src/lib/savings`, `src/lib/send`, `src/lib/stellar` | 2 / 2 / 15 | none | portable |
| `src/lib/portfolio` | 12 | `client-cache.ts` (localStorage) | portable behind a storage interface |
| `src/sections/swap/engines` | 10 | the three `use-*-engine.tsx` (window + storage + **MUI**) | web-only, except `lifi-tracker.ts` and `cctp-phase.ts` (portable) |
| `src/components/_common/send-adapters` | 5 | none | **portable as-is** |
| `src/utils` | 29 | `http.ts` (`next/server`), `authed-fetch.ts` (window event), `errors/error-display.ts` (notistack) | needs split, 26/29 clean |
| `src/services` | 6 | `auth.ts` (`window.location.origin` ×6) | needs split |
| `src/hooks` | 45 | 32 flagged; hard blockers: `use-contract-transaction.tsx` (`next/navigation` + MUI), `use-stellar-wallets-kit.tsx`, `use-defindex-savings.tsx`, `use-swap.tsx`, `use-wallet-reconnect.tsx` (MUI) | web-only; rewrite as RN hooks on top of the portable libs |

Also: `@stellar/freighter-api`, `@lobstrco/signer-extension-api`, `@creit.tech/xbull-wallet-connect`
are declared deps of `state`/`utils` with **zero imports**; delete them before any RN consumer.

**Q49. Monorepo constraints.** Workspaces: `packages/{contracts,types,utils,state,web}` (root
`package.json`, private). `types`/`utils`/`state` build with **plain `tsc`** to `build/` (`main` +
`types`, **no `exports` field**, no bundler); `state` targets **ES5**. Turbo `dev`/`test`/`build`
all `dependsOn: ["^build"]`, so the three packages must build before web runs. Not published:
no `private: true`, but `np.publish=false` and Changesets `access: restricted`; effectively
workspace-only. **Toolchain conflict**: root `.nvmrc` 20.14.0 + `packageManager yarn@3.6.4`
(Berry, node-modules linker) vs `packages/web` `engines.node 22.x` + `packageManager yarn@1.22.22`.
Recommendation: put mobile in this monorepo as `packages/mobile` and add `packages/core` (plain
`tsc`, `exports` field, no DOM lib in its tsconfig) consumed by both; Expo + Metro handle yarn
workspaces fine with `nodeLinker: node-modules`, which is already set. Publishing internal packages
or copy-with-sync both add drift for no benefit. Resolve the Node/yarn mismatch first.

**Q50. Rules that will bite a second client** (all verified in code comments or guards):
1. **CCTP EVM burn custody**: `mintRecipient` = CctpForwarder, `destinationCaller` = same, real recipient only in `hookData`; wrong = permanent loss (`src/lib/cctp/burn-evm.ts:7-11`, `hookdata.ts:1-16`). Verify the USDC trustline before burning.
2. **Never burn to a zero/invalid recipient**; runtime guards exist (`burn-stellar.ts:153-158`, `burn-evm.ts:68-72`).
3. **LI.FI BTC PSBTs: only ever add signatures**, never touch outputs (`src/lib/lifi/execute.ts:17-21`, `btc-sign.ts:24-27`); bypass Turnkey's PSBT parser (`btc-sign.ts:12-22`); the one pre-sign check is spend ≤ quoted + headroom, not output count (`btc-spend-verdict.ts:1-30`).
4. **Take only what THIS transfer is owed** on Base (live loss 2026-08-26: whole-balance burn stranded a sibling row, `src/lib/cctp/amounts.ts:1-16`).
5. **Fee escrow safety = Stellar sequence numbers** (fee seq = service seq + 1; retries reuse sequences so double-charge is impossible, `src/server/fee-escrow.ts:18-32`).
6. **Memo-less Stellar send to an exchange = silently lost credit**; three layers required, the SDK's SEP-29 check alone is proven insufficient (`src/lib/stellar/memo-required.ts:8-28`).
7. **Coinbase offramp amounts must be crypto-denominated**; Coinbase sometimes returns EUR (`coinbase-offramp-modal.tsx:155-163`).
8. **BTC MAX = UTXOs minus sweep fee**, never the full balance (`send-adapters/bitcoin.ts:84-89`); **BTC broadcast is idempotent by pre-computed txid** to avoid double-spend on timeout (`api/turnkey/broadcast-btc/route.ts:45-51`).
9. **Never show "Done" against a stale balance**; refetch the destination chain first (`lifi-tracker.ts:174-178`).
10. **Wallet slot invariants** (`src/lib/wallet-slot.ts:12-58`): never silently pick a wallet when a choice exists; creation flows adopt only into an EMPTY slot; login must not switch an external wallet to Turnkey; a kit-module mapping failure ≠ disconnect (`use-stellar-wallets-kit.tsx:144-153`). Mostly moot on mobile (no extensions) but the "companion" concept stays.
11. **Never pre-open a browser before a WebAuthn ceremony** (focus loss kills it, `src/lib/mgi/flow.ts:23-27`). RN analogue: do not present a WebBrowser and a passkey prompt in the same tick.
12. **rpId byte-identical at registration and signing**, `||` not `??` for the env read (`passkey-stamper.ts:17-25`); **always pass `allowCredentials`** (`:8-16`).
13. **Check the wallet-link limit BEFORE the passkey ceremony**; the ceremony is the irreversible half (`normal-wallet-setup-dialog.tsx:161-168`).
14. **A new seed MUST be marked for backup and the mark awaited** (`add-account.ts:208-219`).
15. **Bound every shared in-flight promise** (10s; `wallet-info.ts:27-31`).
16. **"Arrived" requires the chain, not the provider's word**; abandon after 45 min (`src/lib/ramp/status.ts:1-14`).
17. **Never use `**` on a BigInt** (build transpiles to `Math.pow`, runtime crash).
18. **Chain-varying values live in `lib/chains/registry.ts`**, never hardcoded.
19. **Lazy asset creation**: one chain address at signup, others on first use.
20. **Self-completing money state always has a UI surface owned by no modal**; explicit clicks bypass freshness heuristics; resume intent goes in route params, not events.

---

## Recommended next steps for the mobile session

1. Clone the web repo beside the mobile repo; read `packages/web/src/lib/chains/registry.ts`,
   `src/types/portfolio.ts`, `src/types/wallet-activity.ts`, `src/sections/swap/cctp-phase.ts`
   and `src/components/_common/send-adapters/*` first. They port verbatim.
2. Build the API client from Q7/Q8: Bearer header, `Cookie: normal-network=mainnet`, one
   401-refresh-retry, `error` as the only reliable error key.
3. Signup = Supabase `signUp` → RN `createPasskey` → `POST /api/turnkey/wallet { ..., chain:'stellar' }`.
4. Do not promise existing-user signin until the synced-passkey question (Q33) is settled.
