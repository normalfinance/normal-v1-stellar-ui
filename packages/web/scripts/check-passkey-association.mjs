#!/usr/bin/env node
// Validates the two domain-association files that let the mobile app use
// `normalfinance.io` passkeys:
//   public/.well-known/apple-app-site-association   (iOS, webcredentials)
//   public/.well-known/assetlinks.json               (Android, get_login_creds)
//
// Why a script: a typo here fails silently. iOS just never offers the passkey,
// and the error the user sees is "no passkey found" — nothing points back at
// this file. So the checks that a human would forget live here.
//
// Usage:
//   node scripts/check-passkey-association.mjs           # validate local files
//   node scripts/check-passkey-association.mjs --live    # also fetch them from
//                                                        # https://normalfinance.io
//
// Exit code 1 on any problem, so it can gate a deploy.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOMAIN = 'normalfinance.io';
// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/…" which
// path.resolve then treats as relative to the current drive.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', '.well-known');
const AASA_PATH = resolve(ROOT, 'apple-app-site-association');
const ASSETLINKS_PATH = resolve(ROOT, 'assetlinks.json');

const TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/;
const PACKAGE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SHA256_FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const PLACEHOLDER_FINGERPRINT = /^(00:){31}00$/;

const problems = [];
const fail = (msg) => problems.push(msg);

function parseJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    fail(`${label}: cannot read ${path} (${e.message})`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${label}: not valid JSON (${e.message})`);
    return null;
  }
}

function checkAasa(doc) {
  const label = 'apple-app-site-association';
  if (!doc) return;
  const apps = doc?.webcredentials?.apps;
  if (!Array.isArray(apps) || apps.length === 0) {
    fail(`${label}: webcredentials.apps must be a non-empty array`);
    return;
  }
  for (const entry of apps) {
    const dot = entry.indexOf('.');
    const teamId = entry.slice(0, dot);
    const bundleId = entry.slice(dot + 1);
    if (!TEAM_ID.test(teamId)) {
      fail(`${label}: "${entry}" — Team ID "${teamId}" must be 10 uppercase letters/digits (Apple Developer → Membership)`);
    }
    if (teamId === 'TEAMID0000') {
      fail(`${label}: "${entry}" still has the placeholder Team ID — fill in the real one before deploying`);
    }
    if (!BUNDLE_ID.test(bundleId)) {
      fail(`${label}: "${entry}" — bundle id "${bundleId}" is not a valid reverse-DNS identifier`);
    }
  }
}

function checkAssetlinks(doc) {
  const label = 'assetlinks.json';
  if (!doc) return;
  if (!Array.isArray(doc) || doc.length === 0) {
    fail(`${label}: must be a non-empty JSON array`);
    return;
  }
  doc.forEach((stmt, i) => {
    const where = `${label}[${i}]`;
    if (!Array.isArray(stmt.relation) || !stmt.relation.includes('delegate_permission/common.get_login_creds')) {
      fail(`${where}: relation must include "delegate_permission/common.get_login_creds" (that is the passkey permission)`);
    }
    const t = stmt.target ?? {};
    if (t.namespace !== 'android_app') fail(`${where}: target.namespace must be "android_app"`);
    if (!PACKAGE_NAME.test(t.package_name ?? '')) {
      fail(`${where}: target.package_name "${t.package_name}" is not a valid Android package name`);
    }
    const fps = t.sha256_cert_fingerprints;
    if (!Array.isArray(fps) || fps.length === 0) {
      fail(`${where}: sha256_cert_fingerprints must be a non-empty array`);
      return;
    }
    for (const fp of fps) {
      if (!SHA256_FINGERPRINT.test(fp)) {
        fail(`${where}: fingerprint "${fp}" must be 32 uppercase hex pairs separated by colons (from \`eas credentials\` or \`keytool -list -v\`)`);
      }
      if (PLACEHOLDER_FINGERPRINT.test(fp)) {
        fail(`${where}: fingerprint is still the all-zero placeholder — paste the real SHA-256 before deploying`);
      }
    }
  });
}

async function checkLive() {
  const targets = [
    {
      url: `https://${DOMAIN}/.well-known/apple-app-site-association`,
      wantType: 'application/json',
      check: checkAasa,
    },
    {
      url: `https://${DOMAIN}/.well-known/assetlinks.json`,
      wantType: 'application/json',
      check: checkAssetlinks,
    },
  ];
  for (const t of targets) {
    let res;
    try {
      res = await fetch(t.url, { redirect: 'manual' });
    } catch (e) {
      fail(`live ${t.url}: fetch failed (${e.message})`);
      continue;
    }
    if (res.status !== 200) {
      fail(`live ${t.url}: HTTP ${res.status} — must be exactly 200 with no redirect (Apple and Google both refuse redirects here)`);
      continue;
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith(t.wantType)) {
      fail(`live ${t.url}: Content-Type is "${ct}", expected ${t.wantType} (see headers() in next.config.mjs)`);
    }
    let body;
    try {
      body = JSON.parse(await res.text());
    } catch (e) {
      fail(`live ${t.url}: body is not JSON (${e.message})`);
      continue;
    }
    t.check(body);
    console.log(`ok   ${t.url} (200, ${ct})`);
  }
}

checkAasa(parseJson(AASA_PATH, 'apple-app-site-association'));
checkAssetlinks(parseJson(ASSETLINKS_PATH, 'assetlinks.json'));
if (process.argv.includes('--live')) await checkLive();

// --live validates the deployed copies with the same rules, so an unfilled
// placeholder shows up once locally and once live; report each problem once.
const unique = [...new Set(problems)];
if (unique.length) {
  console.error(`\n${unique.length} problem(s):`);
  for (const p of unique) console.error(`  - ${p}`);
  console.error(
    '\nUntil these pass, the mobile app cannot use normalfinance.io passkeys: iOS/Android will report "no passkey available" with no pointer to this file.'
  );
  process.exit(1);
}
console.log('passkey association files look correct.');
