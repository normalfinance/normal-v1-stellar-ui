import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = readFileSync(path.join(__dirname, 'package.json'), 'utf-8');
const { version } = JSON.parse(packageJson);

/** @type {import('next').NextConfig} */

const isStaticExport = 'false';

const nextConfig = {
  // Gate builds run alongside the dev server, and both default to `.next` —
  // the dev server rewrites it mid-build, which fails prerendering with
  // random "Cannot find module" errors (recurring all of 2026-08-17). Setting
  // NEXT_BUILD_DIR points a verification build at its own directory; unset
  // (dev, Vercel) everything stays exactly as before.
  distDir: process.env.NEXT_BUILD_DIR || '.next',
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.normalapi.com',
        port: '',
        pathname: '/**',
        search: '',
      },
    ],
  },
  trailingSlash: true,
  // #13: clients fetch '/api/...' slash-less while trailingSlash canonicalizes
  // to '/api/.../' — so EVERY API call paid a 308 redirect + second round trip.
  // Skipping the redirect serves both forms directly (verified empirically:
  // docs/audit/64). Internal links still generate slashed URLs, so page
  // canonical behavior is unchanged.
  skipTrailingSlashRedirect: true,
  env: {
    BUILD_STATIC_EXPORT: isStaticExport,
    NEXT_PUBLIC_APP_VERSION: version,
  },
  modularizeImports: {
    '@mui/icons-material': { transform: '@mui/icons-material/{{member}}' },
    '@mui/material': { transform: '@mui/material/{{member}}' },
    '@mui/lab': { transform: '@mui/lab/{{member}}' },
  },
  experimental: {
    // reactCompiler: true, // <-- remove/gate this on Next 14
    turbo: {
      resolveAlias: {
        '@normalfinance/types': '../types/src',
        '@normalfinance/utils': '../utils/src',
        '@normalfinance/contracts': '../contracts/src',
        '@normalfinance/state': '../state/src',
      },
    },
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      use: ['@svgr/webpack'],
    });
    // Do NOT override devtool in dev (avoids Next warning/perf hit)
    return config;
  },
  async redirects() {
    return [
      // Apex → www canonicalization, done HERE instead of in Vercel's domain
      // settings, because Apple and Google fetch the passkey association files
      // from the bare rpId domain (https://normalfinance.io/.well-known/…) and
      // refuse any redirect. Vercel's domain-level redirect cannot exempt a
      // path; this rule can. Inert while Vercel still redirects the apex
      // itself (those requests never reach Next); becomes THE redirect once
      // the apex is switched to "serve" in the Vercel dashboard.
      {
        source: '/:path((?!\\.well-known(?:/|$)).*)',
        has: [{ type: 'host', value: 'normalfinance.io' }],
        destination: 'https://www.normalfinance.io/:path',
        permanent: false,
      },
      {
        source: '/invest',
        destination: '/swap',
        permanent: true,
      },
      {
        source: '/earn',
        destination: '/savings',
        permanent: true,
      },
      {
        source: '/indexes/:path*',
        destination: '/',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      // Native passkeys (mobile app): iOS fetches this file to learn which apps
      // may use `normalfinance.io` passkeys. It has no extension, so Next would
      // serve it as application/octet-stream; Apple wants JSON. The Android
      // counterpart (assetlinks.json) already carries .json. Both live in
      // public/.well-known/ and are validated by
      // scripts/check-passkey-association.mjs.
      {
        source: '/.well-known/apple-app-site-association',
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Cache-Control', value: 'public, max-age=3600' },
        ],
      },
      {
        source: '/api/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: 'normalfinance.io',
          },
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET, POST, PUT, DELETE, OPTIONS',
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type, Authorization',
          },
        ],
      },
    ];
  },
  ...(isStaticExport === 'true' && { output: 'export' }),
};

export default nextConfig;
