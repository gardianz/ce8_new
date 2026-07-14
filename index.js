/**
 * ╔══════════════════════════════════════════════════════╗
 * ║       🤖 CANTOR8 MULTI-ACCOUNT WALLET BOT V2        ║
 * ║    Auto CC ↔ USDCX Round-Trip Swap (Parallel)       ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Usage: node index.js
 * Config: config.json (accounts[], swap settings, API URLs)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import http from 'http';
import https from 'https';
import readline from 'readline';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import axios from 'axios';
import chalk from 'chalk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

// ── Setup ────────────────────────────────────────────────────────────────
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ── Load user-facing config (terminologi ramah user) ───────────────────
const userCfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

// Load accounts from accounts.json (one mnemonic per line) + proxy.txt (one proxy per line)
const accountLines = readFileSync(new URL('./accounts.json', import.meta.url), 'utf-8')
    .split('\n').map(l => l.trim()).filter(l => l.length > 0);
let proxyLines = [];
try {
    proxyLines = readFileSync(new URL('./proxy.txt', import.meta.url), 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l.length > 0);
} catch { /* proxy.txt optional */ }

// ── Proxy Pool (shared rotation across accounts) ─────────────────────────
class ProxyPool {
    constructor(proxies) {
        this.proxies = proxies;
        this.failedUntil = new Map(); // proxy -> timestamp when it can be retried
        this.FAIL_COOLDOWN = 60_000; // 60s cooldown for a failed proxy
    }
    get size() { return this.proxies.length; }
    /** Get a proxy for account index, cycling through the pool */
    getFor(accountIndex) {
        if (!this.proxies.length) return '';
        return this.proxies[accountIndex % this.proxies.length];
    }
    /** Mark a proxy as bad, returns next available proxy */
    rotateFrom(currentProxy, accountIndex) {
        if (!this.proxies.length) return '';
        const now = Date.now();
        // Mark current as failed
        if (currentProxy) this.failedUntil.set(currentProxy, now + this.FAIL_COOLDOWN);
        // Find next available proxy that isn't currently failed
        const startIdx = this.proxies.indexOf(currentProxy);
        for (let offset = 1; offset <= this.proxies.length; offset++) {
            const candidate = this.proxies[(startIdx + offset) % this.proxies.length];
            const failUntil = this.failedUntil.get(candidate) || 0;
            if (now >= failUntil) return candidate;
        }
        // All failed — return the one with shortest cooldown remaining
        let best = this.proxies[0], bestTime = Infinity;
        for (const p of this.proxies) {
            const t = this.failedUntil.get(p) || 0;
            if (t < bestTime) { bestTime = t; best = p; }
        }
        return best;
    }
    /** Clear failed status for a proxy (it worked) */
    markGood(proxy) { this.failedUntil.delete(proxy); }
}
const proxyPool = new ProxyPool(proxyLines);

// Resolve vps_id: env override > config value > hostname-derived. Skip the
// "default" placeholder so several VPSes don't collide on the same id.
function resolveVpsId(configured) {
    const env = (process.env.VPS_ID || '').trim();
    if (env) return env;
    if (configured && configured !== 'default') return configured;
    const host = hostname() || '';
    const slug = host.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'vps-unknown';
}

// ── Internal config: hardcoded technical settings + map dari user config ──
const config = {
    swap: {
        enabled: true,
        rounds: userCfg.jumlah_swap ?? 1000,
        delay_min_seconds: userCfg.jeda_antar_swap_detik?.minimal ?? 10,
        delay_max_seconds: userCfg.jeda_antar_swap_detik?.maksimal ?? 20,
        min_amount: userCfg.swap_minimum_cc?.fallback_jika_api_gagal ?? 27,
        cc_reserve: 0.1,
        waiting_balance_threshold: userCfg.menunggu_saldo_cc_dibawah ?? 27,
        reward_landed_threshold: userCfg.berhenti_jika_reward_cc_tercapai ?? 100,
        dynamic_minimum_swap: {
            enabled: true,
            extra_cc: userCfg.swap_minimum_cc?.tambahan_cc ?? 1.5,
            fallback_min: userCfg.swap_minimum_cc?.fallback_jika_api_gagal ?? 27,
        },
        pair_a: { chain: 'CC', asset: '0x0', label: 'CC (Amulet)' },
        pair_b: { chain: 'CC', asset: 'USDCX', label: 'USDCX' },
        pair_c: { chain: 'CC', asset: 'CETH', label: 'CETH' },
    },
    background_refresh: {
        enabled: true,
        interval_seconds: 200,
    },
    retry: {
        rate_limit_initial_delay_minutes: userCfg.rate_limit?.tunggu_pertama_menit ?? 50,
        rate_limit_delays: userCfg.rate_limit?.tunggu_lanjutan_detik ?? [15, 30, 60],
        server_rejected_delays: [1, 1, 1],
    },
    api: {
        backend_url: 'https://wallet-backend.main.digik.cantor8.tech/api',
        swap_url: 'https://api.vectornine.tech',
        exchange_url: 'https://exchange.cantor8.tech',
    },
    stagger_min_seconds: userCfg.jeda_start_antar_akun_detik?.minimal ?? 5,
    stagger_max_seconds: userCfg.jeda_start_antar_akun_detik?.maksimal ?? 60,
    derivation: {
        path_prefix: "m/501'/800245900'/0'",
        path_suffix: "0'",
        key_count: 20,
    },
    max_log_lines: userCfg.tampilan?.max_log_baris ?? 50,
    telegram: {
        enabled: userCfg.telegram?.aktif === true,
        bot_token: userCfg.telegram?.bot_token || '',
        chat_id: userCfg.telegram?.chat_id || '',
        interval_minutes: userCfg.telegram?.interval_menit ?? 60,
    },
    dashboard: {
        enabled: userCfg.dashboard?.aktif === true,
        url: userCfg.dashboard?.url || '',
        api_key: userCfg.dashboard?.api_key || '',
        vps_id: resolveVpsId(userCfg.dashboard?.vps_id),
        push_interval_seconds: userCfg.dashboard?.push_interval_detik ?? 30,
    },
};

config.accounts = accountLines.map((mnemonic, i) => ({
    name: `Acc ${i + 1}`,
    mnemonic,
    proxy: proxyPool.getFor(i),
}));

const BACKEND = config.api.backend_url;
const SWAP_API = config.api.swap_url;
const EXCHANGE = config.api.exchange_url;

const ASSET_TO_INSTRUMENT = { '0x0': 'Amulet', 'USDCX': 'USDCx', 'CETH': 'cETH' };

// Instrument id + instrument_admin party per asset — dipakai DvP swap/offer/prepare.
// Admin = Canton party id, stabil & publik (sama dgn yg dipakai Cantex pricing).
// instrument_out admin utamanya diambil dari holdings (instrumentAdminId); map ini
// jadi sumber untuk instrument_in (toAsset) yang holdings-nya bisa kosong.
const INSTRUMENT_META = {
    '0x0':   { id: 'Amulet', admin: 'DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc' },
    'USDCX': { id: 'USDCx',  admin: 'decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef' },
    'CETH':  { id: 'cETH',   admin: 'rails-cethMain-1::12200350ba6e96e3b701c3048b5aa013a8c1c08833e8ebf54339cff581055c29003a' },
};

// ── Dynamic Minimum Swap Config (SIMPLE) ─────────────────────────────────
const dynamicMinSwap = {
    enabled: config.swap?.dynamic_minimum_swap?.enabled ?? false,
    extraCc: config.swap?.dynamic_minimum_swap?.extra_cc ?? 1.5,
    fallbackMin: config.swap?.dynamic_minimum_swap?.fallback_min || config.swap.min_amount || 27,
    lastRawMin: null,  // cache untuk bulk-back check
};

// Headers untuk wallet-backend (cantor8 wallet) — domain wallet.cantor8.tech
const WALLET_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://wallet.cantor8.tech',
    'Referer': 'https://wallet.cantor8.tech/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

// Headers untuk swap API (api.vectornine.tech) — domain exchange.cantor8.tech
const SWAP_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://exchange.cantor8.tech',
    'Referer': 'https://exchange.cantor8.tech/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

// Backwards-compat alias (untuk kode lain yang masih merujuk BASE_HEADERS)
const BASE_HEADERS = WALLET_HEADERS;

const TOKEN_MAX_AGE_MS = 45 * 60 * 1000;
const SETUP_WAIT_MAX = Infinity;   // max retries waiting for account setup (422)
const SETUP_WAIT_SEC = 10;   // seconds between setup retries

// ── Crypto ───────────────────────────────────────────────────────────────

function generateKeyPairs(mnemonic) {
    const { path_prefix, path_suffix, key_count } = config.derivation;
    const seed = mnemonicToSeedSync(mnemonic, '');
    const hdkey = HDKey.fromMasterSeed(seed);
    const keyPairs = [];
    for (let i = 0; i < key_count; i++) {
        const path = `${path_prefix}/${i}'/${path_suffix}`;
        const child = hdkey.derive(path);
        const privateKey = child.privateKey;
        if (!privateKey || privateKey.length !== 32) throw new Error(`Key derivation failed at ${path}`);
        const publicKey = ed.getPublicKey(privateKey);
        keyPairs.push({
            index: i, path, privateKey, publicKey,
            publicKeyHex: Buffer.from(publicKey).toString('hex'),
        });
    }
    return keyPairs;
}

function signMessage(privateKey, message) {
    const msg = typeof message === 'string' ? new TextEncoder().encode(message) : message;
    return ed.sign(msg, privateKey);
}

function toHex(bytes) { return Buffer.from(bytes).toString('hex'); }
function toBase64(bytes) { return Buffer.from(bytes).toString('base64'); }

function generateOrderId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(20);
    let id = 'ord_';
    for (let i = 0; i < 20; i++) id += chars[bytes[i] % chars.length];
    return id;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));
const shortId = (id) => id.length > 20 ? `${id.slice(0, 12)}...${id.slice(-8)}` : id;

// ── Random Delay Helpers ─────────────────────────────────────────────────
function getRandomDelay(minSec, maxSec) {
    return Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
}

function formatDelayTime(seconds) {
    if (seconds >= 60) {
        const min = Math.floor(seconds / 60);
        const sec = seconds % 60;
        return sec > 0 ? `${min}m${sec}s` : `${min}m`;
    }
    return `${seconds}s`;
}

// ── Fetch Dynamic Minimum Swap (SIMPLE - fetch fresh setiap swap) ────────
// Flow: fetch minimum dari API → tambah 1.5 → return untuk swap
async function fetchDynamicMinSwap(swapApi, log) {
    if (!dynamicMinSwap.enabled) return config.swap.min_amount;

    const { pair_a, pair_b } = config.swap;

    try {
        // Fetch minimum dari API
        const rawMin = await swapApi.getMinimumSwap(pair_a.chain, pair_a.asset, pair_b.chain, pair_b.asset);

        if (rawMin !== null && !isNaN(rawMin) && rawMin > 0) {
            dynamicMinSwap.lastRawMin = rawMin;  // simpan untuk bulk-back check
            const swapAmount = rawMin + dynamicMinSwap.extraCc;
            log(`📊 Min: ${rawMin}CC + ${dynamicMinSwap.extraCc}CC = ${swapAmount.toFixed(2)}CC`);
            return swapAmount;
        }
    } catch (err) {
        // Silent fail, use fallback
    }

    // Fallback jika API gagal
    const fallbackAmount = dynamicMinSwap.fallbackMin + dynamicMinSwap.extraCc;
    return fallbackAmount;
}

// ── Get Raw Minimum for Bulk-back Check ──────────────────────────────────
function getRawMinimumForBulkBack() {
    if (!dynamicMinSwap.enabled) return config.swap.min_amount;
    return dynamicMinSwap.lastRawMin || dynamicMinSwap.fallbackMin;
}

// ── Fetch Minimum untuk arah pair manapun (generic) ──────────────────────
// fetchDynamicMinSwap di-hardcode CC→USDCx. Helper ini buat leg forward
// pola b/c/d yang arahnya beda (mis. USDCx→cETH). Return amount = rawMin + extraCc.
async function fetchMinFor(swapApi, fromPair, toPair, log) {
    if (!dynamicMinSwap.enabled) return config.swap.min_amount;
    try {
        const rawMin = await swapApi.getMinimumSwap(fromPair.chain, fromPair.asset, toPair.chain, toPair.asset);
        if (rawMin !== null && !isNaN(rawMin) && rawMin > 0) {
            dynamicMinSwap.lastRawMin = rawMin;
            const amount = rawMin + dynamicMinSwap.extraCc;
            if (log) log(`📊 Min ${fromPair.label}→${toPair.label}: ${rawMin} + ${dynamicMinSwap.extraCc} = ${amount.toFixed(2)}`);
            return amount;
        }
    } catch { /* silent → fallback */ }
    return dynamicMinSwap.fallbackMin + dynamicMinSwap.extraCc;
}

// ── Migrasi saldo nyangkut di pair luar-rute → base asset ────────────────
// Dipanggil sekali di awal sebelum loop. Kalau saldo `strayPair` punya nilai
// CC-equivalent ≥ minimum swap, swap semua ke `basePair` dulu supaya modal
// tidak mati di pair yang tidak dipakai pola terpilih. Di bawah ambang = dust, skip.
async function migrateStray(ctx, { doLeg, swapApi, strayPair, basePair, getStrayBalance, refreshBalances, log }) {
    if (!strayPair || !basePair) return false;
    const strayBal = getStrayBalance();
    if (!(strayBal > 0)) return false;

    const minBase = getRawMinimumForBulkBack(); // ambang dynamic minimum API
    try {
        // Kalau stray == base, tidak perlu quote (nilai 1:1)
        let equivalent = strayBal;
        if (strayPair.asset !== basePair.asset) {
            const quote = await swapApi.getQuote(
                strayPair.chain, strayPair.asset,
                basePair.chain, basePair.asset,
                strayBal
            );
            equivalent = quote && quote.receiveAmount ? parseFloat(quote.receiveAmount) : 0;
        }
        if (!(equivalent >= minBase)) {
            log(`↩ Saldo ${strayPair.label} (${strayBal}) < min ${minBase.toFixed(1)} ${basePair.label} eq → skip migrasi`);
            return false;
        }
        log(`🔀 Migrasi ${strayPair.label}(${strayBal}) → ${basePair.label} (≈${equivalent.toFixed(2)})`);
        // Set status biar dashboard nunjukin lagi back ke base, bukan label lama (mis. 'sw-auth')
        if (typeof ctx.index === 'number') dashboard.update(ctx.index, { status: `${strayPair.label}→${basePair.label}` });
        const r = await doLeg(strayPair, basePair, strayBal, `Migrate ${strayPair.label}→${basePair.label}`, { pollTimeoutMinutes: 10 });
        if (r) {
            await refreshBalances();
            return true;
        }
        log(`⚠️ Migrasi ${strayPair.label}→${basePair.label} gagal`);
    } catch (err) {
        log(`⚠️ Migrasi error: ${formatError(err)}`);
    }
    return false;
}

// ── Check USDCX Shortage for Bulk-back ───────────────────────────────────
// Cek apakah USDCX cukup untuk dapat CC senilai minimum swap CC (tanpa +1.5)
async function checkBulkBackShortage(swapApi, usdcxBalance, log) {
    if (!dynamicMinSwap.enabled) return null;

    const { pair_a, pair_b } = config.swap;
    const minCC = getRawMinimumForBulkBack(); // pakai raw minimum (tanpa extra)

    try {
        // Get quote untuk USDCX → CC direction
        // Ini memberikan tahu berapa CC yang akan didapat dari usdcxBalance
        const quote = await swapApi.getQuote(
            pair_b.chain, pair_b.asset, // from: USDCX
            pair_a.chain, pair_a.asset, // to: CC
            usdcxBalance
        );

        if (quote && quote.receiveAmount) {
            const expectedCC = parseFloat(quote.receiveAmount);

            // Jika CC yang akan didapat < minimum CC, maka shortage
            if (expectedCC < minCC) {
                const shortageCC = minCC - expectedCC;
                return {
                    current: usdcxBalance,
                    expectedCC: expectedCC,
                    minCC: minCC,
                    shortageCC: shortageCC
                };
            }
        }
    } catch (err) {
        // Jika quote gagal, skip check
    }

    return null;
}

// ── Try Bulk CETH → CC (rescue ketika CC & USDCX kurang) ────────────────
// Cek saldo CETH; jika ada, langsung swap semua ke CC.
// Return true kalau swap CETH→CC berhasil (atau setidaknya dieksekusi), false kalau tidak ada CETH.
async function tryBulkCeth(ctx, holdingsCacheRef = {}) {
    const { session, walletApi, swapApi, log, index } = ctx;
    const pair_c = config.swap.pair_c;
    const pair_a = config.swap.pair_a;
    if (!pair_c) return false;

    try {
        const { holdings: h } = await session.withRetry(
            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
        );
        const cethBal = getBalanceFor(h, pair_c.asset);
        if (cethBal <= 0) return false;

        log(`💱 ${pair_c.label} ada (${cethBal}), bulk-back ${pair_c.label}→CC`);
        if (typeof index === 'number') dashboard.update(index, { status: `bulk ${pair_c.label}` });

        const adminId = getInstrumentAdminId(h, pair_c.asset);
        const result = await executeSwap(ctx, {
            fromChain: pair_c.chain, fromAsset: pair_c.asset,
            toChain: pair_a.chain, toAsset: pair_a.asset,
            amount: cethBal, fromLabel: pair_c.label, toLabel: pair_a.label,
            instrumentAdminId: adminId,
        }, { pollTimeoutMinutes: 10 });

        if (result && !result.error) {
            log(`✅ Bulk ${pair_c.label}: +${result.receiveAmount || '?'} CC`);
            if (typeof index === 'number') {
                dashboard.update(index, {
                    swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1,
                    swapsCETHtoCC: (dashboard.accounts[index].swapsCETHtoCC || 0) + 1,
                    lastSwapDir: `${pair_c.label}↩`,
                });
            }
            // Update cache holdings
            try {
                const { holdings: h2 } = await session.withRetry(
                    () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                );
                if (h2 && holdingsCacheRef) Object.assign(holdingsCacheRef, h2);
            } catch { /* ignore */ }
            return true;
        }
        log(`⚠️ Bulk ${pair_c.label}→CC gagal`);
        return false;
    } catch (err) {
        log(`⚠️ Bulk ${pair_c.label} error: ${formatError(err)}`);
        return false;
    }
}

// ── Retry on Network Error ──────────────────────────────────────────────

const RETRYABLE_CODES = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
    'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
    'ERR_SOCKET_CONNECTION_TIMEOUT', 'ECONNABORTED',
    'ERR_NETWORK', 'EHOSTDOWN', 'ESOCKETTIMEDOUT', 'EADDRINFO',
];

function isRetryableError(err) {
    // 500+ and 429 are NOT retryable here — they have dedicated handlers
    // ERR_BAD_RESPONSE should trigger soft restart, not retry
    if (err.code === 'ERR_BAD_RESPONSE') return false;
    if (RETRYABLE_CODES.includes(err.code)) return true;
    if (err.response?.status === 400) {
        const detail = String(err.response?.data?.detail || err.response?.data?.message || JSON.stringify(err.response?.data || ''));
        if (detail.toLowerCase().includes('challenge')) return true;
    }
    if (err.message?.includes('socket hang up')) return true;
    if (err.message?.includes('ECONNRESET')) return true;
    if (err.message?.includes('network')) return true;
    if (err.message?.includes('timeout')) return true;
    if (err.message?.includes('tunneling socket')) return true;
    if (err.message?.includes('connect ETIMEDOUT')) return true;
    if (err.message?.includes('Proxy')) return true;
    return false;
}

// Escalating retry for rate limit (429) and server rejected (422)
function getEscalatingDelay(attempt, delays) {
    if (attempt < delays.length) return delays[attempt];
    return delays[delays.length - 1]; // max delay forever
}

async function retryOnNetwork(fn, { maxRetries = Infinity, baseDelay = 3, label = '', log = null, onRateLimitRetry = null, onRateLimitWait = null, throwOn429 = false } = {}) {
    let rateLimitAttempt = 0;
    const rateLimitInitialDelayMin = config.retry?.rate_limit_initial_delay_minutes ?? 61;
    const rateLimitDelays = config.retry?.rate_limit_delays || [15, 30, 60];
    let consecutiveTimeouts = 0;
    const MAX_CONSECUTIVE_TIMEOUTS = 3;
    let consecutiveProxyErrors = 0;
    const MAX_CONSECUTIVE_PROXY_ERRORS = 2;

    for (let attempt = 0; ; attempt++) {
        try {
            const result = await fn();
            consecutiveTimeouts = 0;
            consecutiveProxyErrors = 0;
            return result;
        } catch (err) {
            // 500+ → throw immediately (soft restart by runAccount)
            if (err.response?.status >= 500) throw err;

            // 429 rate limit → first time: 61 minutes, then escalating delays
            if (err.response?.status === 429) {
                // Read-only fetch (mis. getBalance load awal) → jangan blokir 5 menit;
                // lempar biar caller skip & coba lagi nanti tanpa bikin akun stuck.
                if (throwOn429) throw err;
                let delay;
                if (rateLimitAttempt === 0) {
                    // First 429: delay 61 minutes
                    delay = rateLimitInitialDelayMin * 60; // convert to seconds
                    if (log) log(`⏳ Rate limited — waiting ${rateLimitInitialDelayMin} minutes (first hit)`);
                } else {
                    // Subsequent 429s: use escalating delays
                    delay = getEscalatingDelay(rateLimitAttempt - 1, rateLimitDelays);
                    if (log) log(`⏳ Rate limited — ${delay}s (#${rateLimitAttempt})`);
                }
                rateLimitAttempt++;
                // Surface wait di status sebelum tidur, biar tak keliatan stuck (mis. 'swap-auth' → 'auth')
                if (typeof onRateLimitWait === 'function') onRateLimitWait(delay, rateLimitAttempt);
                await sleep(delay);
                if (typeof onRateLimitRetry === 'function') {
                    await onRateLimitRetry({ attempt: rateLimitAttempt, delay, err });
                }
                continue;
            }

            // 422 → throw immediately (handled specifically by executeSwap with fresh quotes)
            if (err.response?.status === 422) throw err;

            // 403 → retry max 3x (could be poll/API error, NOT always proxy)
            if (err.response?.status === 403) {
                if (attempt >= 3) throw err;
                const d = Math.min(3 * (attempt + 1), 10);
                if (log) log(`⚠️ [403] retry ${d}s (#${attempt + 1}/3)`);
                await sleep(d);
                continue;
            }

            if (!isRetryableError(err)) throw err;

            // Honor finite maxRetries: caller (withRetry=5, recover=5, refreshToken=8)
            // expects bounded retry. Tanpa ini loop infinite → akun beku di status 'auth'.
            // Default Infinity (swap loop) tetap retry tanpa batas seperti semula.
            if (Number.isFinite(maxRetries) && attempt >= maxRetries) {
                if (log) log(`❌ ${label || 'retry'} ${attempt + 1}x fail (${formatError(err)}) — give up`);
                throw err;
            }

            // Detect proxy-specific errors → throw early for proxy rotation
            const isProxySpecific = err.message?.includes('Proxy connection ended')
                || err.message?.includes('Proxy')
                || err.message?.includes('tunneling socket');
            if (isProxySpecific) {
                consecutiveProxyErrors++;
                if (log) log(`⚠️ Proxy error (#${consecutiveProxyErrors}/${MAX_CONSECUTIVE_PROXY_ERRORS}): ${formatError(err)}`);
                if (consecutiveProxyErrors >= MAX_CONSECUTIVE_PROXY_ERRORS) {
                    if (log) log(`❌ Proxy ${MAX_CONSECUTIVE_PROXY_ERRORS}x fail — need rotation`);
                    throw err; // bubble up to runAccount for proxy rotation
                }
                await sleep(3);
                continue;
            } else {
                consecutiveProxyErrors = 0;
            }

            // Track consecutive connection failures → soft restart after MAX
            const isFatalConn = err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED'
                || err.code === 'ERR_SOCKET_CONNECTION_TIMEOUT'
                || (err.message && err.message.includes('timeout'))
                || (err.message && err.message.includes('stream'));
            if (isFatalConn) {
                consecutiveTimeouts++;
                if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
                    if (log) log(`❌ ${MAX_CONSECUTIVE_TIMEOUTS}x conn fail — soft restart`);
                    throw err; // trigger soft restart via runAccount
                }
            } else {
                consecutiveTimeouts = 0;
            }

            const rawDelay = Math.min(baseDelay * Math.pow(2, attempt), 30);
            const jitter = rawDelay * (0.7 + Math.random() * 0.6); // ±30% jitter
            const delay = Math.round(jitter * 10) / 10;
            if (log) log(`🔄 ${formatError(err)} — ${delay}s (#${attempt + 1})`);
            await sleep(delay);
        }
    }
}

function formatUptime(startMs) {
    const sec = Math.floor((Date.now() - startMs) / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
    return `${m}m${String(s).padStart(2, '0')}s`;
}

function formatError(err) {
    if (err.response) {
        const code = err.response.status;
        const msg = err.response.data?.detail || err.response.data?.message || '';
        if (code >= 500) return `[${code}] Server error`;
        if (code === 401) return `[401] Auth expired`;
        if (code === 400) return `[400] ${msg || 'Bad request'}`;
        if (code === 409) return `[409] Active order exists`;
        if (code === 422) return `[422] ${msg || 'Rejected'}`;
        if (code === 429) return `[429] Rate limited`;
        return `[${code}] ${msg || 'Error'}`;
    }
    if (err.code) return `[${err.code}]`;
    return err.message?.slice(0, 50) || 'Unknown error';
}

function ts() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/:/g, '.');
}

// ── Axios Factory (per-account proxy) ────────────────────────────────────

// Keep-alive agents for direct connections (no proxy)
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

function createAxiosInstance(proxyUrl) {
    const opts = {
        timeout: 90000,           // 90s per-request hard limit
        maxRedirects: 5,
        decompress: true,
    };

    if (proxyUrl) {
        // Proxy agent options: keep-alive to avoid opening a new tunnel each request
        const agentOpts = {
            keepAlive: true,
            maxSockets: 10,
            timeout: 90000,
        };
        const httpsAgent = new HttpsProxyAgent(proxyUrl, agentOpts);
        const httpAgent = new HttpProxyAgent(proxyUrl, agentOpts);
        opts.httpAgent = httpAgent;
        opts.httpsAgent = httpsAgent;
        opts.proxy = false; // disable axios native proxy – use agent instead
    } else {
        // No proxy: still use keep-alive so sockets are reused
        opts.httpAgent = keepAliveHttpAgent;
        opts.httpsAgent = keepAliveHttpsAgent;
    }

    return axios.create(opts);
}

// ── API Factories ────────────────────────────────────────────────────────

function createWalletApi(ax) {
    const h = BASE_HEADERS;
    const auth = (token) => ({ ...h, Authorization: `Bearer ${token}` });
    return {
        recoverAccount: (keys) =>
            ax.post(`${BACKEND}/accounts/recovery_v3`, { public_keys: keys }, { headers: h }).then(r => r.data),
        getChallenge: (pid) =>
            ax.post(`${BACKEND}/auth/challenge`, { party_id: pid }, { headers: h }).then(r => r.data),
        login: (pid, ch, sig) =>
            ax.post(`${BACKEND}/auth/login`, { party_id: pid, challenge: ch, signature: sig }, { headers: h }).then(r => r.data),
        getBalance: (token) =>
            ax.get(`${BACKEND}/balance`, { headers: auth(token) }).then(r => r.data),
        // Raw holdings (per kontrak) — dipakai buat baca lock.expires_at (waktu unlock).
        getHoldings: (token) =>
            ax.get(`${BACKEND}/holdings`, { headers: auth(token) }).then(r => r.data),
        getHistory: (token) =>
            ax.get(`${BACKEND}/transfer/history`, { headers: auth(token) }).then(r => r.data),
        getMyTag: (token) =>
            ax.get(`${BACKEND}/tags/my`, { headers: auth(token) }).then(r => r.data),
        prepareTransfer: (token, body) =>
            ax.post(`${BACKEND}/transfer/prepare`, {
                instrument_admin_id: body.instrumentAdminId,
                instrument_id: body.instrumentId,
                receiver_party_id: body.receiverPartyId,
                amount: body.amount,
                reason: body.reason || '',
                app_name: body.appName || 'swap-v1',
                metadata: body.metadata || {}
            }, { headers: auth(token) }).then(r => r.data),
        // DvP swap settlement (ganti /transfer/prepare yg sekarang di-418 utk swap).
        // body = objek `swap` lengkap (swap_id, acceptor_party_id, instrument_out/in,
        // amount_out/in, settle_before). Response sama: {command_id, prepared_tx_b64,
        // hash_b64, hashing_scheme_version} → tinggal sign hash_b64 + execute.
        prepareSwapOffer: (token, swap) =>
            ax.post(`${BACKEND}/swap/offer/prepare`, { swap }, { headers: auth(token) }).then(r => r.data),
        executeTransaction: (token, body) =>
            ax.post(`${BACKEND}/transaction/execute`, {
                command_id: body.commandId,
                prepared_tx_b64: body.preparedTxB64,
                hashing_scheme_version: body.hashingSchemeVersion,
                signature_b64: body.signatureB64,
            }, { headers: auth(token) }).then(r => r.data),
        getCommandStatus: (token, commandId) =>
            ax.get(`${BACKEND}/command/${commandId}/status`, { headers: auth(token) }).then(r => r.data),
        getOffers: (token) =>
            ax.get(`${BACKEND}/offers`, { headers: auth(token) }).then(r => r.data),
        // V2 endpoint — dipakai web modern. Offer modern biasanya hanya
        // muncul di V2 (V1 sering kosong).
        getOffersV2: (token) =>
            ax.get(`${BACKEND}/offers_v2`, { headers: auth(token) }).then(r => r.data),
        acceptOfferPrepare: (token, body) =>
            ax.post(`${BACKEND}/offer/accept/prepare`, {
                contract_id: body.contractId, party_id: body.partyId
            }, { headers: auth(token) }).then(r => r.data),
        getTransferStatus: (token, commandId) =>
            ax.get(`${BACKEND}/transfer/status`, { params: { command_id: commandId }, headers: auth(token) }).then(r => r.data),
        getRegisterStatus: (token) =>
            ax.get(`${BACKEND}/register/status_v2`, { headers: auth(token) }).then(r => r.data),
        getOutgoingExpired: (token) =>
            ax.get(`${BACKEND}/offers/outgoing_expired`, { headers: auth(token) }).then(r => r.data),
    };
}

function createSwapApi(ax) {
    // Swap API requires Origin: https://exchange.cantor8.tech (not wallet.cantor8.tech)
    const h = SWAP_HEADERS;
    const auth = (token) => ({ ...h, Authorization: `Bearer ${token}` });
    return {
        getNonce: () =>
            ax.get(`${SWAP_API}/auth/nonce`, { headers: h }).then(r => r.data),
        bindSignature: (nonce, cantonAddress) =>
            ax.post(`${SWAP_API}/auth/signature`, { nonce, cantonAddress, signature: null }, { headers: h }).then(r => r.data),
        getQuote: (fromChain, fromAsset, toChain, toAsset, sendAmount) =>
            ax.post(`${SWAP_API}/quotes`, {
                fromChain, fromAsset, toChain, toAsset, sendAmount: String(sendAmount)
            }, { headers: h }).then(r => r.data),
        // Fetch minimum swap amount from quote API by testing with a small amount
        getMinimumSwap: async (fromChain, fromAsset, toChain, toAsset) => {
            try {
                // Try to get a quote with a very small amount to trigger minimum error
                // or parse the minimum from the quote response
                const testAmount = 0.1;
                const quote = await ax.post(`${SWAP_API}/quotes`, {
                    fromChain, fromAsset, toChain, toAsset, sendAmount: String(testAmount)
                }, { headers: h }).then(r => r.data);

                // Check if quote has minimum info
                if (quote.minimumSendAmount) {
                    return parseFloat(quote.minimumSendAmount);
                }
                if (quote.minSendAmount) {
                    return parseFloat(quote.minSendAmount);
                }
                if (quote.minimum) {
                    return parseFloat(quote.minimum);
                }

                // If quote succeeded with small amount, try incrementally to find minimum
                // by checking error messages
                return null;
            } catch (err) {
                // Parse minimum from error message
                const detail = err.response?.data?.detail || err.response?.data?.message || '';
                const detailStr = typeof detail === 'object' ? JSON.stringify(detail) : String(detail);

                // Common patterns: "Minimum swap amount is 25 CC", "minimum: 25", "min_amount: 25"
                const patterns = [
                    /minimum.*?(\d+\.?\d*)/i,
                    /min[_\s]?amount.*?(\d+\.?\d*)/i,
                    /at least (\d+\.?\d*)/i,
                    /below (\d+\.?\d*)/i,
                    /minSendAmount.*?(\d+\.?\d*)/i,
                ];

                for (const pattern of patterns) {
                    const match = detailStr.match(pattern);
                    if (match && match[1]) {
                        return parseFloat(match[1]);
                    }
                }

                return null;
            }
        },
        createOrder: (swapToken, orderId, quoteId, toAddress, slippageBps = 200) =>
            ax.post(`${SWAP_API}/orders`, { orderId, quoteId, toAddress, slippageBps, isDvp: true }, { headers: auth(swapToken) }).then(r => r.data),
        getOrderStatus: (swapToken, orderId) =>
            ax.get(`${SWAP_API}/orders/${encodeURIComponent(orderId)}`, { headers: auth(swapToken) }).then(r => r.data),
        getActiveOrder: (swapToken, filters = {}) =>
            ax.get(`${SWAP_API}/orders/active`, { params: filters, headers: auth(swapToken) }).then(r => r.data),
        cancelOrder: (swapToken, orderId) =>
            ax.post(`${SWAP_API}/orders/${encodeURIComponent(orderId)}/cancel`, {}, { headers: auth(swapToken) }).then(r => r.data),
        checkExchange: async () => {
            // Retry up to 3 times before declaring offline
            for (let i = 0; i < 3; i++) {
                try {
                    await ax.head(EXCHANGE, { headers: h, timeout: 10000 });
                    return true;
                } catch (err) {
                    // 5xx = server down, actually offline
                    if (err.response?.status >= 500) return false;
                    // 4xx (403, etc) = server responded, so it's online
                    if (err.response?.status >= 400) return true;
                    // Network errors = retry
                    if (i < 2) await new Promise(r => setTimeout(r, 2000));
                }
            }
            return true; // Assume online if just network issues
        },
        getLeaderboard: (address = null) =>
            ax.get(`${SWAP_API}/leaderboard`, {
                params: { limit: 50, includeRewards: true, includeAll: true, ...(address ? { address } : {}) },
                headers: h,
            }).then(r => r.data),
        checkEligibility: (partyId) =>
            ax.get(`${SWAP_API}/party/check-eligibility`, { params: { partyId }, headers: h }).then(r => r.data),
    };
}

// ── UI helpers (port from ref.js) ────────────────────────────────────────

const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const SEP = Symbol('separator');

function stripAnsi(str) {
    return String(str).replace(ansiRegex, '');
}

function charDisplayWidth(char) {
    const cp = char.codePointAt(0);
    if (cp === undefined) return 0;
    if ((cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f) || /\p{Mark}/u.test(char)) return 0;
    if (
        cp >= 0x1100 && (
            cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
            (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
            (cp >= 0xac00 && cp <= 0xd7a3) ||
            (cp >= 0xf900 && cp <= 0xfaff) ||
            (cp >= 0xfe10 && cp <= 0xfe19) ||
            (cp >= 0xfe30 && cp <= 0xfe6f) ||
            (cp >= 0xff00 && cp <= 0xff60) ||
            (cp >= 0xffe0 && cp <= 0xffe6) ||
            (cp >= 0x1f300 && cp <= 0x1faff) ||
            (cp >= 0x20000 && cp <= 0x3fffd)
        )
    ) return 2;
    return 1;
}

function visibleLength(str) {
    const plain = Array.from(stripAnsi(str));
    let width = 0;
    for (const char of plain) width += charDisplayWidth(char);
    return width;
}

function fitToWidth(content, width) {
    const text = String(content ?? '').replace(/\r?\n/g, ' ');
    const length = visibleLength(text);
    if (length <= width) return text + ' '.repeat(width - length);
    // Truncate sambil preserve ANSI escape sequences (biar chalk colors nggak
    // ke-strip pas overflow). Append reset di akhir supaya warna nggak bleed.
    const useEllipsis = width > 3;
    const maxTextWidth = useEllipsis ? width - 3 : width;
    const localAnsi = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    let out = '', visible = 0, i = 0;
    while (i < text.length) {
        localAnsi.lastIndex = i;
        const m = localAnsi.exec(text);
        if (m && m.index === i) {
            out += m[0];
            i = localAnsi.lastIndex;
            continue;
        }
        const ch = String.fromCodePoint(text.codePointAt(i));
        const w = charDisplayWidth(ch);
        if (visible + w > maxTextWidth) break;
        out += ch;
        visible += w;
        i += ch.length;
    }
    return out + (useEllipsis ? '...' : '') + '\x1b[0m';
}

function centerToWidth(content, width) {
    const text = String(content ?? '');
    const length = visibleLength(text);
    if (length >= width) return fitToWidth(text, width);
    const left = Math.floor((width - length) / 2);
    const right = width - length - left;
    return `${' '.repeat(left)}${text}${' '.repeat(right)}`;
}

function padCell(str, w) {
    const text = String(str ?? '');
    const len = visibleLength(text);
    if (len >= w) return fitToWidth(text, w);
    return text + ' '.repeat(w - len);
}

function getTermWidth() {
    const cols = process.stdout.columns || 120;
    const usable = Math.min(cols, 160);
    // Stacked layout (akun atas, log bawah) → pakai lebar penuh
    const left = usable - 2;
    return { left, right: 0, mobile: cols < 60 };
}

// Strip semua emoji/pictograph dari activity log (poin #1)
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F2FF}\u{FE0F}\u{200D}]/gu;
function stripEmoji(str) {
    return String(str).replace(EMOJI_REGEX, '').replace(/\s{2,}/g, ' ').trim();
}

// Status color helper (port from back.js)
function statusColor(status) {
    if (!status) return chalk.white;
    const s = String(status);
    if (s === 'done') return chalk.green;
    if (s === 'init') return chalk.gray;
    if (s === 'skip' || s === 'idle') return chalk.gray;
    if (s.startsWith('err') || s === 'error' || s === 'offline' || s === 'bal') return chalk.red;
    if (s === 'lock') return chalk.hex('#FBBF24'); // saldo cukup tapi nyangkut di lock → amber
    if (s === 'reward-landed') return chalk.green;
    if (s.includes('→') || s.includes('↩')) return chalk.cyan;
    if (s.startsWith('wait') || s.includes('ineligible') || s.startsWith('restart')) return chalk.yellow;
    if (s.startsWith('auth') || s === 'sw-auth' || s === 'login' || s === 'recovering' || s === 'deriving' || s.startsWith('swap-')) return chalk.magenta;
    if (s === 'checking' || s === 'scan') return chalk.blue;
    if (s === 'soft-restart') return chalk.yellow;
    return chalk.white;
}

// Ubah status verbose ke singkat: hanya pair direction, tanpa round/swap counter
function shortStatus(s) {
    if (!s) return 'init';
    let r = String(s);
    // Normalize asset names
    r = r.replace(/CETH/gi, 'E');
    r = r.replace(/USDCx?/gi, 'U');
    r = r.replace(/\bCC\b/g, 'C');
    // Hapus "swap", "Smart", "bulk" prefix
    r = r.replace(/^(?:swap|Smart|bulk)[\s_-]*/i, '');
    // Hapus round counter: R3, R1/1000, #5, dll
    r = r.replace(/\s*R\d+(?:\/\d+)?/g, '');
    r = r.replace(/\s*#\d+/g, '');
    // Hapus label "Final", "Cleanup"
    r = r.replace(/^(?:Final|Cleanup)\s*/i, '');
    // Trim whitespace
    r = r.trim();
    // Potong max 6 char untuk mobile
    if (r.length > 6) r = r.slice(0, 6);
    return r || 'init';
}

function wrapLine(text, maxW) {
    const plain = stripAnsi(text);
    const rows = [];
    let row = '', rowW = 0;
    const plainChars = Array.from(plain);
    for (const ch of plainChars) {
        const cw = charDisplayWidth(ch);
        if (rowW + cw > maxW && row.length > 0) {
            rows.push(row);
            row = '  '; rowW = 2;
        }
        row += ch; rowW += cw;
    }
    if (row.length > 0) rows.push(row);
    return rows.length > 0 ? rows : [''];
}

// ── Per-Account Dashboard + Log ──────────────────────────────────────────

const MAX_ACC_LOGS = 5;
// Adaptive: compute available log rows from terminal height
function getAdaptiveLogRows(accountCount, useTwoCol) {
    const rows = process.stdout.rows || 24;
    // Fixed chrome lines: top border(1) + title(1) + sep(1) + status(1) + sep(1)
    //   + header(1) + sep(1) + totals(1) + sep(1) + "Activity Log" title(1) + sep(1) + bottom border(1) = 12
    const chrome = 12;
    const tableRows = useTwoCol ? Math.ceil(accountCount / 2) : accountCount;
    const available = rows - chrome - tableRows;
    const cfgMax = Number(config.max_log_lines) || 50;
    return Math.max(3, Math.min(cfgMax, available));
}
const MAX_GLOBAL_LOGS = 200; // buffer size, actual display is adaptive

const dashboard = {
    accounts: [],
    globalLogs: [],
    _timer: null,
    _renderPending: false,
    _lastFrame: '',

    init(accountConfigs) {
        this.accounts = accountConfigs.map((acc, i) => ({
            name: acc.name || `Acc ${i + 1}`,
            num: i + 1,
            startTime: Date.now(),
            cc: 0, usdcx: 0, ceth: 0,
            lockedCc: 0, lockedUsdcx: 0, lockedCeth: 0,
            unlockCc: null, unlockUsdcx: null, unlockCeth: null,
            swapsCCtoU: 0, swapsUtCC: 0,
            swapsUtoCETH: 0, swapsCETHtoCC: 0,
            maxCCtoU: config.swap.rounds || 0, maxUtCC: 0,
            totalSwaps: 0, lastSwapDir: '', lastSwapAt: null, longestSwapGap: 0,
            monthReward: 0, monthVolume: 0, monthTxns: 0,
            totalReward: 0, pendingReward: 0, rank: 0,
            rewardDate: '',
            initialTxns: null, initialReward: null, lastKnownReward: null,
            diffTxns: 0, diffReward: 0,
            nonce: false, swap: false, proxy: !!acc.proxy,
            proxyHost: '',
            proxyIp: '',
            status: 'init',
            logs: [],
        }));
        this.globalLogs = [];
    },

    update(index, data) {
        // Stamp swap time on any swap-related update. totalSwaps local counter can reset
        // between performSwap cycles, so don't rely on it increasing — fire whenever a
        // swap event reports (totalSwaps>0 or an explicit direction), skip the init (0/'').
        const prev = this.accounts[index];
        if (prev && (('totalSwaps' in data && data.totalSwaps > 0) || (data.lastSwapDir && data.lastSwapDir !== ''))) {
            const now = Date.now();
            // Track longest gap between consecutive swaps (idle delay record).
            if (prev.lastSwapAt) {
                const gap = now - prev.lastSwapAt;
                if (gap > (prev.longestSwapGap || 0)) data.longestSwapGap = gap;
            }
            data.lastSwapAt = now;
        }
        Object.assign(this.accounts[index], data);
        this._scheduleRender();
    },

    log(index, msg) {
        const a = this.accounts[index];
        const stripped = stripAnsi(String(msg)).trim();
        if (!stripped) { this._scheduleRender(); return; }
        if (/^[═━─-]{3,}$/.test(stripped)) { this._scheduleRender(); return; }
        if (/^Batch\s+\d+\/\d+/i.test(stripped)) { this._scheduleRender(); return; }
        const cleanMsg = String(msg).replace(/^\n+/, '');
        a.logs.push(cleanMsg);
        while (a.logs.length > MAX_ACC_LOGS) a.logs.shift();
        this.globalLogs.push(`${chalk.cyan(`[${a.name}]`)} ${cleanMsg}`);
        while (this.globalLogs.length > MAX_GLOBAL_LOGS) this.globalLogs.shift();
        this._scheduleRender();
    },

    _scheduleRender() {
        if (this._renderPending) return;
        this._renderPending = true;
        setTimeout(() => {
            this._renderPending = false;
            this._render();
        }, 200);
    },

    _render() {
        process.stdout.write('\x1B[?25l\x1B[H\x1B[2J');
        const { left: L, right: R, mobile } = getTermWidth();

        const headerTime = new Date().toLocaleTimeString('en-GB', { hour12: false });

        let totCC = 0, totUSDCx = 0, totCETH = 0, totReward = 0, totDelta = 0, totSwaps = 0;
        for (const a of this.accounts) {
            totCC += a.cc;
            totUSDCx += a.usdcx;
            totCETH += a.ceth || 0;
            totReward += a.monthReward;
            totDelta += a.diffReward || 0;
            totSwaps += a.totalSwaps || 0;
        }

        // ── Padded column layout — adaptive per width ──
        // Mode "wide" (≥80 cols): full kolom
        // Mode "mid"  (60-79):    drop Δrw, perpendek
        // Mode "mobile" (<60):    super padat, 1 panel
        // Determine two-col FIRST, then pick column widths based on per-panel width
        const useTwoCol = !mobile && this.accounts.length > 20;
        const colInnerWidth = useTwoCol ? Math.floor((L - 1) / 2) : L;
        const panelW = colInnerWidth; // width available per panel

        let COL, SPACER;
        if (mobile || panelW < 40) {
            // Ultra compact (iPhone portrait / very narrow two-col panel)
            COL = { num: 2, cc: 5, ux: 4, et: 6, sw: 2, dr: 5, st: 5 };
            SPACER = 1;
        } else if (panelW < 55) {
            // Compact (two-col on medium terminal / iPhone landscape)
            COL = { num: 2, cc: 5, ux: 5, et: 6, sw: 2, dr: 5, st: 6 };
            SPACER = 1;
        } else if (panelW < 75) {
            // Mid-width panel
            COL = { num: 3, cc: 6, ux: 6, et: 7, sw: 3, dr: 5, st: 7 };
            SPACER = 1;
        } else {
            // Wide panel (single-col on wide terminal)
            COL = { num: 4, cc: 7, ux: 8, et: 8, sw: 4, dr: 6, st: 10 };
            SPACER = 1;
        }
        const colKeys = Object.keys(COL);
        const rowWidth = colKeys.reduce((s, k) => s + COL[k], 0) + SPACER * (colKeys.length - 1);

        const fmtCell = (text, width, color = null) => {
            const t = centerToWidth(String(text), width);
            return color ? color(t) : t;
        };

        const HC = chalk.hex('#A7F3D0').bold;
        const renderHeader = (width) => {
            const col6Label = (COL.dr >= 5 ? 'Δrw' : 'Δ');
            const cells = [
                fmtCell('##', COL.num, HC),
                fmtCell('CC', COL.cc, HC),
                fmtCell(COL.ux >= 7 ? 'USDCx' : 'U', COL.ux, HC),
                fmtCell(COL.et >= 7 ? 'cETH' : 'E', COL.et, HC),
                fmtCell('sw', COL.sw, HC),
                fmtCell(col6Label, COL.dr, HC),
                fmtCell('st', COL.st, HC),
            ];
            // Center seluruh row di panel
            return centerToWidth(cells.join(' '), width);
        };

        const fmtNum = (v, width) => {
            // Auto-trim decimals untuk muat di kolom sempit
            const n = Number(v) || 0;
            if (width >= 8) return n.toFixed(4);
            if (width >= 7) return n.toFixed(3);
            if (width >= 6) return n.toFixed(2);
            return n.toFixed(1);
        };

        // ETH selalu minimal 3 desimal
        const fmtEth = (v, width) => {
            const n = Number(v) || 0;
            if (width >= 10) return n.toFixed(6);
            if (width >= 8) return n.toFixed(4);
            return n.toFixed(3); // minimum 3 desimal (0.000)
        };

        const renderAccRow = (a, width) => {
            const ccColor = a.cc >= 25 ? chalk.green : a.cc >= 10 ? chalk.yellow : chalk.red;
            const stCol = statusColor(a.status);

            // Kolom ke-6: Δrw (delta reward sejak baseline)
            let col6Text, col6Color;
            {
                const deltaVal = a.diffReward || 0;
                col6Color = deltaVal > 0 ? chalk.green : deltaVal < 0 ? chalk.red : chalk.gray;
                col6Text = deltaVal >= 0 ? `+${deltaVal.toFixed(1)}` : `${deltaVal.toFixed(1)}`;
            }

            const cells = [
                fmtCell(String(a.num), COL.num, chalk.hex('#6EE7B7')),
                fmtCell(a.cc.toFixed(COL.cc >= 7 ? 2 : 1), COL.cc, ccColor),
                fmtCell(fmtNum(a.usdcx, COL.ux), COL.ux, chalk.hex('#60A5FA')),
                fmtCell(fmtEth(a.ceth || 0, COL.et), COL.et, chalk.hex('#22D3EE')),
                fmtCell(String(a.totalSwaps || 0), COL.sw, chalk.hex('#FBBF24')),
                fmtCell(col6Text, COL.dr, col6Color),
                fmtCell(shortStatus(a.status), COL.st, stCol),
            ];
            // Center seluruh row di panel
            return centerToWidth(cells.join(' '), width);
        };

        // ── Left panel (akun) ──
        const left = [];

        // Baris status: harga CC · uptime · Modal · Reward. (Judul "CANTOR8 BOT V2"
        // + separator di atasnya dihapus — status line jadi baris teratas.)
        const upStr = formatUptime(botStartTime);
        const ccUsdNow = cachedDashPrices?.ccUsd || 0;
        const cethUsdNow = cachedDashPrices?.cethUsd || 0;
        const ccPriceStr = ccUsdNow > 0 ? `$${ccUsdNow.toFixed(4)}` : '$—';
        const modalUsd = totCC * ccUsdNow + totUSDCx + totCETH * cethUsdNow; // CC+USDCx+cETH → USD → IDR
        const modalIdrStr = fmtIdrCompact(modalUsd);
        const rewardUsd = totReward * ccUsdNow;
        const rewardIdrStr = fmtIdrCompact(rewardUsd);
        left.push(centerToWidth(
            `${chalk.hex('#FFD700')('CC')} ${mobile ? chalk.white(ccPriceStr) : chalk.white.bold(ccPriceStr)}  ` +
            `${chalk.hex('#67E8F9')('Up')} ${chalk.white(upStr)}  ` +
            `${chalk.hex('#A7F3D0')('Modal')} ${chalk.white.bold(modalIdrStr)}  ` +
            `${chalk.hex('#F472B6')('Reward')} ${chalk.white.bold(rewardIdrStr)}`,
            L
        ));

        // Baris TOT — dipindah ke atas (tepat di bawah status line), selalu center.
        {
            const TC = {
                num: 4,
                cc: Math.max(8, String(totCC.toFixed(2)).length + 2),
                ux: Math.max(8, String(totUSDCx.toFixed(4)).length + 2),
                et: Math.max(8, String(totCETH.toFixed(4)).length + 2),
                sw: Math.max(4, String(totSwaps).length + 2),
            };
            const totFmt = (text, width, color) => {
                const t = centerToWidth(String(text), width);
                return color ? color(t) : t;
            };
            const accCount = Math.max(1, this.accounts.length);
            const avgCc = totCC / accCount;
            const totCcColor = avgCc >= 25 ? chalk.green.bold : avgCc >= 10 ? chalk.yellow.bold : chalk.red.bold;
            const totCells = [
                totFmt('TOT', TC.num, chalk.bold.hex('#FBBF24')),
                totFmt(totCC.toFixed(2), TC.cc, totCcColor),
                totFmt(totUSDCx.toFixed(4), TC.ux, chalk.hex('#60A5FA').bold),
                totFmt(totCETH.toFixed(4), TC.et, chalk.hex('#22D3EE').bold),
                totFmt(String(totSwaps), TC.sw, chalk.hex('#FBBF24').bold),
            ];
            const totDeltaFmt = totDelta >= 0 ? `+${totDelta.toFixed(2)}` : `${totDelta.toFixed(2)}`;
            const totDeltaColor = totDelta > 0 ? chalk.green.bold : totDelta < 0 ? chalk.red.bold : chalk.gray.bold;
            totCells.push(totFmt(totDeltaFmt, 8, totDeltaColor));
            totCells.push(totFmt(`Rw ${totReward.toFixed(1)}`, 10, chalk.white.bold));
            const totJoined = totCells.join(' ');
            left.push(visibleLength(totJoined) < L ? centerToWidth(totJoined, L) : totJoined);
        }

        left.push(SEP);

        if (useTwoCol) {
            const hdr = renderHeader(colInnerWidth);
            left.push(padCell(hdr, colInnerWidth) + chalk.hex('#555')('│') + padCell(hdr, colInnerWidth));
            const half = Math.ceil(this.accounts.length / 2);
            for (let i = 0; i < half; i++) {
                const a1 = this.accounts[i];
                const a2 = this.accounts[i + half];
                const l1 = padCell(renderAccRow(a1, colInnerWidth), colInnerWidth);
                const l2 = a2 ? padCell(renderAccRow(a2, colInnerWidth), colInnerWidth) : ' '.repeat(colInnerWidth);
                left.push(l1 + chalk.hex('#555')('│') + l2);
            }
        } else {
            left.push(renderHeader(L));
            for (const a of this.accounts) {
                left.push(renderAccRow(a, L));
            }
        }

        // (Baris TOT dipindah ke ATAS — dirender tepat di bawah status line.)

        const c = chalk.hex('#555');
        const out = [];

        // ── Stacked layout: panel akun di atas, activity log di bawah ──
        // Lebar penuh = L (account panel sudah pakai full width karena tidak ada side panel)
        const W = L;
        out.push(c(`┌${'─'.repeat(W)}┐`));
        for (const lVal of left) {
            if (lVal === SEP) out.push(c(`├${'─'.repeat(W)}┤`));
            else out.push(c('│') + padCell(lVal, W) + c('│'));
        }

        // ── Activity Log — di-split: KIRI = log biasa, KANAN = tabel akun terkunci ──
        const adaptiveRows = getAdaptiveLogRows(this.accounts.length, useTwoCol);
        const logCap = mobile ? Math.min(adaptiveRows, 10) : adaptiveRows;
        const recentLogs = this.globalLogs.slice(-logCap);
        // Bersihkan log: buang order-id, retry counter (#3), rate (@0.16), trailing koma.
        const cleanLog = (entry) => stripEmoji(stripAnsi(entry))
            .replace(/\s*[+,]\s*(?:order\s+)?ord_[a-z0-9]+(?:\.{2,3}[a-z0-9]+)?.*$/i, '')
            .replace(/\s+ord_[a-z0-9]+(?:\.{2,3}[a-z0-9]+)?/gi, '')
            .replace(/\s+\(#\d+\).*$/, '')
            .replace(/\s+@\d[\d.]*\s*$/, '')
            .replace(/[\s,]+$/, '');
        // Saldo terkunci per (akun, asset): CC / USDCx / cETH. Satu baris tiap asset ter-lock.
        // Bawa juga waktu unlock (epoch ms dari lock.expires_at).
        const lockList = [];
        for (const a of this.accounts) {
            if ((a.lockedCc || 0) > 0) lockList.push({ num: a.num, amt: a.lockedCc, sym: 'CC', unlock: a.unlockCc });
            if ((a.lockedUsdcx || 0) > 0) lockList.push({ num: a.num, amt: a.lockedUsdcx, sym: 'USDCx', unlock: a.unlockUsdcx });
            if ((a.lockedCeth || 0) > 0) lockList.push({ num: a.num, amt: a.lockedCeth, sym: 'cETH', unlock: a.unlockCeth });
        }

        // Panel Locked lebih lebar (geser divider ke kiri) — butuh ruang utk kolom Unlock.
        const rightW = Math.max(0, Math.min(34, Math.floor(W * 0.40)));
        const canSplit = rightW >= 12 && (W - rightW - 1) >= 24;

        if (canSplit) {
            const leftW = W - rightW - 1;
            const div = c('│');
            // Header dua panel + garis pemisah vertikal (┬ … ┼ … ┴).
            out.push(c(`├${'─'.repeat(leftW)}┬${'─'.repeat(rightW)}┤`));
            out.push(c('│') + padCell(centerToWidth(chalk.bold.hex('#FBBF24')('Activity Log'), leftW), leftW)
                + div + padCell(centerToWidth(chalk.bold.hex('#F87171')('Locked'), rightW), rightW) + c('│'));
            out.push(c(`├${'─'.repeat(leftW)}┼${'─'.repeat(rightW)}┤`));

            const logRows = recentLogs.map(e => fitToWidth(` ${cleanLog(e)}`, leftW)).slice(-logCap);
            // Tabel lock: sub-header (Acct + Balance + Unlock) + baris data.
            //   kol Acct=5, Balance=13, Unlock=sisa. Unlock = DD/MM HH:MM.
            const lockRows = [fitToWidth(chalk.hex('#9CA3AF')(` ${padCell('Acct', 5)}${padCell('Balance', 13)}Unlock`), rightW)];
            if (!lockList.length) {
                lockRows.push(fitToWidth(chalk.gray('  —'), rightW));
            } else {
                for (const { num, amt, sym, unlock } of lockList) {
                    const amtStr = sym === 'cETH' ? amt.toFixed(4) : amt.toFixed(2);
                    const bal = padCell(`${chalk.hex('#FBBF24')(amtStr)} ${chalk.hex('#9CA3AF')(sym)}`, 13);
                    lockRows.push(fitToWidth(` ${padCell('#' + num, 5)}${bal}${chalk.hex('#93C5FD')(fmtUnlockTime(unlock))}`, rightW));
                }
            }
            // ADAPTIVE: cap tinggi tabel lock = logCap (sama dgn Activity Log) biar
            // ga overflow & ngerusak pinned dashboard. Sisanya → indikator "+N lagi".
            if (lockRows.length > logCap) {
                const hidden = lockRows.length - logCap + 1; // +1 utk baris indikator yg gantiin 1 data row
                lockRows.length = Math.max(1, logCap - 1);
                lockRows.push(fitToWidth(chalk.gray(`  +${hidden} lagi`), rightW));
            }

            const nRows = Math.max(logRows.length, lockRows.length);
            for (let i = 0; i < nRows; i++) {
                const lc = logRows[i] != null ? logRows[i] : ' '.repeat(leftW);
                const rc = lockRows[i] != null ? lockRows[i] : ' '.repeat(rightW);
                out.push(c('│') + padCell(lc, leftW) + div + padCell(rc, rightW) + c('│'));
            }
            out.push(c(`└${'─'.repeat(leftW)}┴${'─'.repeat(rightW)}┘`));
        } else {
            // Terlalu sempit untuk split → log full-width (fallback lama).
            out.push(c(`├${'─'.repeat(W)}┤`));
            out.push(c('│') + padCell(centerToWidth(chalk.bold.hex('#FBBF24')('Activity Log'), W), W) + c('│'));
            out.push(c(`├${'─'.repeat(W)}┤`));
            const rows = recentLogs.map(e => fitToWidth(` ${cleanLog(e)}`, W)).slice(-logCap);
            for (const row of rows) out.push(c('│') + padCell(row, W) + c('│'));
            out.push(c(`└${'─'.repeat(W)}┘`));
        }

        const frame = out.join('\n');
        // Simpan frame mentah (dengan ANSI) untuk di-mirror ke dashboard web.
        this._lastFrame = frame;
        process.stdout.write(frame + '\n');
    },

    startAutoRefresh() {
        if (this._timer) return;
        this._timer = setInterval(() => this._scheduleRender(), 10000);
    },

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        process.stdout.write('\x1B[?25h'); // restore cursor
    },
};

// ── Dashboard Web Push ───────────────────────────────────────────────────

const botStartTime = Date.now();
let dashboardPushTimer = null;
let cachedDashPrices = { ccUsd: 0, cethUsd: 0, ts: 0 };
const DASH_PRICE_CACHE_MS = 5 * 1000;        // 5 detik — realtime untuk status line
const DASH_PRICE_REFRESH_MS = 5 * 1000;      // background refresh interval

// IDR FX rate — cached 30 menit, fallback hardcoded fallback rate
let cachedIdrRate = { rate: Number(process.env.IDR_RATE) || 16500, ts: 0 };
const IDR_FX_CACHE_MS = 30 * 60 * 1000;
async function fetchIdrRate() {
    if (cachedIdrRate.ts && Date.now() - cachedIdrRate.ts < IDR_FX_CACHE_MS) return cachedIdrRate.rate;
    try {
        const r = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 10000 });
        const rate = r?.data?.rates?.IDR;
        if (rate && rate > 1000 && rate < 50000) {
            cachedIdrRate = { rate, ts: Date.now() };
        }
    } catch { /* keep last cache */ }
    return cachedIdrRate.rate;
}
// Boot fetch + periodic refresh
fetchIdrRate().catch(() => { });
setInterval(() => { fetchIdrRate().catch(() => { }); }, IDR_FX_CACHE_MS);

// Compact IDR formatter — jt for ≥1M, M for ≥1B, kasar untuk display ringkas
function fmtIdrCompact(usdValue) {
    const rate = cachedIdrRate.rate || 16500;
    if (!usdValue || !isFinite(usdValue)) return 'Rp —';
    const idr = usdValue * rate;
    if (idr >= 1e9) return `Rp ${(idr / 1e9).toFixed(2)}M`;
    if (idr >= 1e6) return `Rp ${(idr / 1e6).toFixed(2)}jt`;
    if (idr >= 1e3) return `Rp ${(idr / 1e3).toFixed(1)}rb`;
    return `Rp ${Math.round(idr).toLocaleString('id-ID')}`;
}

// ── Cantex price source (cantex.io) — public REST, no auth/key/wallet ─────
// Ref: CANTEX_PRICING.md. Semua harga token dari Canton Network diambil di sini.
// USDCx ≈ $1 (bridged USDC) → anchor USD. Tidak ada pool token→USD langsung,
// semua route lewat Amulet (CC): token → Amulet → USDCx.
//   priceUSD(CC)   = rate(Amulet → USDCx)                        (1 hop)
//   priceUSD(cETH) = rate(cETH → Amulet) × rate(Amulet → USDCx)  (2 hop)
// rate(X → Y) = quote(X → Y).prices.pool_before  (buy Y per 1 sell X, mid, no fees)
const CANTEX_QUOTE_URL = 'https://api.cantex.io/v1/public/pools/quote';
// instrument_admin party ids — stable Canton parties, public & aman dipublish.
const CANTEX_ADMIN = {
    Amulet: 'DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc',
    USDCx:  'decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef',
    cETH:   'rails-cethMain-1::12200350ba6e96e3b701c3048b5aa013a8c1c08833e8ebf54339cff581055c29003a',
};
const CANTEX_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

// buy units per 1 sell unit (mid spot, no fees) via Cantex pools/quote.
// Best-effort: retry beberapa kali, return null kalau gagal (caller keep last-good).
async function cantexRate(ax, sell, buy, tries = 3) {
    for (let i = 0; i < tries; i++) {
        try {
            const j = await ax.post(CANTEX_QUOTE_URL, {
                sellAmount: '1',
                sellInstrumentId: sell, sellInstrumentAdmin: CANTEX_ADMIN[sell],
                buyInstrumentId: buy,  buyInstrumentAdmin: CANTEX_ADMIN[buy],
            }, { headers: CANTEX_HEADERS, timeout: 10000 }).then(r => r.data);
            const p = Number(j && j.prices && j.prices.pool_before);
            if (Number.isFinite(p) && p > 0) return p;
        } catch { /* retry */ }
    }
    return null;
}

async function fetchDashboardPrices() {
    if (cachedDashPrices.ts && Date.now() - cachedDashPrices.ts < DASH_PRICE_CACHE_MS) return cachedDashPrices;
    // Use first account's axios instance (or direct) to fetch prices
    const ax = createAxiosInstance(config.accounts[0]?.proxy || '');
    let ccUsd = cachedDashPrices.ccUsd || 0;
    let cethUsd = cachedDashPrices.cethUsd || 0;

    // USD anchor: rate(Amulet → USDCx) = USD per 1 CC. Fetch sekali, reuse.
    const au = await cantexRate(ax, 'Amulet', 'USDCx');
    if (au != null) {
        ccUsd = au;
        // cETH: rate(cETH → Amulet) × au = USD per 1 cETH (2 hop)
        const ce = await cantexRate(ax, 'cETH', 'Amulet');
        if (ce != null) cethUsd = ce * au;
    }
    // au null → keep last-good ccUsd/cethUsd (jangan blank display)

    cachedDashPrices = { ccUsd, cethUsd, ts: Date.now() };
    return cachedDashPrices;
}

// Background realtime refresher — kick price fetch tiap 5s, independent dari push cycle.
// Render status line baca cachedDashPrices langsung, dapat nilai fresh tanpa nunggu push.
fetchDashboardPrices().catch(() => { });
setInterval(() => { fetchDashboardPrices().catch(() => { }); }, DASH_PRICE_REFRESH_MS);

// Status yang artinya akun masih boot/auth/scan — balance belum reliable
const _PUSH_NOT_READY_STATUS = new Set([
    'init', 'deriv', 'recover', 'auth', 'login', 'scan', 'checking', 'swap-auth',
]);

async function pushToDashboard() {
    const dashCfg = config.dashboard;
    if (!dashCfg?.enabled || !dashCfg.url || !dashCfg.api_key) return;

    // Anti-partial: skip push selama init/scan untuk hindari flicker di dashboard.
    // Push baru jalan saat ≥80% akun udah lewat fase boot (status bukan init/auth/scan).
    const totalAccs = dashboard.accounts.length;
    if (totalAccs > 0) {
        const readyAccs = dashboard.accounts.filter(a => !_PUSH_NOT_READY_STATUS.has(a.status || 'init')).length;
        const threshold = Math.ceil(totalAccs * 0.8);
        if (readyAccs < threshold) {
            if (!pushToDashboard._skipCount) pushToDashboard._skipCount = 0;
            pushToDashboard._skipCount++;
            if (pushToDashboard._skipCount === 1 || pushToDashboard._skipCount % 5 === 0) {
                dashboard.log(0, `⏳ Skip push (${readyAccs}/${totalAccs} ready, butuh ≥${threshold})`);
            }
            return;
        }
        pushToDashboard._skipCount = 0;
    }

    try {
        // Fetch prices (cached)
        const prices = await fetchDashboardPrices();

        // Collect account data from dashboard object
        const accounts = dashboard.accounts.map(a => ({
            name: a.name,
            cc: a.cc || 0,
            usdcx: a.usdcx || 0,
            ceth: a.ceth || 0,
            monthReward: a.monthReward || 0,
            monthVolume: a.monthVolume || 0,
            monthTxns: a.monthTxns || 0,
            totalReward: a.totalReward || 0,
            pendingReward: a.pendingReward || 0,
            claimedReward: 0, // Not tracked in bot dashboard
            rank: a.rank || 0,
            status: a.status || 'idle',
            totalSwaps: a.totalSwaps || 0,
            diffReward: a.diffReward || 0,
            lastSwapDir: a.lastSwapDir || '',
            lastSwapAt: a.lastSwapAt || null,
            longestSwapGap: a.longestSwapGap || 0,
            logs: (a.logs || []).slice(-5),
            error: null,
        }));

        // Recent globalLogs (last 50 lines, ANSI-stripped) untuk Activity tab di dashboard
        const recentGlobalLogs = (dashboard.globalLogs || [])
            .slice(-50)
            .map(line => stripAnsi(String(line)));

        const payload = {
            vpsId: dashCfg.vps_id,
            accounts,
            prices,
            totalAccounts: dashboard.accounts.length,
            botUptime: Math.floor((Date.now() - botStartTime) / 1000),
            globalLogs: recentGlobalLogs,
            // Full rendered terminal frame (with ANSI colors) — di-mirror 1:1 di dashboard Activity tab.
            screen: dashboard._lastFrame || '',
            timestamp: new Date().toISOString(),
        };

        const url = dashCfg.url.replace(/\/+$/, '') + '/api/push';
        await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': dashCfg.api_key,
            },
            timeout: 15000,
        });
    } catch (err) {
        // Silent fail — don't spam terminal logs
        // Only log if first failure or every 10th failure
        if (!pushToDashboard._failCount) pushToDashboard._failCount = 0;
        pushToDashboard._failCount++;
        if (pushToDashboard._failCount === 1 || pushToDashboard._failCount % 10 === 0) {
            const msg = err.response ? `[${err.response.status}]` : err.code || err.message?.slice(0, 40);
            if (dashboard.accounts.length > 0) {
                dashboard.log(0, `⚠️ Dashboard push #${pushToDashboard._failCount}: ${msg}`);
            }
        }
    }
}
pushToDashboard._failCount = 0;

function startDashboardPush() {
    const dashCfg = config.dashboard;
    if (!dashCfg?.enabled) return null;
    if (!dashCfg.url || !dashCfg.api_key) {
        console.log(chalk.yellow('⚠️ Dashboard aktif tapi url/api_key kosong, skip'));
        return null;
    }
    const intervalMs = Math.max(5, dashCfg.push_interval_seconds) * 1000;
    console.log(chalk.cyan(`  🌐 Dashboard push aktif (tiap ${dashCfg.push_interval_seconds}s → ${dashCfg.url})`));

    // Initial push after 10s (let bot init first)
    setTimeout(() => pushToDashboard(), 10 * 1000);

    dashboardPushTimer = setInterval(() => pushToDashboard(), intervalMs);
    return dashboardPushTimer;
}

// ── Command Poller (dashboard → bot) ─────────────────────────────────────
let commandPollerTimer = null;
const seenCommandIds = new Set(); // anti double-execute kalau race condition

async function pollCommands() {
    const dashCfg = config.dashboard;
    if (!dashCfg?.enabled || !dashCfg.url || !dashCfg.api_key) return;
    const vpsId = dashCfg.vps_id || 'default';
    const url = dashCfg.url.replace(/\/+$/, '') + '/api/commands?vpsId=' + encodeURIComponent(vpsId);

    try {
        const res = await axios.get(url, {
            headers: { 'X-API-Key': dashCfg.api_key },
            timeout: 15000,
        });
        const cmds = res.data?.commands || [];
        for (const cmd of cmds) {
            if (seenCommandIds.has(cmd.id)) continue;
            seenCommandIds.add(cmd.id);
            // Dispatch async — biar poller cepat lanjut
            dispatchCommand(cmd).catch(e => {
                console.error(`[cmd ${cmd.id}] dispatch error: ${e.message}`);
            });
        }
    } catch (e) {
        // Silent fail untuk poll error — biasanya transient network
        if (!pollCommands._failCount) pollCommands._failCount = 0;
        pollCommands._failCount++;
        if (pollCommands._failCount === 1 || pollCommands._failCount % 20 === 0) {
            console.error(chalk.yellow(`[cmd-poll] fail #${pollCommands._failCount}: ${e.response?.status || e.code || e.message}`));
        }
    }
}
pollCommands._failCount = 0;

async function reportCommandAck(cmdId, vpsId, update) {
    const dashCfg = config.dashboard;
    if (!dashCfg?.url || !dashCfg.api_key) return;
    try {
        await axios.post(
            dashCfg.url.replace(/\/+$/, '') + '/api/command-ack',
            { id: cmdId, vpsId, ...update },
            { headers: { 'Content-Type': 'application/json', 'X-API-Key': dashCfg.api_key }, timeout: 15000 }
        );
    } catch (e) {
        console.error(chalk.yellow(`[cmd-ack ${cmdId}] ${e.response?.status || e.message}`));
    }
}

async function dispatchCommand(cmd) {
    console.log(chalk.cyan(`[cmd] received ${cmd.type} ${cmd.id}`));
    const ack = (update) => reportCommandAck(cmd.id, cmd.vpsId, update);

    if (cmd.type === 'ping') {
        await ack({ status: 'done', result: { pong: true, ts: new Date().toISOString() } });
        return;
    }

    // Common ctx builder untuk command yang butuh sessions + dashboard
    const buildCtx = (label) => ({
        sessions: globalSessions,
        dashboard,
        api: globalSessions.values().next().value?.api,
        log: (msg) => console.log(chalk.gray(`[${label}] ${msg}`)),
        setPaused: (v) => { consolidationState.paused = v; },
        reportAck: ack,
        config: config.consolidation || {},
    });

    if (cmd.type === 'consolidate') {
        try {
            const { executePairConsolidation } = await import('./consolidate.js');
            consolidationState.activeCmd = cmd.id;
            await executePairConsolidation(cmd, buildCtx('consolidate'));
        } catch (e) {
            console.error(chalk.red(`[cmd] consolidate fatal: ${e.message}`));
            await ack({ status: 'failed', error: e.message });
        } finally {
            consolidationState.activeCmd = null;
        }
        return;
    }

    if (cmd.type === 'withdraw') {
        try {
            const { executeWithdraw } = await import('./withdraw.js');
            await executeWithdraw(cmd, buildCtx('withdraw'));
        } catch (e) {
            console.error(chalk.red(`[cmd] withdraw fatal: ${e.message}`));
            await ack({ status: 'failed', error: e.message });
        }
        return;
    }

    if (cmd.type === 'back-to-cc') {
        try {
            const { executeBackToCc } = await import('./back-to-cc.js');
            await executeBackToCc(cmd, buildCtx('back-to-cc'));
        } catch (e) {
            console.error(chalk.red(`[cmd] back-to-cc fatal: ${e.message}`));
            await ack({ status: 'failed', error: e.message });
        }
        return;
    }

    if (cmd.type === 'restart') {
        const reason = cmd.payload?.reason || 'user_requested';
        console.log(chalk.yellow(`[cmd] restart requested (${reason}) — exiting in 2s for supervisor respawn`));
        try {
            await ack({ status: 'done', result: { restarting: true, reason, ts: new Date().toISOString() } });
        } catch (e) {
            console.error(chalk.red(`[cmd] restart ack failed: ${e.message}`));
        }
        // Beri waktu ack sampai server + flush stdout, lalu exit.
        // Supervisor di VPS (pm2/systemd/wrapper while-loop) wajib ada untuk respawn.
        setTimeout(() => {
            console.log(chalk.yellow('[restart] process.exit(0) — supervisor harus respawn `node index.js`'));
            process.exit(0);
        }, 2000);
        return;
    }

    console.warn(chalk.yellow(`[cmd] unknown type: ${cmd.type}`));
    await ack({ status: 'failed', error: `unknown command type: ${cmd.type}` });
}

function startCommandPoller() {
    const dashCfg = config.dashboard;
    if (!dashCfg?.enabled || !dashCfg.url || !dashCfg.api_key) return null;
    const intervalSec = config.consolidation?.command_poll_interval_sec || 10;
    console.log(chalk.cyan(`  📡 Command poller aktif (tiap ${intervalSec}s)`));
    // First poll setelah 15s (let auth selesai dulu)
    setTimeout(() => pollCommands(), 15 * 1000);
    commandPollerTimer = setInterval(() => pollCommands(), intervalSec * 1000);
    return commandPollerTimer;
}

function stopCommandPoller() {
    if (commandPollerTimer) { clearInterval(commandPollerTimer); commandPollerTimer = null; }
}

function stopDashboardPush() {
    if (dashboardPushTimer) {
        clearInterval(dashboardPushTimer);
        dashboardPushTimer = null;
    }
}

// ── Global Sessions Map (untuk consolidate.js) ───────────────────────────
// Setiap akun yang sudah login akan di-register di sini by name.
// consolidate.js akses sessions via map ini saat eksekusi pair transfer.
const globalSessions = new Map();

// ── Consolidation State Flag ─────────────────────────────────────────────
// Saat true, swap loop di performSwap akan pause supaya tidak ganggu transfer.
const consolidationState = { paused: false, activeCmd: null };

// ── Session Factory ──────────────────────────────────────────────────────

function createSession() {
    return {
        walletToken: null,
        swapToken: null,
        partyId: null,
        keyPair: null,
        keyPairs: null,
        matchIdx: 0,
        walletLoginTime: 0,
        swapLoginTime: 0,

        async refreshWalletToken(walletApi, log) {
            log('🔑 Refreshing wallet token...');
            await retryOnNetwork(async () => {
                const { challenge } = await walletApi.getChallenge(this.partyId);
                const sig = toHex(signMessage(this.keyPair.privateKey, challenge));
                const { access_token } = await walletApi.login(this.partyId, challenge, sig);
                this.walletToken = access_token;
                this.walletLoginTime = Date.now();
            }, { maxRetries: 8, baseDelay: 3, label: 'refreshWallet', log });
        },

        async refreshSwapToken(swapApi, log) {
            log('🔑 Refreshing swap token...');
            await retryOnNetwork(async () => {
                const { nonce } = await swapApi.getNonce();
                const swapAuth = await swapApi.bindSignature(nonce, this.partyId);
                this.swapToken = swapAuth.accessToken;
                this.swapLoginTime = Date.now();
            }, { maxRetries: 8, baseDelay: 3, label: 'refreshSwap', log });
        },

        async ensureFreshTokens(walletApi, swapApi, log) {
            const now = Date.now();
            if (this.walletLoginTime && (now - this.walletLoginTime) > TOKEN_MAX_AGE_MS) {
                try {
                    await this.refreshWalletToken(walletApi, log);
                } catch (err) {
                    log(`⚠️ Wallet token refresh failed: ${formatError(err)}`);
                }
            }
            if (this.swapLoginTime && (now - this.swapLoginTime) > TOKEN_MAX_AGE_MS) {
                try {
                    await this.refreshSwapToken(swapApi, log);
                } catch (err) {
                    log(`⚠️ Swap token refresh failed: ${formatError(err)}`);
                }
            }
        },

        async withRetry(fn, tokenType, walletApi, swapApi, log, retryOptions = {}) {
            // Wrap with network retry first, then handle 401 inside
            return await retryOnNetwork(async () => {
                try {
                    return await fn();
                } catch (err) {
                    if (err.response?.status === 401) {
                        if (tokenType === 'swap') {
                            await this.refreshSwapToken(swapApi, log);
                        } else {
                            await this.refreshWalletToken(walletApi, log);
                        }
                        return await fn();
                    }
                    throw err;
                }
            }, { maxRetries: 5, baseDelay: 3, label: 'apiCall', log, ...retryOptions });
        },
    };
}

// ── Resolve Active Order Helper ──────────────────────────────────────────

async function resolveActiveOrder(ctx) {
    const { session, swapApi, walletApi, log } = ctx;
    const TERMINAL_S = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
    try {
        const active = await swapApi.getActiveOrder(session.swapToken, {});
        if (!active?.orderId || TERMINAL_S.includes(active.status)) return false;
        log(`🔄 Active order ${shortId(active.orderId)} (${active.status}), polling...`);
        for (let rp = 0; rp < 60; rp++) {
            await sleep(5);
            if (rp % 12 === 0 && rp > 0) await session.ensureFreshTokens(walletApi, swapApi, log);
            try {
                const st = await retryOnNetwork(
                    () => swapApi.getOrderStatus(session.swapToken, active.orderId),
                    { maxRetries: 3, baseDelay: 3, label: 'resolveOrder', log }
                );
                log(`🔄 ${shortId(active.orderId)} → ${st.status}`);
                if (TERMINAL_S.includes(st.status)) {
                    log(`✅ Order ${shortId(active.orderId)} → ${st.status}`);
                    return true;
                }
            } catch (pe) {
                if (pe.response?.status === 401) { await session.refreshSwapToken(swapApi, log); continue; }
                log(`⚠️ resolveOrder poll error: ${formatError(pe)}`);
                break;
            }
        }
        return true;
    } catch { return false; }
}

// ── Per-Account Runner ───────────────────────────────────────────────────

const MAX_ACCOUNT_RETRIES = Infinity;
const ACCOUNT_RETRY_BASE_DELAY = 15; // seconds

/** Detect if error is proxy-related (connection ended, tunnel fail, etc.) */
function isProxyError(err) {
    // 403 only counts as proxy error if it's a bare proxy reject
    // (no application-level detail/message = proxy blocked us)
    // Poll/API 403 has err.response.data with detail or message → NOT proxy
    if (err.response?.status === 403) {
        const data = err.response?.data;
        const hasAppBody = data && (data.detail || data.message || data.error);
        return !hasAppBody; // bare 403 = proxy, 403 with body = API
    }
    // Fungsi ini cuma dipanggil saat accConfig.proxy aktif (guard di runAccount),
    // jadi timeout/DNS-fail di request berproxy = proxy mati/lambat → rotate.
    const code = String(err.code || '');
    const TIMEOUT_DNS = [
        'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT',
        'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
    ];
    if (TIMEOUT_DNS.includes(code)) return true;
    const msg = String(err.message || err.code || '');
    return msg.includes('Proxy connection ended')
        || msg.includes('tunneling socket')
        || msg.includes('socket hang up')
        || msg.includes('ended')
        || msg.includes('timeout')
        || msg.includes('ETIMEDOUT')
        || msg.includes('ECONNREFUSED')
        || msg.includes('ECONNRESET')
        || msg.includes('ECONNABORTED');
}

async function runAccount(accConfig, index) {
    const name = accConfig.name || `Acc ${index + 1}`;
    const log = (msg) => dashboard.log(index, msg);
    let proxyFailCount = 0; // consecutive proxy failures

    for (let accountAttempt = 1; ; accountAttempt++) {
        try {
            await runAccountOnce(accConfig, index, name, log);
            // Success — mark proxy as good
            if (accConfig.proxy) proxyPool.markGood(accConfig.proxy);
            proxyFailCount = 0;
            return;
        } catch (err) {
            // ── Proxy error → rotate to next proxy ──
            if (accConfig.proxy && isProxyError(err)) {
                proxyFailCount++;
                const oldProxy = accConfig.proxy;
                const oldHost = (oldProxy.match(/@([^:/]+)/) || [])[1] || 'proxy';
                const newProxy = proxyPool.rotateFrom(oldProxy, index);
                accConfig.proxy = newProxy;
                const newHost = (newProxy.match(/@([^:/]+)/) || [])[1] || 'proxy';
                log(`🔀 Proxy ${oldHost} gagal (${formatError(err)}) → rotate ke ${newHost}`);
                dashboard.update(index, { status: 'proxy-rotate', proxyHost: newHost });
                // Short delay, then fresh restart with new proxy
                await sleep(Math.min(3 * proxyFailCount, 15));
                accountAttempt = Math.max(1, accountAttempt - 1); // don't escalate
                continue;
            }

            // Error 500+ → soft restart immediately (short delay)
            if (err.response?.status >= 500) {
                log(`🔄 [${err.response.status}] soft restart 5s`);
                dashboard.update(index, { status: 'soft-restart' });
                await sleep(5);
                accountAttempt = Math.max(1, accountAttempt - 1);
                proxyFailCount = 0;
                continue;
            }

            // ERR_BAD_RESPONSE → soft restart immediately
            if (err.code === 'ERR_BAD_RESPONSE' || err.message?.includes('ERR_BAD_RESPONSE')) {
                log(`🔄 [ERR_BAD_RESPONSE] soft restart 5s`);
                dashboard.update(index, { status: 'soft-restart' });
                await sleep(5);
                accountAttempt = Math.max(1, accountAttempt - 1);
                proxyFailCount = 0;
                continue;
            }

            proxyFailCount = 0;
            log(`❌ ${formatError(err)}`);
            const delay = Math.min(ACCOUNT_RETRY_BASE_DELAY * Math.pow(1.5, accountAttempt - 1), 120);
            log(`🔄 Restart ${Math.round(delay)}s (#${accountAttempt})`);
            dashboard.update(index, { status: `restart #${accountAttempt}` });
            await sleep(delay);
        }
    }
}

async function runAccountOnce(accConfig, index, name, log) {
    const currentProxy = accConfig.proxy || '';
    const ax = createAxiosInstance(currentProxy);
    const walletApi = createWalletApi(ax);
    const swapApi = createSwapApi(ax);
    const session = createSession();

    if (accConfig.proxy) {
        log(`Proxy: ${accConfig.proxy.replace(/\/\/.*@/, '//***@')}`);
        // Extract hostname robustly via regex
        const proxyHost = (accConfig.proxy.match(/@([^:/]+)/) || [])[1]
            || accConfig.proxy.split('@').pop().split(':')[0]
            || 'proxy';
        dashboard.update(index, { proxyHost });
    }

    // Step 1: Derive keys
    dashboard.update(index, { status: 'deriving' });
    log('🔑 Deriving key pairs...');
    const keyPairs = generateKeyPairs(accConfig.mnemonic);
    log(`🔑 ${keyPairs.length} keys derived`);

    // Step 2: Recover account (with network retry)
    dashboard.update(index, { status: 'recovering' });
    log('🔍 Recovering account...');
    const recovery = await retryOnNetwork(
        () => walletApi.recoverAccount(keyPairs.map(k => k.publicKeyHex)),
        { maxRetries: 5, baseDelay: 3, label: 'recover', log }
    );
    const matchIdx = (recovery.results || []).findIndex(r => r !== null);
    if (matchIdx === -1) throw new Error('No account found for this mnemonic');
    const acct = recovery.results[matchIdx];
    log(`🆔 Party: ${shortId(acct.party_id)}`);

    // Step 3: Login (with network retry)
    dashboard.update(index, { status: 'auth', nonce: true });
    log('🔐 Authenticating...');
    session.partyId = acct.party_id;
    session.keyPairs = keyPairs;
    session.matchIdx = matchIdx;
    session.keyPair = keyPairs[matchIdx];

    // Custom login loop: on challenge errors retry immediately (no backoff) since challenge is re-fetched each attempt
    let challengeRetries = 0;
    for (let loginAttempt = 1; ; loginAttempt++) {
        try {
            const { challenge } = await walletApi.getChallenge(acct.party_id);
            const sig = toHex(signMessage(keyPairs[matchIdx].privateKey, challenge));
            const { access_token } = await walletApi.login(acct.party_id, challenge, sig);
            session.walletToken = access_token;
            session.walletLoginTime = Date.now();
            break; // success
        } catch (err) {
            const is400Challenge = err.response?.status === 400 &&
                String(err.response?.data?.detail || err.response?.data?.message || JSON.stringify(err.response?.data || ''))
                    .toLowerCase().includes('challenge');
            if (is400Challenge) {
                // Challenge expired in transit — fetch fresh one immediately, no wait.
                // Cap 10x: kalau challenge 400 terus, lempar biar tak spin selamanya di 'auth'.
                if (++challengeRetries > 10) {
                    log(`❌ [login] Challenge 400 ${challengeRetries}x → give up, restart`);
                    throw err;
                }
                log(`🔄 [login] Challenge expired, retrying immediately... (attempt ${loginAttempt})`);
                continue;
            }
            // Proxy error → throw langsung biar runAccount rotate ke proxy lain
            // (kalau ditahan di loop ini, akun nyangkut di status 'auth' selamanya).
            if (accConfig.proxy && isProxyError(err)) throw err;
            // Non-retryable, atau retryable tapi sudah mentok 5x → throw biar
            // runAccount bisa rotate proxy / soft-restart, bukan loop tanpa batas.
            if (!isRetryableError(err) || loginAttempt >= 5) throw err;
            const delay = Math.min(3 * Math.pow(2, loginAttempt - 1), 30);
            log(`🔄 [login] ${formatError(err)} (attempt ${loginAttempt}, wait ${delay}s)`);
            await sleep(delay);
        }
    }
    log('✅ Authenticated');

    // Register session globally untuk consolidate.js / withdraw.js / back-to-cc.js
    session.name = name;
    session.api = walletApi;
    session.swapApi = swapApi;
    globalSessions.set(name, session);

    // Step 3b: Post-login registration checks (HAR flow)
    try {
        const regStatus = await walletApi.getRegisterStatus(session.walletToken);
        log(`📋 Registration: ${regStatus.is_registered ? '✅' : '⏳'}`);

        await walletApi.getOutgoingExpired(session.walletToken);
    } catch { /* non-critical */ }

    // Step 4: Dashboard data
    const ctx = { session, walletApi, swapApi, log, name, index, ax };
    log('📊 Fetching balance & stats...');
    dashboard.update(index, { status: 'scan' }); // jangan biarkan label 'auth' nyangkut di sini
    let holdings = {};
    try {
        holdings = await refreshAccountData(ctx);
    } catch (err) {
        // 429/error di load awal → jangan blokir. performSwap akan refresh sendiri.
        log(`⚠️ Load awal skip (${formatError(err)}), lanjut ke swap`);
    }

    // Step 4b: Start background refresh for balance & reward
    const bgRefreshId = startBackgroundRefresh(ctx);

    // Step 5: Swap
    try {
        if (config.swap.enabled) {
            dashboard.update(index, { swap: true });
            await performSwap(ctx, holdings);
        } else {
            log('⏸ Swap disabled');
            dashboard.update(index, { status: 'idle' });
        }
    } finally {
        // Always stop background refresh when done
        stopBackgroundRefresh(bgRefreshId);
    }

    log('🏁 Completed');
    dashboard.update(index, { status: 'done' });
}

// ── Refresh Account Data ─────────────────────────────────────────────────

async function refreshAccountData(ctx) {
    const { session, walletApi, swapApi, log, index } = ctx;

    const { holdings = {} } = await session.withRetry(
        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log, { throwOn429: true }
    );

    let cc = 0, usdcx = 0, ceth = 0;
    for (const [tok, info] of Object.entries(holdings)) {
        if (tok === 'Amulet' || tok === 'CC (Amulet)' || tok === 'CC') cc = info.balance || 0;
        if (tok === 'USDCx' || tok === 'USDCX') usdcx = info.balance || 0;
        if (tok === 'CETH' || tok === 'cETH' || tok === 'Ceth') ceth = info.balance || 0;
    }

    let monthReward = 0, monthVolume = 0, monthTxns = 0;
    let totalReward = 0, pendingReward = 0, rank = 0;
    let leaderboardOk = false;
    try {
        const lb = await swapApi.getLeaderboard(session.partyId);
        const me = lb.requestedAddress || null;
        if (me) {
            monthReward = parseFloat(me.rewardAccruedCc ?? 0);
            monthVolume = parseFloat(me.rewardVolumeUsd ?? me.volumeUsd ?? 0);
            monthTxns = parseInt(me.rewardSwapCount ?? me.swapCount ?? 0);
            totalReward = parseFloat(me.rewardTotalCc ?? 0);
            pendingReward = parseFloat(me.rewardAccruedCc ?? 0);
            rank = parseInt(me.rank ?? me.position ?? 0);
            leaderboardOk = true;
        }
    } catch { /* skip */ }

    // Track initial values for diff calculation
    const currentAccount = dashboard.accounts[index];
    let diffTxns = currentAccount.diffTxns || 0;
    let diffReward = currentAccount.diffReward || 0;

    if (leaderboardOk) {
        if (currentAccount.initialTxns === null) {
            // First time - set initial values
            dashboard.update(index, { initialTxns: monthTxns, initialReward: monthReward, lastKnownReward: monthReward });
        } else {
            // Sanity check: skip if reward drops >50% from last known (bad fetch)
            const lastKnown = currentAccount.lastKnownReward ?? currentAccount.initialReward ?? 0;
            if (lastKnown > 1 && monthReward < lastKnown * 0.5) {
                log(`⚠️ Leaderboard data suspect (${monthReward.toFixed(2)} vs last ${lastKnown.toFixed(2)}), skipping update`);
            } else {
                diffTxns = monthTxns - currentAccount.initialTxns;
                diffReward = monthReward - currentAccount.initialReward;
                dashboard.update(index, { lastKnownReward: monthReward });
            }
        }
    }
    // If leaderboard failed, keep previous diff values untouched

    dashboard.update(index, {
        cc, usdcx, ceth,
        ...(await fetchLockDetail(walletApi, session, holdings, index)),
        ...(leaderboardOk ? { monthReward, monthVolume, monthTxns, totalReward, pendingReward, rank, diffTxns, diffReward } : {}),
        rewardDate: new Date().toISOString().slice(0, 10),
    });

    return holdings;
}

// ── Background Refresh (Balance & Reward) ────────────────────────────────

function startBackgroundRefresh(ctx) {
    const { session, walletApi, swapApi, log, index } = ctx;
    const bgConfig = config.background_refresh || {};
    const enabled = bgConfig.enabled !== false;
    const intervalSec = bgConfig.interval_seconds || 60;

    if (!enabled) {
        log('📊 Background refresh disabled');
        return null;
    }

    const intervalMin = (intervalSec / 60).toFixed(0);
    log(`📊 Auto-refresh dashboard tiap ${intervalMin}m`);

    const intervalId = setInterval(async () => {
        try {
            // Ensure tokens are fresh before refresh
            await session.ensureFreshTokens(walletApi, swapApi, log);

            // Refresh balance
            const { holdings = {} } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );

            let cc = 0, usdcx = 0, ceth = 0;
            for (const [tok, info] of Object.entries(holdings)) {
                if (tok === 'Amulet' || tok === 'CC (Amulet)' || tok === 'CC') cc = info.balance || 0;
                if (tok === 'USDCx' || tok === 'USDCX') usdcx = info.balance || 0;
                if (tok === 'CETH' || tok === 'cETH' || tok === 'Ceth') ceth = info.balance || 0;
            }

            // Refresh reward/leaderboard data
            let monthReward = 0, monthVolume = 0, monthTxns = 0;
            let totalReward = 0, pendingReward = 0, rank = 0;
            let leaderboardOk = false;
            try {
                const lb = await swapApi.getLeaderboard(session.partyId);
                const me = lb.requestedAddress || null;
                if (me) {
                    monthReward = parseFloat(me.rewardAccruedCc ?? 0);
                    monthVolume = parseFloat(me.rewardVolumeUsd ?? me.volumeUsd ?? 0);
                    monthTxns = parseInt(me.rewardSwapCount ?? me.swapCount ?? 0);
                    totalReward = parseFloat(me.rewardTotalCc ?? 0);
                    pendingReward = parseFloat(me.rewardAccruedCc ?? 0);
                    rank = parseInt(me.rank ?? me.position ?? 0);
                    leaderboardOk = true;
                }
            } catch { /* skip leaderboard errors */ }

            // Track diff values — only update if leaderboard fetch succeeded
            const currentAccount = dashboard.accounts[index];
            let diffTxns = currentAccount.diffTxns || 0;
            let diffReward = currentAccount.diffReward || 0;

            if (leaderboardOk && currentAccount.initialTxns !== null) {
                // Sanity check: skip if reward drops >50% from last known (bad fetch)
                const lastKnown = currentAccount.lastKnownReward ?? currentAccount.initialReward ?? 0;
                if (lastKnown > 1 && monthReward < lastKnown * 0.5) {
                    // Bad fetch — don't update reward values
                    leaderboardOk = false;
                } else {
                    diffTxns = monthTxns - currentAccount.initialTxns;
                    diffReward = monthReward - currentAccount.initialReward;
                    dashboard.update(index, { lastKnownReward: monthReward });
                }
            }

            // Update dashboard silently
            dashboard.update(index, {
                cc, usdcx, ceth,
                ...(await fetchLockDetail(walletApi, session, holdings, index)),
                ...(leaderboardOk ? { monthReward, monthVolume, monthTxns, totalReward, pendingReward, rank, diffTxns, diffReward } : {}),
                rewardDate: new Date().toISOString().slice(0, 10),
            });

            const displayDiff = leaderboardOk ? diffReward : (currentAccount.diffReward || 0);
            const diffStr = displayDiff >= 0 ? `+${displayDiff.toFixed(2)}` : displayDiff.toFixed(2);
            log(`🔄 Refresh: CC ${cc.toFixed(2)} | USDCx ${usdcx.toFixed(4)} | cETH ${ceth.toFixed(6)} | Δrew ${diffStr}CC`);
        } catch (err) {
            log(`⚠️ Auto-refresh gagal: ${formatError(err)}`);
        }
    }, intervalSec * 1000);

    return intervalId;
}

function stopBackgroundRefresh(intervalId) {
    if (intervalId) {
        clearInterval(intervalId);
    }
}

// ── Wait for Account Setup (422 handling) ────────────────────────────────

async function waitForAccountSetup(swapApi, swapToken, partyId, log) {
    // ── Pre-check: pastikan tidak ada active order tertinggal ──
    // "Account setup not complete" sering dipicu oleh active order CETH/USDCX
    // yang masih AWAITING_DEPOSIT dari sesi sebelumnya — server tolak order
    // baru selama order lama belum CANCELLED. Web manual lakukan cancel dulu.
    try {
        const active = await swapApi.getActiveOrder(swapToken, {});
        if (active?.orderId) {
            const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
            if (!TERMINAL.includes(active.status)) {
                log(`🚫 Active order ${shortId(active.orderId)} (${active.status}) — cancel dulu`);
                try {
                    await swapApi.cancelOrder(swapToken, active.orderId);
                    log(`✅ Cancelled ${shortId(active.orderId)}`);
                } catch (cancelErr) {
                    // Cancel gagal? poll status sampai TERMINAL
                    log(`⚠️ Cancel gagal, poll status...`);
                    for (let p = 0; p < 30; p++) {
                        await sleep(5);
                        try {
                            const check = await swapApi.getOrderStatus(swapToken, active.orderId);
                            if (TERMINAL.includes(check.status)) {
                                log(`✅ Order ${shortId(active.orderId)} → ${check.status}`);
                                break;
                            }
                        } catch { break; }
                    }
                }
            }
        }
    } catch { /* tidak ada active order, lanjut */ }

    for (let i = 1; i <= SETUP_WAIT_MAX; i++) {
        log(`⏳ Setup pending (${i}), wait ${SETUP_WAIT_SEC}s...`);
        await sleep(SETUP_WAIT_SEC);
        try {
            // Test with a dummy quote + order to see if setup is done
            const q = await swapApi.getQuote('CC', '0x0', 'CC', 'USDCX', 1);
            const testId = generateOrderId();
            await swapApi.createOrder(swapToken, testId, q.quoteId, partyId);
            // Success — cancel the test order and return
            try { await swapApi.cancelOrder(swapToken, testId); } catch { /* ignore */ }
            log('✅ Account setup complete');
            return true;
        } catch (err) {
            const detail = String(err.response?.data?.detail || '');
            // Kalau test order gagal karena active order lain (409) → cancel & retry
            if (err.response?.status === 409) {
                try {
                    const active = await swapApi.getActiveOrder(swapToken, {});
                    if (active?.orderId) {
                        log(`🚫 Active order muncul lagi: ${shortId(active.orderId)}, cancel`);
                        try { await swapApi.cancelOrder(swapToken, active.orderId); } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
                continue;
            }
            if (detail.includes('Account setup not complete') || err.response?.status === 422) continue;
            // Different error = setup might be done, or other issue
            return true;
        }
    }
    return false;
}

// ── Instrument Admin ID Helper ───────────────────────────────────────────

function getInstrumentAdminId(holdings, assetKey) {
    // assetKey is '0x0' (Amulet/CC), 'USDCX', or 'CETH'
    const nameMap = {
        '0x0': ['Amulet', 'CC (Amulet)', 'CC'],
        'USDCX': ['USDCx', 'USDCX'],
        'CETH': ['cETH', 'CETH', 'Ceth'],
    };
    const names = nameMap[assetKey] || [assetKey];
    for (const n of names) {
        if (holdings?.[n]?.instrument_admin_id) return holdings[n].instrument_admin_id;
    }
    return '';
}

function getBalanceFor(holdings, assetKey) {
    const nameMap = {
        '0x0': ['Amulet', 'CC (Amulet)', 'CC'],
        'USDCX': ['USDCx', 'USDCX'],
        'CETH': ['cETH', 'CETH', 'Ceth'],
    };
    const names = nameMap[assetKey] || [assetKey];
    for (const n of names) {
        if (holdings?.[n]?.balance != null) return holdings[n].balance;
    }
    return 0;
}

// Saldo terkunci (nyangkut di active order / DvP allocation) untuk asset tertentu.
// Sumber: /api/balance kini balikin `locked_balance` per instrument. Default CC.
function getLockedFor(holdings, assetKey = '0x0') {
    const nameMap = {
        '0x0': ['Amulet', 'CC (Amulet)', 'CC'],
        'USDCX': ['USDCx', 'USDCX'],
        'CETH': ['cETH', 'CETH', 'Ceth'],
    };
    const names = nameMap[assetKey] || [assetKey];
    for (const n of names) {
        if (holdings?.[n]?.locked_balance != null) return parseFloat(holdings[n].locked_balance) || 0;
    }
    return 0;
}

// Locked semua asset sekaligus (CC + USDCx + cETH) → siap di-spread ke dashboard.update.
function getLockedAll(holdings) {
    return {
        lockedCc: getLockedFor(holdings, '0x0'),
        lockedUsdcx: getLockedFor(holdings, 'USDCX'),
        lockedCeth: getLockedFor(holdings, 'CETH'),
    };
}

// Cache waktu-unlock per akun. /api/balance cuma kasih jumlah locked; expiry ada di
// /api/holdings (lock.expires_at). Waktu unlock ~statis (timestamp masa depan tetap),
// jadi cukup di-refetch tiap 60s biar hot-path swap loop ga kena overhead tiap refresh.
const _lockUnlockCache = new Map(); // index -> { ts, unlock:{unlockCc,unlockUsdcx,unlockCeth} }
const LOCK_UNLOCK_TTL_MS = 60_000;

// Jumlah locked (dari balance) + waktu unlock (dari holdings, cached). Siap di-spread.
async function fetchLockDetail(walletApi, session, balanceHoldings, index) {
    const amounts = getLockedAll(balanceHoldings);
    const total = (amounts.lockedCc || 0) + (amounts.lockedUsdcx || 0) + (amounts.lockedCeth || 0);
    let unlock = { unlockCc: null, unlockUsdcx: null, unlockCeth: null };
    if (total <= 0) { _lockUnlockCache.delete(index); return { ...amounts, ...unlock }; }

    const cached = _lockUnlockCache.get(index);
    if (cached && Date.now() - cached.ts < LOCK_UNLOCK_TTL_MS) {
        unlock = cached.unlock;
    } else {
        try {
            const res = await walletApi.getHoldings(session.walletToken);
            const arr = Array.isArray(res?.holdings) ? res.holdings : [];
            // Map instrument id → bucket (alias-robust: casing/varian id beda antar registry).
            const bucketOf = (id) => {
                if (id === 'Amulet' || id === 'CC (Amulet)' || id === 'CC') return 'cc';
                if (id === 'USDCx' || id === 'USDCX') return 'usdcx';
                if (id === 'cETH' || id === 'CETH' || id === 'Ceth') return 'ceth';
                return null;
            };
            // Nilai per bucket: number(epoch ms) kalau ada expires_at absolut (Amulet/DSO),
            // atau string tag "swap" kalau lock swap-allocation tanpa expiry (USDCx/cETH →
            // unlock on-settle; expires_at & expires_after dua-duanya null di registry itu).
            const soonest = { cc: null, usdcx: null, ceth: null };
            for (const h of arr) {
                const lk = h?.lock;
                if (!lk) continue;
                const b = bucketOf(h?.instrument_id?.id);
                if (!b) continue;
                const t = Date.parse(lk.expires_at);
                if (Number.isFinite(t)) {
                    // Waktu absolut → simpan yg paling cepat (menang atas tag string).
                    if (typeof soonest[b] !== 'number' || t < soonest[b]) soonest[b] = t;
                } else if (soonest[b] == null) {
                    // Tanpa waktu → swap-allocation. Tandai "swap" (+id order kalau ada).
                    const ord = String(lk.context || '').match(/ord_[a-z0-9]+/i);
                    soonest[b] = ord ? `swap ${ord[0].slice(4, 10)}` : 'swap';
                }
            }
            unlock = { unlockCc: soonest.cc, unlockUsdcx: soonest.usdcx, unlockCeth: soonest.ceth };
            _lockUnlockCache.set(index, { ts: Date.now(), unlock });
        } catch {
            if (cached) unlock = cached.unlock; // gagal → pakai last-known
        }
    }
    return { ...amounts, ...unlock };
}

// Format waktu unlock. number(ms) → DD/MM HH:MM lokal. string → tag apa adanya
// (mis. "swap" utk lock swap-allocation tanpa expiry). null → em-dash.
function fmtUnlockTime(v) {
    if (v == null) return '—';
    if (typeof v === 'string') return v;
    const d = new Date(v);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Perform Swap ─────────────────────────────────────────────────────────

async function performSwap(ctx, holdings) {
    const { session, walletApi, swapApi, log, index } = ctx;
    const { rounds, delay_min_seconds, delay_max_seconds, min_amount, pair_a, pair_b } = config.swap;
    let pair_c = config.swap.pair_c;

    const isSetupNotComplete = (result) => {
        if (!result || !result.error) return false;
        const msg = String(result.message || '').toLowerCase();
        return msg.includes('account setup not complete');
    };

    dashboard.update(index, { status: 'checking', maxCCtoU: rounds });

    // Consolidation pause: tunggu kalau ada konsolidasi aktif (best-effort)
    while (consolidationState.paused) {
        dashboard.update(index, { status: 'paused-by-consolidation' });
        await sleep(3);
    }

    log('🌐 Checking exchange status...');
    const exchangeOk = await swapApi.checkExchange();
    if (!exchangeOk) {
        log('❌ Exchange offline → soft restart 30s');
        dashboard.update(index, { status: 'offline', swap: false });
        const offlineErr = new Error('EXCHANGE_OFFLINE');
        offlineErr.response = { status: 500 };
        throw offlineErr;
    }

    if (dynamicMinSwap.enabled) {
        log('🔍 Fetching minimum swap from API...');
        const initialAmount = await fetchDynamicMinSwap(swapApi, log);
        log(`📊 Initial swap amount: ${initialAmount.toFixed(2)}CC`);
    }

    const getMinThreshold = () => dynamicMinSwap.enabled
        ? (dynamicMinSwap.lastRawMin + dynamicMinSwap.extraCc)
        : min_amount;

    let holdingsCache = holdings || {};
    let ccBalance = getBalanceFor(holdingsCache, pair_a.asset);
    let usdcxBalance = getBalanceFor(holdingsCache, pair_b.asset);
    let cethBalance = pair_c ? getBalanceFor(holdingsCache, pair_c.asset) : 0;
    const rewardThreshold = config.swap.reward_landed_threshold ?? 100;

    if (ccBalance >= rewardThreshold) {
        log(`🎉 Reward landed! CC(${ccBalance.toFixed(2)}) >= ${rewardThreshold} → pausing`);
        dashboard.update(index, { status: 'reward-landed', swap: false });
        return;
    }

    // ── Auth swap API ──
    // NB: jangan pakai 'swap-auth' — shortStatus buang prefix 'swap-' → render 'auth'
    // yang bikin rancu dgn login wallet. Pakai 'sw-auth' biar jelas beda.
    dashboard.update(index, { status: 'sw-auth' });
    log('🔐 Authenticating swap API...');
    await retryOnNetwork(async () => {
        const { nonce } = await swapApi.getNonce();
        const swapAuth = await swapApi.bindSignature(nonce, session.partyId);
        session.swapToken = swapAuth.accessToken;
        session.swapLoginTime = Date.now();
    }, {
        maxRetries: 8, baseDelay: 5, label: 'swapAuth', log,
        // Rate-limit di swap-auth → tampilkan 'wait-rl Nm' (kuning), bukan 'auth' (keliatan stuck)
        onRateLimitWait: (delay) => dashboard.update(index, { status: `wait-rl ${Math.ceil(delay / 60)}m` }),
    });
    dashboard.update(index, { swap: true });
    log('✅ Swap API ready');

    // ── Eligibility check ──
    for (let eligAttempt = 1; ; eligAttempt++) {
        try {
            const eligibility = await swapApi.checkEligibility(session.partyId);
            if (eligibility.eligible) { log('✅ Eligible'); break; }
            log(`⏳ Not eligible, retry 30s (#${eligAttempt})`);
            dashboard.update(index, { status: `ineligible #${eligAttempt}` });
            await sleep(30);
            await session.ensureFreshTokens(walletApi, swapApi, log);
        } catch { break; }
    }

    // ── Recovery: cancel AWAITING_DEPOSIT order dari sesi sebelumnya ──
    log('🔍 Checking unfinished orders...');
    try {
        const activeOrder = await swapApi.getActiveOrder(session.swapToken, {});
        if (activeOrder?.orderId) {
            const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
            if (!TERMINAL.includes(activeOrder.status)) {
                if (activeOrder.status === 'AWAITING_DEPOSIT') {
                    log(`🚫 Stale ${shortId(activeOrder.orderId)} (AWAITING_DEPOSIT) → cancel`);
                    try { await swapApi.cancelOrder(session.swapToken, activeOrder.orderId); } catch { /* ignore */ }
                } else {
                    log(`🔄 Resume ${shortId(activeOrder.orderId)} (${activeOrder.status})`);
                    dashboard.update(index, { status: `resuming` });
                    let lastStatus = activeOrder.status;
                    while (true) {
                        await sleep(5);
                        try {
                            const check = await swapApi.getOrderStatus(session.swapToken, activeOrder.orderId);
                            if (check.status !== lastStatus) {
                                log(`⏳ ${lastStatus} → ${check.status}`);
                                lastStatus = check.status;
                            }
                            if (TERMINAL.includes(check.status)) break;
                        } catch { break; }
                    }
                }
            }
        } else {
            log('✅ No unfinished orders');
        }
    } catch { log('✅ No active orders'); }

    log('📩 Checking pending offers...');
    await acceptPendingOffers(ctx);

    // ── Refresh balance setelah recovery ──
    const refreshBalances = async () => {
        try {
            const { holdings: h } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            holdingsCache = h || holdingsCache;
            ccBalance = getBalanceFor(holdingsCache, pair_a.asset);
            usdcxBalance = getBalanceFor(holdingsCache, pair_b.asset);
            cethBalance = pair_c ? getBalanceFor(holdingsCache, pair_c.asset) : 0;
            dashboard.update(index, { cc: ccBalance, usdcx: usdcxBalance, ceth: cethBalance, ...(await fetchLockDetail(walletApi, session, holdingsCache, index)) });
        } catch { /* keep cached */ }
    };

    await refreshBalances();
    log(`💰 CC:${ccBalance.toFixed(2)} USDCx:${usdcxBalance.toFixed(4)} cETH:${cethBalance.toFixed(6)}`);

    // ── Helper: jalankan single leg (dengan validasi & deteksi setup) ──
    const doLeg = async (fromPair, toPair, amount, label, opts = {}) => {
        log(`═══ ${label} (${parseFloat(amount).toFixed(toPair.asset === 'CETH' ? 6 : 4)} ${fromPair.label})`);
        const result = await executeSwap(ctx, {
            fromChain: fromPair.chain, fromAsset: fromPair.asset,
            toChain: toPair.chain, toAsset: toPair.asset,
            amount, fromLabel: fromPair.label, toLabel: toPair.label,
            instrumentAdminId: getInstrumentAdminId(holdingsCache, fromPair.asset),
        }, opts);

        if (result && !result.error) {
            log(`✅ ${label}: +${result.receiveAmount || '?'} ${toPair.label}`);
            return result;
        }
        if (isSetupNotComplete(result)) {
            log(`🚫 ${toPair.label} belum setup — disable pair_c`);
            log(`💡 Lakukan 1x swap CETH manual via web untuk aktivasi`);
            pair_c = null;
        }
        log(`⚠️ ${label} gagal`);
        return null;
    };

    // ── Posisi state: tentukan langkah pertama ──
    // Alur: CC → USDCx → CETH → CC
    // Kalau ada saldo CETH → lanjut dari CETH→CC dulu
    // Kalau ada saldo USDCx → lanjut dari USDCx→CETH dulu
    // Kalau cuma CC → mulai CC→USDCx
    let totalSwaps = 0;
    let consecutiveFails = 0;

    // ── SMART SWAP branch ──────────────────────────────────────────────
    if (SWAP_PATTERN === 'SMART') {
        await runSmartSwap(ctx, {
            rounds, delay_min_seconds, delay_max_seconds,
            pair_a, pair_b, pair_c,
            getMinThreshold, fetchDynamicMinSwap,
            refreshBalances, doLeg, isSetupNotComplete,
            getCcBalance: () => ccBalance,
            getUsdcxBalance: () => usdcxBalance,
            getCethBalance: () => cethBalance,
            rewardThreshold, holdingsCacheRef: () => holdingsCache,
        });
        await refreshAccountData(ctx);
        log(`🏁 Done! ${dashboard.accounts[index].totalSwaps || 0} swaps`);
        dashboard.update(index, { status: 'done' });
        return;
    }
    // ───────────────────────────────────────────────────────────────────

    // ── REVERSE TRIANGLE branch (opsi 6: CC→cETH→USDCx→CC) ──────────────
    if (SWAP_PATTERN === 'AR') {
        await runTriangleReverse(ctx, {
            rounds, delay_min_seconds, delay_max_seconds,
            pair_a, pair_b, pair_c,
            fetchDynamicMinSwap,
            refreshBalances, doLeg,
            getCcBalance: () => ccBalance,
            getUsdcxBalance: () => usdcxBalance,
            getCethBalance: () => cethBalance,
            rewardThreshold,
        });
        await refreshAccountData(ctx);
        log(`🏁 Done! ${dashboard.accounts[index].totalSwaps || 0} swaps`);
        dashboard.update(index, { status: 'done' });
        return;
    }
    // ───────────────────────────────────────────────────────────────────

    // ── ROUND-TRIP 2-asset branch (pola b/c/d) ──────────────────────────
    // ── ROUND-TRIP 2-asset branch (pola b/c/d) ──────────────────────────
    if (SWAP_PATTERN === 'CCU' || SWAP_PATTERN === 'UCE' || SWAP_PATTERN === 'CCE') {
        // Map pola → base / other / stray (asset luar-rute)
        // CCU: CC↔USDCx (stray cETH) | UCE: USDCx↔cETH (stray CC) | CCE: CC↔cETH (stray USDCx)
        const routeMap = {
            'CCU': { basePair: pair_a, otherPair: pair_b, strayPair: pair_c, getStray: () => cethBalance, needsCeth: false },
            'UCE': { basePair: pair_b, otherPair: pair_c, strayPair: pair_a, getStray: () => ccBalance, needsCeth: true },
            'CCE': { basePair: pair_a, otherPair: pair_c, strayPair: pair_b, getStray: () => usdcxBalance, needsCeth: true },
        };
        const route = routeMap[SWAP_PATTERN];

        if (route.needsCeth && !pair_c) {
            log('⚠️ Pola butuh cETH aktif tapi belum setup. Lakukan 1x swap cETH manual via web. Fallback ke Triangle (A).');
            SWAP_PATTERN = 'A';
        } else {
            // Migrasi saldo nyangkut (sekali di awal) → base asset.
            // Skip kalau stray = CC: CC bukan saldo nyangkut, tapi modal yang
            // di-feed terkontrol (min+extra) oleh runRoundTrip, bukan dibulk.
            if (route.strayPair && route.strayPair.asset !== pair_a.asset) {
                await migrateStray(ctx, {
                    doLeg, swapApi,
                    strayPair: route.strayPair, basePair: route.basePair,
                    getStrayBalance: route.getStray, refreshBalances, log,
                });
            }

            await runRoundTrip(ctx, {
                rounds, delay_min_seconds, delay_max_seconds,
                basePair: route.basePair, otherPair: route.otherPair, ccPair: pair_a,
                refreshBalances, doLeg,
                rewardThreshold,
                getCcBalance: () => ccBalance,
                holdingsCacheRef: () => holdingsCache,
            });
            await refreshAccountData(ctx);
            log(`🏁 Done! ${dashboard.accounts[index].totalSwaps || 0} swaps`);
            dashboard.update(index, { status: 'done' });
            return;
        }
    }
    // ───────────────────────────────────────────────────────────────────

    const patternLabel2 = SWAP_PATTERN === 'A'
        ? 'CC→USDCx→CETH→CC'
        : 'CC→USDCx→CETH→USDCx→CC';
    log(`⚡ ${rounds} rounds (alur ${patternLabel2}, no bulk-back)`);

    // Pattern B state: per round, tandai apakah CETH sudah dikonversi ke USDCx kali ini.
    // Kalau true → USDCx yang sekarang ada adalah "USDCx hasil dari CETH" → harus → CC.
    // Kalau false → USDCx adalah "USDCx hasil dari CC" → harus → CETH.
    let cethConsumedThisRound = false;

    for (let round = 1; round <= rounds; round++) {
        await session.ensureFreshTokens(walletApi, swapApi, log);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
        await refreshBalances();

        // Pattern B: kalau saldo USDCx & CETH habis di awal round (state bersih dari CC),
        // pastikan flag direset supaya leg-2 nanti adalah USDCx→CETH bukan USDCx→CC.
        if (SWAP_PATTERN === 'B' && cethBalance <= 0 && usdcxBalance < 0.0001) {
            cethConsumedThisRound = false;
        }

        if (ccBalance >= rewardThreshold) {
            log(`🎉 Reward landed mid-loop! CC(${ccBalance.toFixed(2)})`);
            dashboard.update(index, { status: 'reward-landed', swap: false, totalSwaps });
            return;
        }

        // ── STEP A: Selesaikan saldo CETH ──
        // Pattern A: CETH → CC langsung
        // Pattern B: CETH → USDCx (lalu STEP B akan handle USDCx → CC karena cethConsumedThisRound=true)
        if (pair_c && cethBalance > 0) {
            const isB = SWAP_PATTERN === 'B';
            const targetPair = isB ? pair_b : pair_a;
            const dirLabel = isB ? `${pair_c.label}→U` : `${pair_c.label}→CC`;
            dashboard.update(index, { status: `${dirLabel} R${round}` });
            const r = await doLeg(pair_c, targetPair, cethBalance, `R${round} ${dirLabel}`, { pollTimeoutMinutes: 10 });
            if (r) {
                totalSwaps++;
                dashboard.update(index, {
                    totalSwaps, lastSwapDir: isB ? `↩U` : '↩CC',
                    swapsCETHtoCC: (dashboard.accounts[index].swapsCETHtoCC || 0) + 1,
                    ...(isB
                        ? {} // pattern B: CETH→USDCx, belum sampai CC
                        : { swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1 }),
                });
                consecutiveFails = 0;
                await refreshBalances();
                if (isB) {
                    cethConsumedThisRound = true; // tandai sebelum lanjut STEP B
                    round--; continue;
                }
            } else {
                consecutiveFails++;
                await sleep(Math.min(15 * consecutiveFails, 120));
                round--; continue;
            }
        }

        // ── STEP B: Selesaikan saldo USDCx ──
        // Pattern A: USDCx → CETH (lalu STEP A akan swap CETH → CC)
        // Pattern B:
        //   - cethConsumedThisRound=false → USDCx → CETH (sama dengan A, ini leg ke-2 dari 4)
        //   - cethConsumedThisRound=true  → USDCx → CC (leg ke-4, final)
        if (pair_c && usdcxBalance >= 0.0001) {
            const isB = SWAP_PATTERN === 'B';
            // Pattern B + sudah lewat CETH = final leg USDCx→CC; selainnya tetap USDCx→CETH
            const goDirectToCC = isB && cethConsumedThisRound;
            const targetPair = goDirectToCC ? pair_a : pair_c;
            const dirLabel = goDirectToCC ? `U→CC` : `U→${pair_c.label}`;
            dashboard.update(index, { status: `${dirLabel} R${round}` });
            const r = await doLeg(pair_b, targetPair, usdcxBalance, `R${round} ${dirLabel}`, { pollTimeoutMinutes: 10 });
            if (r) {
                totalSwaps++;
                dashboard.update(index, {
                    totalSwaps,
                    lastSwapDir: goDirectToCC ? '↩CC' : `→${pair_c.label}`,
                    ...(goDirectToCC
                        ? { swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1 }
                        : { swapsUtoCETH: (dashboard.accounts[index].swapsUtoCETH || 0) + 1 }),
                });
                consecutiveFails = 0;
                await refreshBalances();
                if (goDirectToCC) {
                    // Pattern B leg-4 selesai → reset flag, fall through ke delay
                    cethConsumedThisRound = false;
                } else {
                    // USDCx→CETH selesai → lanjut STEP A di iterasi berikutnya
                    round--; continue;
                }
            } else {
                consecutiveFails++;
                await sleep(Math.min(15 * consecutiveFails, 120));
                round--; continue;
            }
        }

        // ── STEP C: Mulai dari CC → USDCx (kalau CETH disabled, langsung CC→USDCx→CC tidak applicable; kalau pair_c null skip) ──
        if (!pair_c) {
            // CETH disabled untuk akun ini → fallback ke CC↔USDCx
            // Tetap tanpa bulk-back paksa: kalau punya USDCx, swap balik ke CC
            if (usdcxBalance >= 0.0001) {
                dashboard.update(index, { status: `U→CC R${round}` });
                const r = await doLeg(pair_b, pair_a, usdcxBalance, `R${round} U→CC`, { pollTimeoutMinutes: 10 });
                if (r) {
                    totalSwaps++;
                    dashboard.update(index, {
                        totalSwaps, lastSwapDir: '↩CC',
                        swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1,
                    });
                    await refreshBalances();
                    consecutiveFails = 0;
                } else {
                    consecutiveFails++;
                    await sleep(Math.min(15 * consecutiveFails, 120));
                    round--; continue;
                }
            }
        }

        // Sekarang state: cethBalance==0, usdcxBalance==0 → mulai CC→USDCx
        if (ccBalance < getMinThreshold()) {
            dashboard.update(index, { status: `wait CC ${ccBalance.toFixed(1)}` });
            log(`⏳ CC(${ccBalance.toFixed(2)}) < min(${getMinThreshold().toFixed(2)}), waiting...`);
            // Polling balance + offers (60s)
            for (let wp = 0; wp < 6; wp++) {
                await sleep(10);
                await session.ensureFreshTokens(walletApi, swapApi, log);
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                await refreshBalances();
                if (ccBalance >= getMinThreshold()) break;
            }
            if (ccBalance < getMinThreshold()) { round--; continue; }
        }

        // ── STEP D: CC → USDCx (leg utama) ──
        const swapAmount = await fetchDynamicMinSwap(swapApi, log);
        if (ccBalance < swapAmount) {
            log(`⏳ CC(${ccBalance.toFixed(2)}) < swap(${swapAmount.toFixed(2)}), waiting...`);
            await sleep(30);
            round--; continue;
        }

        dashboard.update(index, {
            status: `CC→U R${round}/${rounds}`,
            swapsCCtoU: (dashboard.accounts[index].swapsCCtoU || 0) + 1,
        });
        const r = await doLeg(pair_a, pair_b, swapAmount, `R${round}/${rounds} CC→U`);
        if (r) {
            totalSwaps++;
            dashboard.update(index, { totalSwaps, lastSwapDir: '→' });
            consecutiveFails = 0;
            await refreshBalances();

            // Refresh minimum dari API setelah swap sukses (detect kalau minimum turun)
            if (dynamicMinSwap.enabled && round < rounds) {
                try {
                    const freshMin = await swapApi.getMinimumSwap(pair_a.chain, pair_a.asset, pair_b.chain, pair_b.asset);
                    if (freshMin !== null && !isNaN(freshMin) && freshMin > 0 && freshMin !== dynamicMinSwap.lastRawMin) {
                        log(`📊 Min refresh: ${dynamicMinSwap.lastRawMin}→${freshMin}CC`);
                        dynamicMinSwap.lastRawMin = freshMin;
                    }
                } catch { /* silent */ }
            }
        } else {
            // Roll-back counter swapsCCtoU karena gagal
            dashboard.update(index, { swapsCCtoU: Math.max(0, (dashboard.accounts[index].swapsCCtoU || 1) - 1) });
            consecutiveFails++;
            await sleep(Math.min(10 * consecutiveFails, 120));
            await resolveActiveOrder(ctx);
            round--; continue;
        }

        // Delay antar putaran
        if (round < rounds && delay_min_seconds > 0) {
            const randomDelay = getRandomDelay(delay_min_seconds, delay_max_seconds);
            log(`⏳ Next round in ${formatDelayTime(randomDelay)}`);
            await sleep(randomDelay);
        }
    }

    // ── Selesai semua round, pastikan CETH/USDCx sisa terkonversi balik ke CC ──
    log('🏁 Final cleanup: pastikan saldo USDCx/CETH habis');
    await refreshBalances();
    await session.ensureFreshTokens(walletApi, swapApi, log);

    if (pair_c && cethBalance > 0) {
        const r = await doLeg(pair_c, pair_a, cethBalance, `Final ${pair_c.label}→CC`, { pollTimeoutMinutes: 10 });
        if (r) {
            totalSwaps++;
            dashboard.update(index, {
                totalSwaps,
                swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1,
                swapsCETHtoCC: (dashboard.accounts[index].swapsCETHtoCC || 0) + 1,
            });
            await refreshBalances();
        }
    }
    if (pair_c && usdcxBalance >= 0.0001) {
        if (SWAP_PATTERN === 'B') {
            // Pattern B cleanup: USDCx → CC langsung (jalur final yang konsisten dengan pola)
            const r = await doLeg(pair_b, pair_a, usdcxBalance, `Final U→CC`, { pollTimeoutMinutes: 10 });
            if (r) {
                totalSwaps++;
                dashboard.update(index, {
                    totalSwaps,
                    swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1,
                });
                await refreshBalances();
            }
        } else {
            // Pattern A cleanup: USDCx → CETH → CC
            const r2 = await doLeg(pair_b, pair_c, usdcxBalance, `Final U→${pair_c.label}`, { pollTimeoutMinutes: 10 });
            if (r2) {
                totalSwaps++;
                dashboard.update(index, {
                    totalSwaps,
                    swapsUtoCETH: (dashboard.accounts[index].swapsUtoCETH || 0) + 1,
                });
                await refreshBalances();
                if (cethBalance > 0) {
                    const r3 = await doLeg(pair_c, pair_a, cethBalance, `Final ${pair_c.label}→CC`, { pollTimeoutMinutes: 10 });
                    if (r3) {
                        totalSwaps++;
                        dashboard.update(index, {
                            totalSwaps,
                            swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1,
                            swapsCETHtoCC: (dashboard.accounts[index].swapsCETHtoCC || 0) + 1,
                        });
                        await refreshBalances();
                    }
                }
            }
        }
    } else if (!pair_c && usdcxBalance >= 0.0001) {
        // pair_c disabled → langsung USDCx→CC sebagai cleanup
        const r = await doLeg(pair_b, pair_a, usdcxBalance, `Final U→CC`, { pollTimeoutMinutes: 10 });
        if (r) {
            totalSwaps++;
            dashboard.update(index, {
                totalSwaps,
                swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1,
            });
            await refreshBalances();
        }
    }

    await refreshAccountData(ctx);
    log(`🏁 Done! ${totalSwaps} swaps`);
    dashboard.update(index, { status: 'done', totalSwaps });
}

// ── Round-trip 2-asset (pola b/c/d) ──────────────────────────────────────
//
// Generic loop bolak-balik antara basePair ↔ otherPair, balik ke base tiap round.
// Aturan amount:
//   - Leg dari CC      → min swap server + tambahan_cc (terkontrol, modal kecil).
//   - Leg dari non-CC  → swap MAX (full balance yang dimiliki).
// Kalau base bukan CC (mis. pola 3 USDCx↔cETH) dan saldo base kurang, di-feed
// dari CC pakai aturan min+extra (CC→base) supaya loop tetap jalan.
async function runRoundTrip(ctx, params) {
    const { session, walletApi, swapApi, log, index } = ctx;
    const {
        rounds, delay_min_seconds, delay_max_seconds,
        basePair, otherPair, ccPair,
        refreshBalances, doLeg,
        rewardThreshold,
        getCcBalance, holdingsCacheRef,
    } = params;

    const DUST = 0.0001;
    const balOf = (pair) => getBalanceFor(holdingsCacheRef(), pair.asset);
    const baseIsCc = basePair.asset === ccPair.asset;

    log(`⚡ ${rounds} rounds round-trip ${basePair.label}→${otherPair.label}→${basePair.label}`);

    let totalSwaps = 0;
    let consecutiveFails = 0;

    for (let round = 1; round <= rounds; round++) {
        await session.ensureFreshTokens(walletApi, swapApi, log);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
        await refreshBalances();

        // Reward landed (CC) → stop
        if (getCcBalance() >= rewardThreshold) {
            log(`🎉 Reward landed! CC(${getCcBalance().toFixed(2)}) >= ${rewardThreshold}`);
            dashboard.update(index, { status: 'reward-landed', swap: false, totalSwaps });
            return;
        }

        // ── Back leg dulu: bereskan sisa otherPair → base ──
        if (balOf(otherPair) > DUST) {
            const amt = balOf(otherPair);
            dashboard.update(index, { status: `${otherPair.label}→${basePair.label} R${round}` });
            const r = await doLeg(otherPair, basePair, amt, `R${round} ${otherPair.label}→${basePair.label}`, { pollTimeoutMinutes: 10 });
            if (r) {
                totalSwaps++;
                dashboard.update(index, { totalSwaps, lastSwapDir: `↩${basePair.label}` });
                consecutiveFails = 0;
                await refreshBalances();
            } else {
                consecutiveFails++;
                await sleep(Math.min(15 * consecutiveFails, 120));
                round--; continue;
            }
        }

        // ── Minimum arah forward (base→other) ──
        // fwdAmt = raw + extra (controlled). Gate berbeda per asal:
        //   - Base CC      → butuh raw+extra (modal terkontrol, swap sejumlah ini).
        //   - Base non-CC  → cukup raw min server (swap MAX full balance). extra (buffer CC)
        //     kebesaran kalau ditambah ke min non-CC → bikin deadlock (USDCx 4.44 < 3+2.1).
        const fwdAmt = await fetchMinFor(swapApi, basePair, otherPair, log);
        const extra = dynamicMinSwap.enabled ? dynamicMinSwap.extraCc : 0;
        const fwdRaw = Math.max(0, fwdAmt - extra);
        const fwdMin = baseIsCc ? fwdAmt : fwdRaw;

        // ── Pastikan saldo base cukup untuk forward ──
        if (balOf(basePair) < fwdMin) {
            if (baseIsCc) {
                // Base CC → tunggu reward/offers masuk
                dashboard.update(index, { status: `wait ${basePair.label} ${balOf(basePair).toFixed(1)}` });
                log(`⏳ ${basePair.label}(${balOf(basePair).toFixed(2)}) < min(${fwdMin.toFixed(2)}), waiting...`);
                for (let wp = 0; wp < 6; wp++) {
                    await sleep(10);
                    await session.ensureFreshTokens(walletApi, swapApi, log);
                    try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                    await refreshBalances();
                    if (balOf(basePair) >= fwdMin) break;
                }
                if (balOf(basePair) < fwdMin) { round--; continue; }
            } else {
                // Base non-CC → kasih makan dari CC pakai min+extra (CC→base)
                const feedAmt = await fetchMinFor(swapApi, ccPair, basePair, log);
                if (getCcBalance() >= feedAmt) {
                    log(`🍚 Feed ${ccPair.label}→${basePair.label} ${feedAmt.toFixed(2)} (seed loop)`);
                    dashboard.update(index, { status: `feed ${basePair.label} R${round}` });
                    const rfeed = await doLeg(ccPair, basePair, feedAmt, `R${round} feed ${ccPair.label}→${basePair.label}`);
                    if (rfeed) { totalSwaps++; dashboard.update(index, { totalSwaps }); await refreshBalances(); }
                } else {
                    // CC pun kurang → tunggu reward/offers
                    dashboard.update(index, { status: `wait CC ${getCcBalance().toFixed(1)}` });
                    log(`⏳ ${basePair.label}(${balOf(basePair).toFixed(2)}) & CC(${getCcBalance().toFixed(2)}) kurang, waiting...`);
                    for (let wp = 0; wp < 6; wp++) {
                        await sleep(10);
                        await session.ensureFreshTokens(walletApi, swapApi, log);
                        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                        await refreshBalances();
                        if (getCcBalance() >= feedAmt || balOf(basePair) >= fwdMin) break;
                    }
                }
                if (balOf(basePair) < fwdMin) { round--; continue; }
            }
        }

        // ── Forward leg: base → other ──
        // CC base = amount terkontrol (min+extra). Non-CC base = MAX full balance.
        const swapAmount = baseIsCc ? fwdMin : balOf(basePair);
        if (swapAmount < DUST) { round--; continue; }
        dashboard.update(index, { status: `${basePair.label}→${otherPair.label} R${round}/${rounds}` });
        const rf = await doLeg(basePair, otherPair, swapAmount, `R${round}/${rounds} ${basePair.label}→${otherPair.label}`);
        if (rf) {
            totalSwaps++;
            dashboard.update(index, { totalSwaps, lastSwapDir: `→${otherPair.label}` });
            consecutiveFails = 0;
            await refreshBalances();
        } else {
            consecutiveFails++;
            await sleep(Math.min(10 * consecutiveFails, 120));
            await resolveActiveOrder(ctx);
            round--; continue;
        }

        // ── Back leg: other → base (full) ──
        if (balOf(otherPair) > DUST) {
            const amt = balOf(otherPair);
            dashboard.update(index, { status: `${otherPair.label}→${basePair.label} R${round}/${rounds}` });
            const rb = await doLeg(otherPair, basePair, amt, `R${round}/${rounds} ${otherPair.label}→${basePair.label}`, { pollTimeoutMinutes: 10 });
            if (rb) {
                totalSwaps++;
                dashboard.update(index, { totalSwaps, lastSwapDir: `↩${basePair.label}` });
                await refreshBalances();
            }
        }

        if (round < rounds && delay_min_seconds > 0) {
            const randomDelay = getRandomDelay(delay_min_seconds, delay_max_seconds);
            log(`⏳ Next round in ${formatDelayTime(randomDelay)}`);
            await sleep(randomDelay);
        }
    }

    // ── Cleanup: pastikan sisa otherPair balik ke base ──
    await refreshBalances();
    if (balOf(otherPair) > DUST) {
        const r = await doLeg(otherPair, basePair, balOf(otherPair), `Final ${otherPair.label}→${basePair.label}`, { pollTimeoutMinutes: 10 });
        if (r) { totalSwaps++; dashboard.update(index, { totalSwaps }); await refreshBalances(); }
    }
}

// ── Smart Swap ───────────────────────────────────────────────────────────
//
// Mekanisme:
// - Modal kerja = swapAmount CC (mis. 27 CC). Saldo CC sisanya tidak disentuh.
// - Pair (bidirectional): CC↔U, U↔E, E↔CC. cETH pair tetap dicoba walau belum setup (force).
// - Cari pair yang TIDAK kena rate-limit; tiap percobaan pakai fresh quote.
// - Pair gagal (429/setup/error) → masuk `recentRL`, switch ke pair lain (cooldown 1 detik).
// - Kalau SEMUA pair (yg ada saldo) gagal karena 429 → wait "normal rate_limit" (config.json),
//   lalu reset burst & coba lagi. Sukses 1 leg → reset semua.
// - CC source = min+extra; USDCx/cETH source = full balance.
//
// Catatan: 1 round di Smart Swap = 1 leg sukses (bukan 1 putaran 3 leg).

async function runSmartSwap(ctx, params) {
    const { session, walletApi, swapApi, log, index } = ctx;
    const {
        rounds, delay_min_seconds, delay_max_seconds,
        pair_a, pair_b, pair_c,
        getMinThreshold, fetchDynamicMinSwap,
        refreshBalances, doLeg, isSetupNotComplete,
        getCcBalance, getUsdcxBalance, getCethBalance,
        rewardThreshold,
    } = params;

    const { holdingsCacheRef } = params;

    // Force mode (Q3a): cETH pair tetap dicoba walau belum setup di akun.
    // Error "setup not complete" diperlakukan cooldown pendek + switch pair, BUKAN disable.
    const hasCeth = !!pair_c;
    if (!hasCeth) log('⚠️ pair_c null → Smart Swap jalan CC↔USDCx saja');

    // ── Definisi pair (bidirectional). cETH pair di-include walau belum setup. ──
    const pairKey = (fromAsset, toAsset) => `${fromAsset}>${toAsset}`;
    const PAIRS = [
        { from: pair_a, to: pair_b, key: pairKey(pair_a.asset, pair_b.asset), label: 'CC→U' },
        { from: pair_b, to: pair_a, key: pairKey(pair_b.asset, pair_a.asset), label: 'U→CC' },
    ];
    if (hasCeth) {
        PAIRS.push(
            { from: pair_b, to: pair_c, key: pairKey(pair_b.asset, pair_c.asset), label: 'U→E' },
            { from: pair_c, to: pair_b, key: pairKey(pair_c.asset, pair_b.asset), label: 'E→U' },
            { from: pair_c, to: pair_a, key: pairKey(pair_c.asset, pair_a.asset), label: 'E→CC' },
            { from: pair_a, to: pair_c, key: pairKey(pair_a.asset, pair_c.asset), label: 'CC→E' },
        );
    }

    // ── Rate-limit switching model (spec) ──
    // recentRL : pair-key yang sudah dicoba & gagal di burst ini. Pair di sini di-skip
    //            sampai burst di-reset. Begitu SEMUA pair (yg ada saldo) masuk recentRL →
    //            kalau gara-gara 429 (rlSeenInBurst) tunggu "normal rate_limit" dari config,
    //            selain itu tunggu singkat. Lalu clear burst & coba semua pair lagi.
    // SWITCH_COOLDOWN_SEC = 1 detik antar percobaan pair (spec: "cooldown 1 detik").
    const SWITCH_COOLDOWN_SEC = 1;
    const recentRL = new Set();
    let rlSeenInBurst = false;
    let rlBurstHits = 0;  // index escalating untuk normal rate_limit wait

    // "normal rate_limit" dari config.json (rate_limit.tunggu_pertama_menit + tunggu_lanjutan_detik)
    const normalRateLimitSec = () => {
        const firstMin = config.retry?.rate_limit_initial_delay_minutes ?? 15;
        const delays = config.retry?.rate_limit_delays || [400, 120, 60];
        const sec = rlBurstHits === 0
            ? firstMin * 60
            : delays[Math.min(rlBurstHits - 1, delays.length - 1)];
        rlBurstHits++;
        return sec;
    };

    // ── Fresh-quote single leg. throwOn429 + fastSetupFail → 429/setup langsung balik
    //    (tidak nyangkut di internal retry) supaya bisa switch pair cepat. ──
    const smartLeg = async (fromPair, toPair, amount) => {
        const hc = (typeof holdingsCacheRef === 'function') ? holdingsCacheRef() : {};
        return await executeSwap(ctx, {
            fromChain: fromPair.chain, fromAsset: fromPair.asset,
            toChain: toPair.chain, toAsset: toPair.asset,
            amount, fromLabel: fromPair.label, toLabel: toPair.label,
            instrumentAdminId: getInstrumentAdminId(hc, fromPair.asset),
        }, { pollTimeoutMinutes: 10, throwOn429: true, fastSetupFail: true });
    };

    // ── State modal kerja ──
    const initialCC = getCcBalance();
    let workingAmount = await fetchDynamicMinSwap(swapApi, log);   // min + tambahan_cc
    log(`💡 Smart Swap aktif. Modal kerja: ~${workingAmount.toFixed(2)} CC. Saldo CC: ${initialCC.toFixed(2)}`);

    let totalSwaps = 0;

    // In-flight CC: CC yang sudah dipakai swap tapi balance belum turun (settlement lambat).
    let inFlightCC = 0;
    let lastKnownCC = getCcBalance();

    for (let iter = 1; iter <= rounds; iter++) {
        await session.ensureFreshTokens(walletApi, swapApi, log);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
        await refreshBalances();

        const ccBal = getCcBalance();
        const usdcxBal = getUsdcxBalance();
        const cethBal = getCethBalance();

        if (ccBal < lastKnownCC - 1) inFlightCC = 0; // settlement sudah reflected
        lastKnownCC = ccBal;
        const effectiveCC = Math.max(0, ccBal - inFlightCC);

        if (ccBal >= rewardThreshold) {
            log(`🎉 Reward landed! CC(${ccBal.toFixed(2)}) >= ${rewardThreshold}`);
            dashboard.update(index, { status: 'reward-landed', totalSwaps });
            return;
        }

        // ── Kandidat: pair yang source-nya cukup saldo ──
        // RULE: CC boleh dijadikan source HANYA kalau USDCx & cETH dua-duanya 0.
        // Selama masih ada saldo USDCx atau cETH, CC-source di-skip total (bukan
        // cuma de-prioritas) supaya modal CC tidak keambil saat pair non-CC rate-limited.
        const USDCX_MIN = 0.0001;
        const CETH_MIN = 0.000001;
        const hasUsdcBal = usdcxBal >= USDCX_MIN;
        const hasCethBal = hasCeth && cethBal >= CETH_MIN;
        const nonCcHasBalance = hasUsdcBal || hasCethBal;

        const withBalance = [];
        for (const p of PAIRS) {
            const isCcSource = p.from.asset === pair_a.asset;
            // CC hanya boleh diambil kalau USDCx DAN cETH dua-duanya 0.
            if (isCcSource && nonCcHasBalance) continue;

            let sourceBalance = 0;
            if (isCcSource) sourceBalance = effectiveCC;
            else if (p.from.asset === pair_b.asset) sourceBalance = usdcxBal;
            else if (p.from.asset === pair_c.asset) sourceBalance = cethBal;
            // CC source = min+extra; USDCx/cETH source = full balance (Q2)
            const minSrc = isCcSource
                ? workingAmount
                : (p.from.asset === pair_b.asset ? USDCX_MIN : CETH_MIN);
            if (sourceBalance < minSrc) continue;
            withBalance.push({ ...p, sourceBalance });
        }

        // Ready = punya saldo & belum dicoba (gagal) di burst ini
        const ready = withBalance.filter(p => !recentRL.has(p.key));

        if (!ready.length) {
            if (withBalance.length > 0) {
                // Semua pair (yg ada saldo) sudah dicoba & gagal di burst ini
                if (rlSeenInBurst) {
                    const sec = normalRateLimitSec();
                    const lbl = sec >= 60 ? `${Math.ceil(sec / 60)}m` : `${sec}s`;
                    log(`🔒 Semua pair rate-limited → wait ${lbl} (normal rate_limit)`);
                    dashboard.update(index, { status: `wait-rl ${lbl}` });
                    await sleep(sec);
                } else {
                    log(`⚠️ Semua pair gagal (non-429) → wait 30s`);
                    dashboard.update(index, { status: 'wait 30s' });
                    await sleep(30);
                }
                recentRL.clear();
                rlSeenInBurst = false;
            } else {
                // Tidak ada saldo cukup → tunggu saldo masuk (offer/reward), looping selamanya.
                // Kalau saldo sebenarnya ada tapi nyangkut di lock (active order) → st = 'lock'.
                // Cek semua asset: CC / USDCx / cETH.
                const _a = dashboard.accounts[index] || {};
                const lockedNow = (_a.lockedCc || 0) + (_a.lockedUsdcx || 0) + (_a.lockedCeth || 0);
                log(`⏳ Saldo tidak cukup untuk swap. Wait 30s (nunggu saldo masuk)${lockedNow > 0 ? ' — ada saldo terkunci' : ''}`);
                dashboard.update(index, { status: lockedNow > 0 ? 'lock' : 'bal' });
                await sleep(30);
            }
            iter--;
            continue;
        }

        // Pilih kandidat: non-CC source dulu (modal kerja terus berputar), tie-break saldo terbesar
        ready.sort((a, b) => {
            const aIsCC = a.from.asset === pair_a.asset ? 1 : 0;
            const bIsCC = b.from.asset === pair_a.asset ? 1 : 0;
            if (aIsCC !== bIsCC) return aIsCC - bIsCC;
            return b.sourceBalance - a.sourceBalance;
        });
        const chosen = ready[0];

        // CC source → workingAmount (min+extra); selainnya → full balance
        const swapAmt = (chosen.from.asset === pair_a.asset) ? workingAmount : chosen.sourceBalance;

        dashboard.update(index, { status: `${chosen.label} #${totalSwaps + 1}` });
        log(`🔀 ${chosen.label} (${parseFloat(swapAmt).toFixed(4)} ${chosen.from.label})`);

        const result = await smartLeg(chosen.from, chosen.to, swapAmt);
        const ok = result && result !== true && !result.error && result.receiveAmount != null;

        if (ok) {
            totalSwaps++;
            rlBurstHits = 0;       // sukses → reset escalating
            rlSeenInBurst = false;
            recentRL.clear();      // sukses → fresh slate semua pair

            if (chosen.from.asset === pair_a.asset) {
                inFlightCC += swapAmt;
                log(`📊 In-flight CC: ${inFlightCC.toFixed(2)} (eff: ${Math.max(0, getCcBalance() - inFlightCC).toFixed(2)})`);
            }
            if (chosen.to.asset === pair_a.asset) inFlightCC = 0;

            dashboard.update(index, { totalSwaps, lastSwapDir: chosen.label });
            const acc = dashboard.accounts[index];
            const counterMap = {
                'CC→U': 'swapsCCtoU', 'U→CC': 'swapsUtCC',
                'U→E': 'swapsUtoCETH', 'E→U': 'swapsCETHtoCC',
                'E→CC': 'swapsCETHtoCC', 'CC→E': 'swapsCCtoU',
            };
            const cKey = counterMap[chosen.label];
            if (cKey) dashboard.update(index, { [cKey]: (acc[cKey] || 0) + 1 });
            await refreshBalances();

            // Refresh dynamic minimum kalau sukses CC→USDCx
            if (dynamicMinSwap.enabled && chosen.from.asset === pair_a.asset && chosen.to.asset === pair_b.asset) {
                try {
                    const freshMin = await swapApi.getMinimumSwap(pair_a.chain, pair_a.asset, pair_b.chain, pair_b.asset);
                    if (freshMin !== null && !isNaN(freshMin) && freshMin > 0) {
                        dynamicMinSwap.lastRawMin = freshMin;
                        workingAmount = freshMin + dynamicMinSwap.extraCc;
                    }
                } catch { /* silent */ }
            }

            // Setelah tiap swap sukses: patuhi jeda_antar_swap_detik dari config.json
            if (iter < rounds && delay_min_seconds > 0) {
                const d = getRandomDelay(delay_min_seconds, delay_max_seconds);
                log(`⏳ Jeda antar swap ${formatDelayTime(d)}`);
                await sleep(d);
            }
        } else {
            const code = result?.code;
            const msg = String(result?.message || '').toLowerCase();
            const is429 = code === 429 || msg.includes('rate limit') || msg.includes('too many');
            const isSetup = code === 422 || msg.includes('account setup not complete') || isSetupNotComplete(result);

            if (is429) {
                rlSeenInBurst = true;
                log(`🔁 ${chosen.label} rate-limited → switch pair (${SWITCH_COOLDOWN_SEC}s)`);
            } else if (isSetup) {
                log(`🔁 ${chosen.label} belum setup (force) → switch pair (${SWITCH_COOLDOWN_SEC}s)`);
            } else {
                log(`⚠️ ${chosen.label} gagal [${code || msg || '?'}] → switch pair (${SWITCH_COOLDOWN_SEC}s)`);
            }
            // Semua kegagalan: tandai pair sudah dicoba di burst ini → coba pair lain dulu.
            recentRL.add(chosen.key);
            await sleep(SWITCH_COOLDOWN_SEC);
            iter--;
            continue;
        }
    }

    // ── Cleanup: balikin USDCx & cETH ke CC ──
    log('🏁 Smart cleanup: bulk USDCx & cETH → CC');
    await refreshBalances();
    if (hasCeth && getCethBalance() > 0.000001) {
        const r = await smartLeg(pair_c, pair_a, getCethBalance());
        if (r && !r.error) await refreshBalances();
    }
    if (getUsdcxBalance() >= 0.0001) {
        const r = await smartLeg(pair_b, pair_a, getUsdcxBalance());
        if (r && !r.error) await refreshBalances();
    }
    dashboard.update(index, { totalSwaps });
}

// ── Reverse Triangle (opsi 6): CC→cETH→USDCx→CC ──────────────────────────
//
// Salinan logic opsi 1 (Triangle A: CC→USDCx→cETH→CC) tapi arah dibalik.
// Aturan amount sama: leg dari CC = min+extra (terkontrol), leg dari non-CC = full.
// Butuh cETH aktif (pair_c). Kalau belum setup → fallback CC↔USDCx.

async function runTriangleReverse(ctx, params) {
    const { session, walletApi, swapApi, log, index } = ctx;
    const {
        rounds, delay_min_seconds, delay_max_seconds,
        pair_a, pair_b, pair_c,
        fetchDynamicMinSwap,
        refreshBalances, doLeg,
        getCcBalance, getUsdcxBalance, getCethBalance,
        rewardThreshold,
    } = params;

    // Entry min untuk CC→cETH (min+extra). Fallback CC→USDCx kalau cETH off.
    const entryMin = async () => pair_c
        ? await fetchMinFor(swapApi, pair_a, pair_c, log)
        : await fetchDynamicMinSwap(swapApi, log);

    log(`⚡ ${rounds} rounds (alur CC→CETH→USDCx→CC, no bulk-back)`);

    let totalSwaps = 0;
    let consecutiveFails = 0;

    for (let round = 1; round <= rounds; round++) {
        await session.ensureFreshTokens(walletApi, swapApi, log);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
        await refreshBalances();

        if (getCcBalance() >= rewardThreshold) {
            log(`🎉 Reward landed mid-loop! CC(${getCcBalance().toFixed(2)})`);
            dashboard.update(index, { status: 'reward-landed', swap: false, totalSwaps });
            return;
        }

        // ── STEP A: Selesaikan saldo USDCx → CC langsung ──
        if (getUsdcxBalance() >= 0.0001) {
            const amt = getUsdcxBalance();
            dashboard.update(index, { status: `U→CC R${round}` });
            const r = await doLeg(pair_b, pair_a, amt, `R${round} U→CC`, { pollTimeoutMinutes: 10 });
            if (r) {
                totalSwaps++;
                dashboard.update(index, {
                    totalSwaps, lastSwapDir: '↩CC',
                    swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1,
                });
                consecutiveFails = 0;
                await refreshBalances();
            } else {
                consecutiveFails++;
                await sleep(Math.min(15 * consecutiveFails, 120));
                round--; continue;
            }
        }

        // ── STEP B: Selesaikan saldo CETH → USDCx ──
        if (pair_c && getCethBalance() > 0) {
            const amt = getCethBalance();
            dashboard.update(index, { status: `${pair_c.label}→U R${round}` });
            const r = await doLeg(pair_c, pair_b, amt, `R${round} ${pair_c.label}→U`, { pollTimeoutMinutes: 10 });
            if (r) {
                totalSwaps++;
                dashboard.update(index, {
                    totalSwaps,
                    lastSwapDir: '→U',
                    swapsCETHtoCC: (dashboard.accounts[index].swapsCETHtoCC || 0) + 1,
                });
                consecutiveFails = 0;
                await refreshBalances();
                // CETH→USDCx selesai → STEP A akan handle USDCx→CC di iterasi berikutnya
                round--; continue;
            } else {
                consecutiveFails++;
                await sleep(Math.min(15 * consecutiveFails, 120));
                round--; continue;
            }
        }

        // ── Fallback kalau cETH belum setup → CC↔USDCx ──
        if (!pair_c) {
            // sisa USDCx sudah dihandle STEP A; di sini cuma entry CC→USDCx
            const swapAmount = await fetchDynamicMinSwap(swapApi, log);
            if (getCcBalance() < swapAmount) {
                dashboard.update(index, { status: `wait CC ${getCcBalance().toFixed(1)}` });
                for (let wp = 0; wp < 6; wp++) {
                    await sleep(10);
                    await session.ensureFreshTokens(walletApi, swapApi, log);
                    try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                    await refreshBalances();
                    if (getCcBalance() >= swapAmount) break;
                }
                if (getCcBalance() < swapAmount) { round--; continue; }
            }
            dashboard.update(index, { status: `CC→U R${round}/${rounds}`, swapsCCtoU: (dashboard.accounts[index].swapsCCtoU || 0) + 1 });
            const r = await doLeg(pair_a, pair_b, swapAmount, `R${round}/${rounds} CC→U`);
            if (r) {
                totalSwaps++;
                dashboard.update(index, { totalSwaps, lastSwapDir: '→' });
                consecutiveFails = 0;
                await refreshBalances();
            } else {
                dashboard.update(index, { swapsCCtoU: Math.max(0, (dashboard.accounts[index].swapsCCtoU || 1) - 1) });
                consecutiveFails++;
                await sleep(Math.min(10 * consecutiveFails, 120));
                await resolveActiveOrder(ctx);
                round--; continue;
            }
            if (round < rounds && delay_min_seconds > 0) {
                const d = getRandomDelay(delay_min_seconds, delay_max_seconds);
                log(`⏳ Next round in ${formatDelayTime(d)}`);
                await sleep(d);
            }
            continue;
        }

        // ── STEP C: entry CC → CETH (leg utama, min+extra) ──
        const swapAmount = await entryMin();
        if (getCcBalance() < swapAmount) {
            dashboard.update(index, { status: `wait CC ${getCcBalance().toFixed(1)}` });
            log(`⏳ CC(${getCcBalance().toFixed(2)}) < min(${swapAmount.toFixed(2)}), waiting...`);
            for (let wp = 0; wp < 6; wp++) {
                await sleep(10);
                await session.ensureFreshTokens(walletApi, swapApi, log);
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                await refreshBalances();
                if (getCcBalance() >= swapAmount) break;
            }
            if (getCcBalance() < swapAmount) { round--; continue; }
        }

        dashboard.update(index, {
            status: `CC→${pair_c.label} R${round}/${rounds}`,
            swapsCCtoU: (dashboard.accounts[index].swapsCCtoU || 0) + 1,
        });
        const r = await doLeg(pair_a, pair_c, swapAmount, `R${round}/${rounds} CC→${pair_c.label}`);
        if (r) {
            totalSwaps++;
            dashboard.update(index, { totalSwaps, lastSwapDir: '→' });
            consecutiveFails = 0;
            await refreshBalances();
        } else {
            dashboard.update(index, { swapsCCtoU: Math.max(0, (dashboard.accounts[index].swapsCCtoU || 1) - 1) });
            consecutiveFails++;
            await sleep(Math.min(10 * consecutiveFails, 120));
            await resolveActiveOrder(ctx);
            round--; continue;
        }

        if (round < rounds && delay_min_seconds > 0) {
            const randomDelay = getRandomDelay(delay_min_seconds, delay_max_seconds);
            log(`⏳ Next round in ${formatDelayTime(randomDelay)}`);
            await sleep(randomDelay);
        }
    }

    // ── Cleanup: sisa CETH/USDCx balik ke CC ──
    log('🏁 Final cleanup: pastikan saldo CETH/USDCx habis');
    await refreshBalances();
    await session.ensureFreshTokens(walletApi, swapApi, log);

    if (getUsdcxBalance() >= 0.0001) {
        const r = await doLeg(pair_b, pair_a, getUsdcxBalance(), `Final U→CC`, { pollTimeoutMinutes: 10 });
        if (r) {
            totalSwaps++;
            dashboard.update(index, { totalSwaps, swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1 });
            await refreshBalances();
        }
    }
    if (pair_c && getCethBalance() > 0) {
        const r2 = await doLeg(pair_c, pair_b, getCethBalance(), `Final ${pair_c.label}→U`, { pollTimeoutMinutes: 10 });
        if (r2) {
            totalSwaps++;
            dashboard.update(index, { totalSwaps, swapsCETHtoCC: (dashboard.accounts[index].swapsCETHtoCC || 0) + 1 });
            await refreshBalances();
            if (getUsdcxBalance() >= 0.0001) {
                const r3 = await doLeg(pair_b, pair_a, getUsdcxBalance(), `Final U→CC`, { pollTimeoutMinutes: 10 });
                if (r3) {
                    totalSwaps++;
                    dashboard.update(index, { totalSwaps, swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1 });
                    await refreshBalances();
                }
            }
        }
    }

    dashboard.update(index, { totalSwaps });
}

// ── Accept Pending Offers ────────────────────────────────────────────────

async function acceptPendingOffers(ctx) {
    const { session, walletApi, swapApi, log, ax } = ctx;

    // Fetch offers — coba V2 dulu (web pakai ini), fallback ke V1 kalau V2
    // gagal/empty supaya tetap kompatibel dengan offer USDCx/cETH lama.
    const fetchOnce = async () => {
        let v2 = null, v1 = null;
        try {
            v2 = await session.withRetry(
                () => walletApi.getOffersV2(session.walletToken), 'wallet', walletApi, swapApi, log
            );
        } catch { /* ignore, try V1 */ }
        try {
            v1 = await session.withRetry(
                () => walletApi.getOffers(session.walletToken), 'wallet', walletApi, swapApi, log
            );
        } catch { /* ignore */ }

        // Merge: V2 + V1, dedupe by contract_id (V2 punya struktur baru dengan
        // accept/reject nested object — kita normalize ke flat shape supaya
        // logic accept downstream tidak perlu cabang dua jalan).
        const seen = new Set();
        const out = [];
        const pushNorm = (o, src) => {
            const cid = o.contract_id || o.contractId;
            if (cid && seen.has(cid)) return;
            if (cid) seen.add(cid);
            // V2 menempatkan tx data di o.accept, V1 flat. Normalize:
            const acc = o.accept || {};
            out.push({
                ...o,
                _src: src,
                prepared_tx_b64: o.prepared_tx_b64 || o.preparedTxB64 || acc.prepared_tx_b64 || acc.preparedTxB64 || null,
                hash_b64: o.hash_b64 || o.hashB64 || acc.hash_b64 || acc.hashB64 || null,
                hashing_scheme_version: o.hashing_scheme_version || o.hashingSchemeVersion
                    || acc.hashing_scheme_version || acc.hashingSchemeVersion || 'HASHING_SCHEME_VERSION_V2',
            });
        };
        for (const o of (v2?.offers || [])) pushNorm(o, 'v2');
        for (const o of (v1?.offers || [])) pushNorm(o, 'v1');
        return out;
    };

    let offers = [];
    const OFFER_WAITS = [2, 3];
    for (let attempt = 1; attempt <= OFFER_WAITS.length; attempt++) {
        try {
            offers = await fetchOnce();
            if (offers.length > 0) break;
        } catch { /* ignore */ }
        if (attempt < OFFER_WAITS.length) await sleep(OFFER_WAITS[attempt - 1]);
    }

    if (!offers.length) return;

    log(`📩 ${offers.length} offer(s)`);

    for (const offer of offers) {
        const contractId = offer.contract_id || offer.contractId;
        const commandId = offer.command_id || offer.commandId;
        const instrumentId = offer.instrument_id || offer.instrumentId || 'USDCx';
        const amount = offer.amount || '?';

        try {
            const preparedTxB64 = offer.prepared_tx_b64;
            const hashB64 = offer.hash_b64;

            if (preparedTxB64 && hashB64) {
                const signature = signMessage(session.keyPair.privateKey, Buffer.from(hashB64, 'base64'));
                await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
                    commandId, preparedTxB64,
                    signatureB64: toBase64(signature),
                    hashingSchemeVersion: offer.hashing_scheme_version,
                }), 'wallet', walletApi, swapApi, log);
                log(`✅ Accept ${amount} ${instrumentId}`);
            } else if (contractId) {
                let rawPrepare = null;
                for (const ep of ['/offer/accept/prepare', '/offers/accept/prepare', '/offers/accept']) {
                    try {
                        const authH = { ...BASE_HEADERS, Authorization: `Bearer ${session.walletToken}` };
                        rawPrepare = (await ax.post(`${BACKEND}${ep}`, {
                            contract_id: contractId, party_id: session.partyId
                        }, { headers: authH })).data;
                        break;
                    } catch (e) {
                        if (e.response?.status !== 404) continue;
                    }
                }

                if (rawPrepare) {
                    const pTx = rawPrepare.prepared_tx_b64 || rawPrepare.preparedTxB64;
                    const pH = rawPrepare.hash_b64 || rawPrepare.hashB64;
                    if (pTx && pH) {
                        const signature = signMessage(session.keyPair.privateKey, Buffer.from(pH, 'base64'));
                        await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
                            commandId: rawPrepare.command_id || rawPrepare.commandId,
                            preparedTxB64: pTx,
                            signatureB64: toBase64(signature),
                            hashingSchemeVersion: rawPrepare.hashing_scheme_version || rawPrepare.hashingSchemeVersion || 'HASHING_SCHEME_VERSION_V2',
                        }), 'wallet', walletApi, swapApi, log);
                        log(`✅ Accept ${amount} ${instrumentId}`);
                    }
                }
            }
        } catch (err) {
            log(`❌ Offer: ${formatError(err)}`);
        }
    }
}

// ── Execute Single Swap ──────────────────────────────────────────────────

async function executeSwap(ctx, { fromChain, fromAsset, toChain, toAsset, amount, fromLabel, toLabel, instrumentAdminId }, opts = {}) {
    const { session, walletApi, swapApi, log } = ctx;
    const { pollTimeoutMinutes } = opts;

    try {
        log(`📋 Quote ${parseFloat(amount).toFixed(2)} ${fromLabel}→${toLabel}...`);
        const quote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
        log(`💱 ${parseFloat(quote.sendAmount).toFixed(2)}→${parseFloat(quote.receiveAmount).toFixed(4)} @${parseFloat(quote.rate).toFixed(4)}`);

        let orderId = generateOrderId();
        log(`📝 Order ${shortId(orderId)}`);
        let order;

        const refreshQuote = async () => {
            const newQuote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
            Object.assign(quote, newQuote);
            return newQuote;
        };

        const createOrderWithRateLimitRefresh = async () => {
            return await session.withRetry(
                () => swapApi.createOrder(session.swapToken, orderId, quote.quoteId, session.partyId),
                'swap',
                walletApi,
                swapApi,
                log,
                {
                    throwOn429: opts.throwOn429 || false,
                    onRateLimitRetry: async ({ attempt, delay }) => {
                        await session.ensureFreshTokens(walletApi, swapApi, log);
                        await refreshQuote();
                        orderId = generateOrderId();
                        log(`♻️ Rate limit ${delay}s → fresh quote + order ${shortId(orderId)} (#${attempt})`);
                    }
                }
            );
        };

        try {
            order = await createOrderWithRateLimitRefresh();
        } catch (createErr) {
            const errStatus = createErr.response?.status;
            const errDetail = String(createErr.response?.data?.detail || '');
            const errDetailLc = errDetail.toLowerCase();

            // Smart Swap fast-fail: jangan blokir di setup-wait / generic-422 retry.
            // Lempar balik biar caller (runSmartSwap) bisa cooldown pendek + switch pair.
            if (opts.fastSetupFail && errStatus === 422) throw createErr;

            // Handle 422 "Account setup not complete"
            // Penyebab paling umum: ada active order tertinggal dari sesi sebelumnya
            // (AWAITING_DEPOSIT) yang membuat server tolak order baru.
            // Strategi: cek & cancel active order dulu (seperti web manual), lalu retry.
            if (errStatus === 422 && errDetailLc.includes('account setup not complete')) {
                log(`⚠️ [422] Account setup not complete → cek active order dulu`);
                let activeFound = null;
                try {
                    const active = await swapApi.getActiveOrder(session.swapToken, {});
                    const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
                    if (active?.orderId && !TERMINAL.includes(active.status)) {
                        activeFound = active;
                    }
                } catch { /* 404 = no active order, fine */ }

                if (activeFound) {
                    log(`🚫 Active order ${shortId(activeFound.orderId)} (${activeFound.status}) → cancel`);
                    try {
                        await swapApi.cancelOrder(session.swapToken, activeFound.orderId);
                        log(`✅ Cancelled ${shortId(activeFound.orderId)}`);
                    } catch (cancelErr) {
                        log(`⚠️ Cancel gagal: ${formatError(cancelErr)}, poll status`);
                        const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
                        for (let p = 0; p < 30; p++) {
                            await sleep(5);
                            try {
                                const check = await swapApi.getOrderStatus(session.swapToken, activeFound.orderId);
                                if (TERMINAL.includes(check.status)) break;
                            } catch { break; }
                        }
                    }
                    await sleep(2);
                    await acceptPendingOffers(ctx);
                    await refreshQuote();
                    orderId = generateOrderId();
                    order = await createOrderWithRateLimitRefresh();
                    log(`✅ Order ${shortId(orderId)} (setelah cancel active)`);
                } else {
                    // Tidak ada active order → benar-benar setup pending → tunggu
                    const setupOk = await waitForAccountSetup(swapApi, session.swapToken, session.partyId, log);
                    if (!setupOk) throw new Error('Account setup timed out');
                    await refreshQuote();
                    orderId = generateOrderId();
                    order = await createOrderWithRateLimitRefresh();
                }
            }
            // Handle 410 quote expired
            else if (errStatus === 410 && errDetailLc.includes('quote') && errDetailLc.includes('expired')) {
                log('♻️ Quote expired, requesting fresh quote...');
                await session.ensureFreshTokens(walletApi, swapApi, log);
                await refreshQuote();
                orderId = generateOrderId();
                log(`📝 Order ${shortId(orderId)} (quote refresh)`);
                order = await createOrderWithRateLimitRefresh();
            }
            // Handle 409 conflict (active order exists)
            else if (errStatus === 409) {
                const errData = createErr.response?.data;
                let staleId = errData?.message?.match(/ord_\w+/)?.[0]
                    || JSON.stringify(errData).match(/ord_\w+/)?.[0]
                    || null;
                if (!staleId) {
                    try {
                        const active = await swapApi.getActiveOrder(session.swapToken, {});
                        staleId = active?.orderId;
                    } catch { /* ignore */ }
                }
                if (!staleId) throw createErr;

                log(`⚠️ Active order ${shortId(staleId)}, resolving...`);

                let cancelled = false;
                try {
                    await swapApi.cancelOrder(session.swapToken, staleId);
                    cancelled = true;
                    log(`🚫 Cancelled ${shortId(staleId)}`);
                } catch { /* wait */ }

                if (!cancelled) {
                    const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
                    let pollN = 0;
                    while (true) {
                        await sleep(10);
                        pollN++;
                        if (pollN % 6 === 0) await session.ensureFreshTokens(walletApi, swapApi, log);
                        try {
                            const check = await swapApi.getOrderStatus(session.swapToken, staleId);
                            log(`🔄 ${shortId(staleId)} → ${check.status}`);
                            if (TERMINAL.includes(check.status)) break;
                        } catch (pollErr) {
                            if (pollErr.response?.status === 401) {
                                await session.refreshSwapToken(swapApi, log);
                                continue;
                            }
                            break;
                        }
                    }
                }

                await acceptPendingOffers(ctx);
                await sleep(2);
                await refreshQuote();
                order = await createOrderWithRateLimitRefresh();
            }
            // Handle generic 422 (not setup-related) → escalating retry with fresh quote + orderId
            // Max 3 retries, then soft restart
            else if (errStatus === 422) {
                const errMsg = createErr.response?.data?.detail || createErr.response?.data?.message || 'Unknown';
                log(`⚠️ [422] ${errMsg}`);
                const rejectedDelays = config.retry?.server_rejected_delays || [1, 1, 1];
                const max422Retries = config.retry?.max_422_retries ?? 3; // soft restart after this many
                for (let rejAttempt = 0; rejAttempt < max422Retries; rejAttempt++) {
                    const delay = getEscalatingDelay(rejAttempt, rejectedDelays);
                    log(`⏳ [422] wait ${delay}s (#${rejAttempt + 1}/${max422Retries})`);
                    await sleep(delay);
                    try {
                        await session.ensureFreshTokens(walletApi, swapApi, log);
                        await refreshQuote();
                        orderId = generateOrderId(); // update for rest of flow
                        order = await createOrderWithRateLimitRefresh();
                        log(`✅ Order ${shortId(orderId)} (retry)`);
                        break; // success
                    } catch (retryErr) {
                        if (retryErr.response?.status === 422) {
                            const retryMsg = retryErr.response?.data?.detail || retryErr.response?.data?.message || retryErr.response?.data || 'Unknown';
                            log(`⚠️ [422] ${typeof retryMsg === 'object' ? JSON.stringify(retryMsg) : retryMsg}`);
                            if (String(retryMsg).includes('Account setup not complete')) {
                                await waitForAccountSetup(swapApi, session.swapToken, session.partyId, log);
                            }
                            // Check if we've exhausted retries
                            if (rejAttempt >= max422Retries - 1) {
                                log(`🔄 [422] ${max422Retries}x failed → soft restart`);
                                const softRestartErr = new Error('422_SOFT_RESTART');
                                softRestartErr.response = { status: 500 }; // fake 500 to trigger soft restart
                                throw softRestartErr;
                            }
                            continue; // keep retrying
                        }
                        throw retryErr;
                    }
                }
                // If loop finished without order being set, trigger soft restart
                if (!order) {
                    log(`🔄 [422] exhausted retries → soft restart`);
                    const softRestartErr = new Error('422_SOFT_RESTART');
                    softRestartErr.response = { status: 500 };
                    throw softRestartErr;
                }
            } else {
                throw createErr;
            }
        }

        log(`✅ Order ${shortId(orderId)} created`);

        // ── DvP settlement (swap/offer/prepare) ──────────────────────────
        // Server tolak /transfer/prepare untuk swap dgn 418 ("switch to the DvP flow").
        // Delivery-versus-Payment: kirim leg keluar (instrument_out yg kita jual) +
        // leg masuk (instrument_in yg kita terima) sekaligus → settle atomic.
        const outMeta = INSTRUMENT_META[fromAsset] || {};
        const inMeta = INSTRUMENT_META[toAsset] || {};
        const outId = ASSET_TO_INSTRUMENT[fromAsset] || fromAsset;
        const inId = ASSET_TO_INSTRUMENT[toAsset] || toAsset;
        const outAdmin = instrumentAdminId || outMeta.admin || '';
        log(`📦 DvP ${order.requiredAmount} ${outId} → ${quote.receiveAmount} ${inId}`);

        const swapOffer = {
            swap_id: orderId,
            acceptor_party_id: order.deposit.address,
            instrument_out: { admin: outAdmin, id: outId },
            amount_out: String(order.requiredAmount),
            instrument_in: { admin: inMeta.admin || '', id: inId },
            amount_in: String(quote.receiveAmount),
            // Deadline user bersedia menunggu settle. Web pakai ~6 jam; deposit sendiri
            // biasanya settle dalam detik. Generous window supaya tidak keburu expire.
            settle_before: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        };

        let rawPrepare = null;
        for (let retry = 0; retry < 3; retry++) {
            try {
                rawPrepare = await session.withRetry(
                    () => walletApi.prepareSwapOffer(session.walletToken, swapOffer),
                    'wallet', walletApi, swapApi, log
                );
                break;
            } catch (prepErr) {
                const msg = prepErr.response?.data?.detail || prepErr.response?.data?.message || prepErr.message;
                const msgStr = typeof msg === 'object' ? JSON.stringify(msg) : String(msg);
                if (msgStr.includes('No holdings') && retry < 2) {
                    await sleep(15);
                    continue;
                }
                throw prepErr;
            }
        }

        const commandId = rawPrepare.command_id || rawPrepare.commandId;
        const preparedTxB64 = rawPrepare.prepared_tx_b64 || rawPrepare.preparedTxB64;
        const hashingSchemeVersion = rawPrepare.hashing_scheme_version || rawPrepare.hashingSchemeVersion || 'HASHING_SCHEME_VERSION_V2';
        const hashB64 = rawPrepare.hash_b64 || rawPrepare.hashB64;

        if (!preparedTxB64 || !hashB64) {
            log('❌ Missing prepared_tx_b64 or hash_b64');
            return false;
        }

        log('✍️ Signing & executing DvP settle...');
        const signature = signMessage(session.keyPair.privateKey, Buffer.from(hashB64, 'base64'));
        await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
            commandId, preparedTxB64,
            signatureB64: toBase64(signature),
            hashingSchemeVersion,
        }), 'wallet', walletApi, swapApi, log);

        // DvP = atomic; sumber kebenaran adalah order status (spt web: poll /orders).
        log('📊 Polling order status...');

        await sleep(3);
        const finalStatus = await pollOrderStatus(ctx, orderId, pollTimeoutMinutes, toAsset);

        if (finalStatus === 'COMPLETED' || finalStatus === 'WALLET_CONFIRMED') {
            log('🎉 Swap completed!');
            if (finalStatus === 'WALLET_CONFIRMED') {
                for (let cooldown = 0; cooldown < 6; cooldown++) {
                    await sleep(5);
                    try {
                        const { status } = await swapApi.getOrderStatus(session.swapToken, orderId);
                        const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
                        if (TERMINAL.includes(status)) break;
                    } catch { break; }
                }
            }
            await acceptPendingOffers(ctx);
            return { receiveAmount: quote.receiveAmount };
        } else if (finalStatus === 'TIMEOUT') {
            log(`⚠️ Timeout ${pollTimeoutMinutes}m`);
            try { await swapApi.cancelOrder(session.swapToken, orderId); } catch { /* ignore */ }
            return false;
        } else {
            log(`❌ Swap: ${finalStatus}`);
            return false;
        }

    } catch (err) {
        const errMsg = formatError(err);
        log(`❌ ${errMsg}`);
        // Return error info for caller to handle
        return { error: true, code: err.response?.status || err.code, message: err.response?.data?.detail || err.response?.data?.message || err.message };
    }
}

// ── Poll Order Status ────────────────────────────────────────────────────

async function pollOrderStatus(ctx, orderId, maxMinutes = 0, toAsset = null) {
    const { session, walletApi, swapApi, log } = ctx;
    const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
    let lastStatus = '';
    let pollCount = 0;
    let stuckSince = 0;
    const ICONS = { COMPLETED: '✅', FAILED: '❌', CANCELLED: '🚫', FUNDED: '💰', EXECUTING: '⚙️', PROCESSING: '🔄', WITHDRAWING: '📤', AWAITING_DEPOSIT: '⏳' };
    const maxPolls = maxMinutes > 0 ? Math.ceil(maxMinutes * 60 / 5) : Infinity;

    let preSwapBalance = null;
    if (toAsset) {
        try {
            const { holdings = {} } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            const assetNames = toAsset === '0x0' ? ['Amulet', 'CC (Amulet)', 'CC'] : ['USDCx', 'USDCX'];
            for (const n of assetNames) {
                if (holdings[n]?.balance != null) { preSwapBalance = holdings[n].balance; break; }
            }
            preSwapBalance = preSwapBalance || 0;
        } catch { preSwapBalance = 0; }
    }

    async function walletSideCheck() {
        if (!toAsset) return false;
        try {
            // Coba V2 dulu (offer modern), fallback V1
            let offerResult = null;
            try {
                offerResult = await session.withRetry(
                    () => walletApi.getOffersV2(session.walletToken), 'wallet', walletApi, swapApi, log
                );
            } catch { /* ignore */ }
            if (!offerResult || !(offerResult.offers?.length)) {
                try {
                    offerResult = await session.withRetry(
                        () => walletApi.getOffers(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                } catch { /* ignore */ }
            }
            if ((offerResult?.offers?.length || 0) > 0) {
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                return true;
            }

            const { holdings = {} } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            const assetNames = toAsset === '0x0' ? ['Amulet', 'CC (Amulet)', 'CC'] : ['USDCx', 'USDCX'];
            let currentBalance = 0;
            for (const n of assetNames) {
                if (holdings[n]?.balance != null) { currentBalance = holdings[n].balance; break; }
            }
            if (preSwapBalance != null && currentBalance > preSwapBalance + 0.01) return true;

            try {
                const historyData = await session.withRetry(
                    () => walletApi.getHistory(session.walletToken), 'wallet', walletApi, swapApi, log
                );
                const transfers = historyData.transfers || historyData.history || historyData || [];
                if (Array.isArray(transfers) && transfers.length > 0) {
                    const recent = transfers[0];
                    const isIncoming = recent.direction === 'INCOMING' || recent.type === 'RECEIVE'
                        || recent.receiver_party_id === session.partyId
                        || recent.receiverPartyId === session.partyId;
                    if (isIncoming) {
                        const transferAge = Date.now() - new Date(recent.created_at || recent.createdAt || recent.timestamp || 0).getTime();
                        if (transferAge < 5 * 60 * 1000) return true;
                    }
                }
            } catch { /* not critical */ }
        } catch { /* ignore */ }
        return false;
    }

    let consecutiveNetErrors = 0;
    const MAX_CONSECUTIVE_NET_ERRORS = 10;

    while (pollCount < maxPolls) {
        try {
            const { status } = await retryOnNetwork(
                () => swapApi.getOrderStatus(session.swapToken, orderId),
                { maxRetries: 3, baseDelay: 3, label: 'pollStatus', log }
            );
            consecutiveNetErrors = 0; // reset on success

            if (status !== lastStatus) {
                const icon = ICONS[status] || '⏳';
                log(`${icon} Status: ${status} (${pollCount * 5}s)`);
                lastStatus = status;
                stuckSince = pollCount;
            }

            if (status === 'CANCELLED' || status === 'FAILED') {
                if (await walletSideCheck()) return 'WALLET_CONFIRMED';
                return status;
            }
            if (TERMINAL.includes(status)) return status;

            const stuckDuration = pollCount - stuckSince;
            if (toAsset && stuckDuration >= 3 && stuckDuration % 2 === 0) {
                if (await walletSideCheck()) return 'WALLET_CONFIRMED';
            }
        } catch (err) {
            if (err.response?.status === 401) {
                await session.refreshSwapToken(swapApi, log);
                continue;
            }
            // Network error that survived retryOnNetwork retries
            consecutiveNetErrors++;
            const errDetail = formatError(err);
            log(`⚠️ Poll error (${consecutiveNetErrors}/${MAX_CONSECUTIVE_NET_ERRORS}): ${errDetail}`);

            // Check wallet early if we're getting repeated errors
            if (consecutiveNetErrors >= 3 && consecutiveNetErrors % 2 === 1) {
                if (await walletSideCheck()) {
                    log(`✅ Wallet confirmed despite poll errors`);
                    return 'WALLET_CONFIRMED';
                }
            }

            if (consecutiveNetErrors >= MAX_CONSECUTIVE_NET_ERRORS) {
                log(`❌ Too many poll errors, final wallet check...`);
                if (await walletSideCheck()) return 'WALLET_CONFIRMED';
                throw err; // propagate to trigger runAccount restart
            }
            await sleep(10); // extra wait on network error
        }
        pollCount++;
        await sleep(5);
    }

    return 'TIMEOUT';
}

// ── Proxy IP Logger (runs at startup) ───────────────────────────────────

async function fetchAndLogProxyIps(accounts) {
    const proxied = accounts.filter(a => a.proxy);
    if (!proxied.length) return;

    console.log(chalk.gray('  🌐 Fetching proxy IPs...'));
    const IP_ENDPOINTS = [
        { url: 'https://api.ipify.org?format=json', extract: r => r.data?.ip },
        { url: 'https://api4.my-ip.io/ip.json', extract: r => r.data?.ip },
        { url: 'https://ipinfo.io/json', extract: r => r.data?.ip },
        { url: 'https://api.ipify.org', extract: r => String(r.data).trim() },
    ];

    async function getIp(proxyUrl) {
        const agentOpts = { keepAlive: true, timeout: 20000 };
        const httpsAgent = new HttpsProxyAgent(proxyUrl, agentOpts);
        const httpAgent = new HttpProxyAgent(proxyUrl, agentOpts);
        const ax = axios.create({ httpAgent, httpsAgent, proxy: false, timeout: 20000 });
        for (const ep of IP_ENDPOINTS) {
            try {
                const r = await ax.get(ep.url);
                const ip = ep.extract(r);
                if (ip && ip.includes('.')) return ip;
            } catch { /* try next */ }
        }
        return 'FAILED';
    }

    const lines = [];
    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        if (acc.proxy) {
            const ip = await getIp(acc.proxy);
            lines.push(ip);
            console.log(chalk.gray(`    ${acc.name}: ${chalk.cyan(ip)}`));
        } else {
            lines.push('no-proxy');
            console.log(chalk.gray(`    ${acc.name}: no proxy`));
        }
    }

    // Write to proxy_ips.txt (overwrite each run)
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const header = `# Run: ${timestamp}\n`;
    writeFileSync(new URL('./proxy_ips.txt', import.meta.url), header + lines.join('\n') + '\n', 'utf-8');
    console.log(chalk.gray(`  ✅ Proxy IPs saved to proxy_ips.txt\n`));
}

// ── Telegram Notification (summary TOT setiap N menit) ───────────────────

async function sendTelegramSummary() {
    const tg = config.telegram;
    if (!tg?.enabled || !tg.bot_token || !tg.chat_id) return;

    // Hitung total dari semua akun (sama dengan baris TOT di dashboard)
    let totCC = 0, totUSDCx = 0, totCETH = 0, totReward = 0, totDelta = 0, totSwaps = 0;
    let activeCount = 0;
    for (const a of dashboard.accounts) {
        totCC += a.cc || 0;
        totUSDCx += a.usdcx || 0;
        totCETH += a.ceth || 0;
        totReward += a.monthReward || 0;
        totDelta += a.diffReward || 0;
        totSwaps += a.totalSwaps || 0;
        if (a.status && a.status !== 'init' && a.status !== 'done') activeCount++;
    }

    const totDeltaStr = totDelta >= 0 ? `+${totDelta.toFixed(2)}` : totDelta.toFixed(2);
    const now = new Date().toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    });

    const msg =
        `📊 *Cantor8 Bot Summary*\n` +
        `🕒 ${now} WIB\n\n` +
        `👥 Akun: ${dashboard.accounts.length} (aktif: ${activeCount})\n` +
        `💰 CC: ${totCC.toFixed(2)}\n` +
        `💵 USDCx: ${totUSDCx.toFixed(4)}\n` +
        `🪙 cETH: ${totCETH.toFixed(6)}\n` +
        `🔁 Total Swap: ${totSwaps}\n` +
        `🏆 Reward Bulan Ini: ${totReward.toFixed(2)} CC\n` +
        `📈 Δ Reward: ${totDeltaStr} CC`;

    try {
        const url = `https://api.telegram.org/bot${tg.bot_token}/sendMessage`;
        await axios.post(url, {
            chat_id: tg.chat_id,
            text: msg,
            parse_mode: 'Markdown',
        }, { timeout: 15000 });
    } catch (err) {
        // Log error ke dashboard akun pertama (kalau ada)
        if (dashboard.accounts.length > 0) {
            const errMsg = err.response?.data?.description || err.message;
            dashboard.log(0, `⚠️ Telegram notif gagal: ${String(errMsg).slice(0, 60)}`);
        }
    }
}

function startTelegramScheduler() {
    const tg = config.telegram;
    if (!tg?.enabled) return null;
    if (!tg.bot_token || !tg.chat_id) {
        console.log(chalk.yellow('⚠️ Telegram aktif tapi bot_token/chat_id kosong, skip'));
        return null;
    }
    const intervalMs = Math.max(1, tg.interval_minutes) * 60 * 1000;
    console.log(chalk.cyan(`  📱 Telegram notif aktif (tiap ${tg.interval_minutes}m)`));

    // Kirim summary pertama setelah delay singkat (biar dashboard sudah ada data)
    const initialDelayMs = 30 * 1000;
    setTimeout(() => sendTelegramSummary(), initialDelayMs);

    return setInterval(() => sendTelegramSummary(), intervalMs);
}

// ══════════════════════════════════════════════════════════════════════════
// ── BULK BACK CC (opsi 0) — port logic dari back.js ──────────────────────
// Swap semua USDCx + cETH balik ke CC untuk semua akun (parallel, one-shot).
// Reuse helper index.js: executeSwap, acceptPendingOffers, pollOrderStatus,
// getBalanceFor, getInstrumentAdminId, createSession, waitForAccountSetup.
// ══════════════════════════════════════════════════════════════════════════

const BULK_PAIR_A = { chain: 'CC', asset: '0x0', label: 'CC' };
const BULK_PAIR_B = { chain: 'CC', asset: 'USDCX', label: 'USDCx' };
const BULK_PAIR_C = { chain: 'CC', asset: 'CETH', label: 'cETH' };

const BULK_MIN_USDCX_TO_SWAP = 0.0001;
const BULK_MIN_CETH_TO_SWAP = 0.000001;
const BULK_POLL_TIMEOUT_MIN = 10;
// Saldo nyangkut wait: poll interval (detik). Akun dianggap DONE cuma kalau
// history sudah punya swap→CC (run ini), ATAU CC > threshold.
const BULK_STUCK_POLL_SEC = userCfg.stuck?.poll_interval_sec ?? 20;
// CC > angka ini → akun langsung dianggap DONE (gak perlu nunggu history swap→CC).
const BULK_CC_DONE_THRESHOLD = userCfg.cc_done_minimal ?? 20;

// Auth flow untuk bulk-back (mirror runAccountOnce step 1-3b), return session.
async function bulkAuthenticate(walletApi, swapApi, keyPairs, log) {
    const session = createSession();
    session.keyPairs = keyPairs;

    log('🔍 Recovering...');
    const recovery = await retryOnNetwork(
        () => walletApi.recoverAccount(keyPairs.map(k => k.publicKeyHex)),
        { maxRetries: 5, baseDelay: 3, label: 'recover', log }
    );
    const matchIdx = (recovery.results || []).findIndex(r => r !== null);
    if (matchIdx === -1) throw new Error('No account for this mnemonic');
    const acct = recovery.results[matchIdx];
    session.partyId = acct.party_id;
    session.matchIdx = matchIdx;
    session.keyPair = keyPairs[matchIdx];
    log(`🆔 Party: ${shortId(acct.party_id)}`);

    // Wallet login (challenge re-fetched each attempt, cap di non-retryable)
    let challengeRetries = 0;
    for (let loginAttempt = 1; ; loginAttempt++) {
        try {
            const { challenge } = await walletApi.getChallenge(acct.party_id);
            const sig = toHex(signMessage(keyPairs[matchIdx].privateKey, challenge));
            const { access_token } = await walletApi.login(acct.party_id, challenge, sig);
            session.walletToken = access_token;
            session.walletLoginTime = Date.now();
            break;
        } catch (err) {
            const is400Challenge = err.response?.status === 400 &&
                String(err.response?.data?.detail || err.response?.data?.message || JSON.stringify(err.response?.data || ''))
                    .toLowerCase().includes('challenge');
            if (is400Challenge) {
                if (++challengeRetries > 10) throw err;
                log(`🔄 [login] Challenge expired, retrying... (${loginAttempt})`);
                continue;
            }
            if (!isRetryableError(err) || loginAttempt >= 5) throw err;
            const delay = Math.min(3 * Math.pow(2, loginAttempt - 1), 30);
            log(`🔄 [login] ${formatError(err)} (attempt ${loginAttempt}, wait ${delay}s)`);
            await sleep(delay);
        }
    }
    log('✅ Authenticated');

    // Post-login registration checks (non-critical)
    try {
        const regStatus = await walletApi.getRegisterStatus(session.walletToken);
        log(`📋 Registration: ${regStatus.is_registered ? '✅' : '⏳'}`);
        await walletApi.getOutgoingExpired(session.walletToken);
    } catch { /* non-critical */ }

    // Swap login
    await retryOnNetwork(async () => {
        const { nonce } = await swapApi.getNonce();
        const swapAuth = await swapApi.bindSignature(nonce, acct.party_id);
        session.swapToken = swapAuth.accessToken;
        session.swapLoginTime = Date.now();
    }, { maxRetries: Infinity, baseDelay: 3, label: 'swapLogin', log });

    return session;
}

// Refresh saldo (holdings) sederhana untuk bulk-back.
async function bulkRefreshBalance(ctx) {
    const { session, walletApi, swapApi, log } = ctx;
    const { holdings = {} } = await session.withRetry(
        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
    );
    return holdings;
}

// History DONE gate: cek /history ada entry CC masuk (swap/receive) sejak run mulai.
const BULK_CC_HISTORY_NAMES = ['amulet', 'cc', 'cc (amulet)', '0x0'];
async function bulkHasSwapToCcHistory(ctx, sinceMs) {
    const { session, ax } = ctx;
    try {
        const authH = { ...WALLET_HEADERS, Authorization: `Bearer ${session.walletToken}` };
        const hist = (await ax.get(`${BACKEND}/history`, { headers: authH })).data;
        const entries = hist?.history || hist?.transactions || hist?.items || hist?.events
            || (Array.isArray(hist) ? hist : []);
        for (const e of entries) {
            const asset = String(
                e.instrument_id ?? e.instrumentId ?? e.asset ?? e.instrument
                ?? e.to_asset ?? e.toAsset ?? e.received_asset ?? ''
            ).toLowerCase();
            const type = String(
                e.type ?? e.kind ?? e.direction ?? e.category ?? e.event_type ?? ''
            ).toLowerCase();
            const isCC = BULK_CC_HISTORY_NAMES.includes(asset);
            const isIncoming = type.includes('swap') || type.includes('receive')
                || type.includes('credit') || type.includes('incoming') || type.includes('deposit');
            const tsRaw = Number(e.timestamp ?? e.created_at ?? e.createdAt ?? e.time ?? e.ts ?? 0);
            const tsMs = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
            const recent = !sinceMs || !tsRaw || tsMs >= sinceMs;
            if (isCC && isIncoming && recent) return true;
        }
    } catch { /* ignore — treat as belum ada */ }
    return false;
}

// Tunggu saldo nyangkut (INFINITE). Exit kalau saldo nongol ≥ MIN, ATAU CC >
// threshold, ATAU history swap→CC sudah muncul.
async function bulkWaitForStuckBalance(ctx, index, runStart, log) {
    const { session, walletApi, swapApi } = ctx;
    const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];

    for (let pollN = 1; ; pollN++) {
        await session.ensureFreshTokens(walletApi, swapApi, log);

        if (await bulkHasSwapToCcHistory(ctx, runStart)) {
            log('✅ History swap→CC muncul saat nunggu');
            return await bulkRefreshBalance(ctx);
        }

        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }

        let inFlight = false;
        try {
            const active = await swapApi.getActiveOrder(session.swapToken, {});
            if (active?.orderId && !TERMINAL.includes(active.status)) {
                inFlight = true;
                log(`⏳ In-flight ${shortId(active.orderId)} (${active.status})`);
            }
        } catch { /* no active */ }

        const holdings = await bulkRefreshBalance(ctx);
        const usdcx = getBalanceFor(holdings, BULK_PAIR_B.asset);
        const ceth = getBalanceFor(holdings, BULK_PAIR_C.asset);
        const cc = getBalanceFor(holdings, BULK_PAIR_A.asset);
        dashboard.update(index, { cc, usdcx, ceth });

        if (cc > BULK_CC_DONE_THRESHOLD) {
            log(`✅ CC ${cc.toFixed(2)} > ${BULK_CC_DONE_THRESHOLD} — saldo balik`);
            return holdings;
        }
        if (usdcx >= BULK_MIN_USDCX_TO_SWAP || ceth >= BULK_MIN_CETH_TO_SWAP) {
            log(`✅ Saldo settle USDCx:${usdcx.toFixed(4)} cETH:${ceth.toFixed(6)}`);
            return holdings;
        }

        let pendingOffers = 0, outExpired = 0;
        try {
            const res = await session.withRetry(
                () => walletApi.getOffers(session.walletToken), 'wallet', walletApi, swapApi, log);
            pendingOffers = res.offers?.length || 0;
        } catch { /* ignore */ }
        try {
            const exp = await session.withRetry(
                () => walletApi.getOutgoingExpired(session.walletToken), 'wallet', walletApi, swapApi, log);
            outExpired = (exp?.offers?.length ?? exp?.length ?? 0) || 0;
        } catch { /* ignore */ }

        log(`⏳ Nyangkut #${pollN} (offer:${pendingOffers} expired:${outExpired} inflight:${inFlight}) — nunggu ${BULK_STUCK_POLL_SEC}s`);
        await sleep(BULK_STUCK_POLL_SEC);
    }
}

// Per-account bulk-back business logic (port back.js bulkBackAccount).
async function bulkBackAccount(accConfig, index, name, log) {
    const setStatus = (status) => dashboard.update(index, { status });

    const ax = createAxiosInstance(accConfig.proxy || '');
    const walletApi = createWalletApi(ax);
    const swapApi = createSwapApi(ax);

    if (accConfig.proxy) {
        log(`Proxy: ${accConfig.proxy.replace(/\/\/.*@/, '//***@')}`);
        const proxyHost = (accConfig.proxy.match(/@([^:/]+)/) || [])[1]
            || accConfig.proxy.split('@').pop().split(':')[0] || 'proxy';
        dashboard.update(index, { proxyHost });
    }

    // Step 1: Derive keys
    setStatus('deriving');
    log('🔑 Deriving key pairs...');
    const keyPairs = generateKeyPairs(accConfig.mnemonic);

    // Step 2: Authenticate
    setStatus('login');
    const session = await bulkAuthenticate(walletApi, swapApi, keyPairs, log);
    session.name = name;
    session.api = walletApi;
    session.swapApi = swapApi;
    globalSessions.set(name, session);

    const ctx = { session, walletApi, swapApi, log, name, index, ax };

    // Background refresh balance tiap 5 menit (300s) — update dashboard biar data
    // tetap kebaca walau akun lagi nunggu lama (stuck-wait / antri proxy).
    const BG_REFRESH_SEC = 300;
    const bgTimer = setInterval(async () => {
        try {
            await session.ensureFreshTokens(walletApi, swapApi, log);
            const h = await bulkRefreshBalance(ctx);
            dashboard.update(index, {
                cc: getBalanceFor(h, BULK_PAIR_A.asset),
                usdcx: getBalanceFor(h, BULK_PAIR_B.asset),
                ceth: getBalanceFor(h, BULK_PAIR_C.asset),
                ...(await fetchLockDetail(walletApi, session, h, index)),
            });
        } catch { /* silent — refresh berikutnya coba lagi */ }
    }, BG_REFRESH_SEC * 1000);

    try {
    // Step 3: Resolve unfinished orders
    setStatus('clear');
    log('🔍 Checking unfinished orders...');
    try {
        const activeOrder = await swapApi.getActiveOrder(session.swapToken, {});
        if (activeOrder?.orderId) {
            const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
            if (!TERMINAL.includes(activeOrder.status)) {
                if (activeOrder.status === 'AWAITING_DEPOSIT') {
                    log(`🚫 Stale ${shortId(activeOrder.orderId)} (AWAITING_DEPOSIT) → cancel`);
                    try { await swapApi.cancelOrder(session.swapToken, activeOrder.orderId); } catch { /* ignore */ }
                } else {
                    log(`🔄 Resume ${shortId(activeOrder.orderId)} (${activeOrder.status})`);
                    setStatus('resume');
                    let lastStatus = activeOrder.status;
                    while (true) {
                        await sleep(5);
                        try {
                            const check = await swapApi.getOrderStatus(session.swapToken, activeOrder.orderId);
                            if (check.status !== lastStatus) { log(`⏳ ${lastStatus} → ${check.status}`); lastStatus = check.status; }
                            if (TERMINAL.includes(check.status)) break;
                        } catch { break; }
                    }
                }
            }
        } else {
            log('✅ No unfinished orders');
        }
    } catch { log('✅ No active orders'); }

    // Step 4: Accept pending offers
    log('📩 Checking pending offers...');
    await acceptPendingOffers(ctx);

    // Step 5: Scan balances
    setStatus('scan');
    const runStart = Date.now();
    let holdings = await bulkRefreshBalance(ctx);
    let ccBal = getBalanceFor(holdings, BULK_PAIR_A.asset);
    let usdcxBal = getBalanceFor(holdings, BULK_PAIR_B.asset);
    let cethBal = getBalanceFor(holdings, BULK_PAIR_C.asset);

    dashboard.update(index, { cc: ccBal, usdcx: usdcxBal, ceth: cethBal, initialCC: ccBal, ...(await fetchLockDetail(walletApi, session, holdings, index)) });
    log(`💰 CC:${ccBal.toFixed(2)} USDCx:${usdcxBal.toFixed(4)} cETH:${cethBal.toFixed(6)}`);

    // Step 6: doLeg helper — retry + balance verification
    const MAX_SWAP_RETRIES = Infinity;
    // Jeda retry patuhi rate_limit config.json (rate_limit.tunggu_lanjutan_detik
    // → config.retry.rate_limit_delays). Pakai delay pertama; fallback 10s.
    const SWAP_RETRY_DELAY = (config.retry?.rate_limit_delays?.[0]) ?? 10;

    const doLeg = async (fromPair, toPair, amount, label) => {
        log(`═══ ${label} (${parseFloat(amount).toFixed(toPair.asset === 'CETH' ? 6 : 4)} ${fromPair.label})`);

        holdings = await bulkRefreshBalance(ctx);
        const preBal = getBalanceFor(holdings, toPair.asset);
        const preFromBal = getBalanceFor(holdings, fromPair.asset);

        for (let swapAttempt = 1; swapAttempt <= MAX_SWAP_RETRIES; swapAttempt++) {
            await session.ensureFreshTokens(walletApi, swapApi, log);
            holdings = await bulkRefreshBalance(ctx);
            const currentFromBal = getBalanceFor(holdings, fromPair.asset);

            if (swapAttempt > 1 && currentFromBal < preFromBal * 0.5) {
                const currentToBal = getBalanceFor(holdings, toPair.asset);
                if (currentToBal > preBal + 0.01) {
                    log(`✅ ${label}: swap sudah masuk (verified) +${(currentToBal - preBal).toFixed(4)} ${toPair.label}`);
                    return { receiveAmount: (currentToBal - preBal).toFixed(4) };
                }
            }

            const swapAmount = swapAttempt === 1 ? amount : currentFromBal;
            if (swapAmount < (fromPair.asset === 'CETH' ? BULK_MIN_CETH_TO_SWAP : BULK_MIN_USDCX_TO_SWAP)) {
                log(`⚠️ ${label}: balance sudah habis, skip retry`);
                return null;
            }

            const result = await executeSwap(ctx, {
                fromChain: fromPair.chain, fromAsset: fromPair.asset,
                toChain: toPair.chain, toAsset: toPair.asset,
                amount: swapAmount, fromLabel: fromPair.label, toLabel: toPair.label,
                instrumentAdminId: getInstrumentAdminId(holdings, fromPair.asset),
            }, { pollTimeoutMinutes: BULK_POLL_TIMEOUT_MIN });

            await sleep(3);
            holdings = await bulkRefreshBalance(ctx);
            const postBal = getBalanceFor(holdings, toPair.asset);
            ccBal = getBalanceFor(holdings, BULK_PAIR_A.asset);
            usdcxBal = getBalanceFor(holdings, BULK_PAIR_B.asset);
            cethBal = getBalanceFor(holdings, BULK_PAIR_C.asset);
            dashboard.update(index, { cc: ccBal, usdcx: usdcxBal, ceth: cethBal, ...(await fetchLockDetail(walletApi, session, holdings, index)) });

            if (result && !result.error) {
                log(`✅ ${label}: +${result.receiveAmount || (postBal - preBal).toFixed(4)} ${toPair.label}`);
                return result;
            }
            if (postBal > preBal + 0.01) {
                log(`✅ ${label}: swap berhasil (verified) +${(postBal - preBal).toFixed(4)} ${toPair.label}`);
                return { receiveAmount: (postBal - preBal).toFixed(4) };
            }

            if (swapAttempt < MAX_SWAP_RETRIES) {
                log(`🔄 ${label} gagal, retry ${SWAP_RETRY_DELAY}s (#${swapAttempt})`);
                await sleep(SWAP_RETRY_DELAY);
            } else {
                log(`❌ ${label} gagal setelah ${MAX_SWAP_RETRIES}x retry`);
            }
        }
        return null;
    };

    // Step 7: Bulk-back outer loop. DONE gate = CC > threshold ATAU history swap→CC.
    let swapsDone = 0;
    const failedLegs = [];

    const refreshBal = async () => {
        holdings = await bulkRefreshBalance(ctx);
        ccBal = getBalanceFor(holdings, BULK_PAIR_A.asset);
        usdcxBal = getBalanceFor(holdings, BULK_PAIR_B.asset);
        cethBal = getBalanceFor(holdings, BULK_PAIR_C.asset);
        dashboard.update(index, { cc: ccBal, usdcx: usdcxBal, ceth: cethBal, totalSwaps: swapsDone, ...(await fetchLockDetail(walletApi, session, holdings, index)) });
    };

    for (let round = 1; ; round++) {
        await refreshBal();

        // DONE gate: USDCx & cETH HARUS habis (≈0). CC tinggi gak bikin done —
        // tujuan bulk-back = drain semua non-CC balik ke CC.
        if (usdcxBal < BULK_MIN_USDCX_TO_SWAP && cethBal < BULK_MIN_CETH_TO_SWAP) {
            // Cek apakah masih ada saldo lagi balik (offer pending / order in-flight).
            let pending = false;
            try {
                const r = await session.withRetry(
                    () => walletApi.getOffers(session.walletToken), 'wallet', walletApi, swapApi, log);
                if ((r.offers?.length || 0) > 0) pending = true;
            } catch { /* ignore */ }
            if (!pending) {
                try {
                    const active = await swapApi.getActiveOrder(session.swapToken, {});
                    const TERM = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
                    if (active?.orderId && !TERM.includes(active.status)) pending = true;
                } catch { /* ignore */ }
            }
            if (pending) {
                setStatus('wait-bal');
                log(`⏳ Saldo lagi balik (offer/inflight) — nunggu (round ${round})...`);
                holdings = await bulkWaitForStuckBalance(ctx, index, runStart, log);
                await refreshBal();
                continue;
            }
            log(`✅ USDCx & cETH habis (U:${usdcxBal.toFixed(4)} E:${cethBal.toFixed(6)}) — DONE`);
            break;
        }

        // Snapshot saldo sebelum usaha swap → deteksi no-progress (dust < min exchange).
        const beforeU = usdcxBal, beforeE = cethBal;

        // cETH → CC
        if (cethBal >= BULK_MIN_CETH_TO_SWAP) {
            setStatus('E→C');
            const r = await doLeg(BULK_PAIR_C, BULK_PAIR_A, cethBal, 'cETH→CC');
            if (r) { swapsDone++; await refreshBal(); }
            else failedLegs.push('cETH→CC');
        }

        // USDCx → CC (langsung, gak lewat cETH)
        if (usdcxBal >= BULK_MIN_USDCX_TO_SWAP) {
            setStatus('U→C');
            const r = await doLeg(BULK_PAIR_B, BULK_PAIR_A, usdcxBal, 'USDCx→CC');
            if (r) { swapsDone++; await refreshBal(); }
            else failedLegs.push('USDCx→CC');
        }

        // Retry INFINITE sampai USDCx & cETH habis. Kalau saldo gak berkurang
        // setelah usaha swap (mis. rate-limit / dust), jeda lalu coba lagi —
        // GAK pernah give-up, loop balik terus.
        await refreshBal();
        const drainedU = beforeU - usdcxBal;
        const drainedE = beforeE - cethBal;
        if (drainedU < BULK_MIN_USDCX_TO_SWAP && drainedE < BULK_MIN_CETH_TO_SWAP) {
            log(`⚠️ Saldo gak berkurang (round ${round}) — retry ${SWAP_RETRY_DELAY}s`);
            await sleep(SWAP_RETRY_DELAY);
        }

        setStatus('verify');
    }

    log(`🏁 Done +${swapsDone} swap(s)`);
    dashboard.update(index, { status: 'done', done: true });
    return {
        name: accConfig.name, ok: true, skipped: false,
        initialCC: dashboard.accounts[index].initialCC,
        finalCC: ccBal, usdcxEnd: usdcxBal, cethEnd: cethBal,
        swapsDone, failedLegs,
    };
    } finally {
        clearInterval(bgTimer);
    }
}

// Per-account runner dengan soft-restart + proxy rotation (mirror runAccount).
async function runBulkBackAccount(accConfig, index) {
    const name = accConfig.name || `Acc ${index + 1}`;
    const log = (msg) => dashboard.log(index, msg);

    for (let accountAttempt = 1; ; accountAttempt++) {
        try {
            return await bulkBackAccount(accConfig, index, name, log);
        } catch (err) {
            if (accConfig.proxy && isProxyError(err)) {
                const oldProxy = accConfig.proxy;
                const newProxy = proxyPool.rotateFrom(oldProxy, index);
                accConfig.proxy = newProxy;
                const newHost = (newProxy.match(/@([^:/]+)/) || [])[1] || 'proxy';
                log(`🔀 Proxy gagal (${formatError(err)}) → rotate ke ${newHost}`);
                dashboard.update(index, { status: 'proxy-rotate', proxyHost: newHost });
                await sleep(3);
                accountAttempt = Math.max(1, accountAttempt - 1);
                continue;
            }
            if (err.response?.status >= 500 || err.code === 'ERR_BAD_RESPONSE' || err.message?.includes('ERR_BAD_RESPONSE')) {
                log(`🔄 [${err.response?.status || 'ERR_BAD_RESPONSE'}] soft restart 5s`);
                dashboard.update(index, { status: 'soft-restart' });
                await sleep(5);
                accountAttempt = Math.max(1, accountAttempt - 1);
                continue;
            }
            log(`❌ ${formatError(err)}`);
            const delay = Math.min(ACCOUNT_RETRY_BASE_DELAY * Math.pow(1.5, accountAttempt - 1), 120);
            log(`🔄 Restart ${Math.round(delay)}s (#${accountAttempt})`);
            dashboard.update(index, { status: `restart #${accountAttempt}` });
            await sleep(delay);
        }
    }
}

// Bulk-back run flow (dipanggil dari main saat opsi 0 dipilih).
async function runBulkBack(accounts) {
    dashboard.init(accounts);
    dashboard.startAutoRefresh();
    // Push data ke web dashboard kek biasa (balance/status/swaps tiap interval).
    const dashPushTimer = startDashboardPush();

    const startTime = Date.now();

    // Langsung start parallel, tanpa stagger
    const results = await Promise.allSettled(
        accounts.map((acc, i) => (async () => {
            try { return await runBulkBackAccount(acc, i); }
            catch (err) { return { name: acc.name, ok: false, error: formatError(err) }; }
        })())
    );

    dashboard._render();
    // Final push sebelum stop, lalu matikan timer push.
    await pushToDashboard();
    if (dashPushTimer) clearInterval(dashPushTimer);
    stopDashboardPush();
    dashboard.stop();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(chalk.cyan.bold(`\n${'═'.repeat(76)}`));
    console.log(chalk.cyan.bold(`  📊 SUMMARY BULK-BACK CC  (${elapsed}s)`));
    console.log(chalk.cyan.bold('═'.repeat(76)));

    let totalGained = 0, totalSwaps = 0, okCount = 0, failCount = 0, skipCount = 0;
    for (const settled of results) {
        const r = settled.status === 'fulfilled' ? settled.value : { ok: false, error: 'rejected' };
        if (!r) continue;
        if (!r.ok) { failCount++; console.log(chalk.red(`  ❌ ${r.name}: ${r.error}`)); continue; }
        if (r.skipped) { skipCount++; console.log(chalk.gray(`  ⏭️  ${r.name}: skip`)); continue; }
        okCount++;
        const gained = r.finalCC - r.initialCC;
        totalGained += gained; totalSwaps += r.swapsDone;
        const gainStr = gained >= 0 ? chalk.green(`+${gained.toFixed(4)}`) : chalk.red(gained.toFixed(4));
        console.log(`  ✅ ${r.name}: CC ${r.initialCC.toFixed(2)}→${r.finalCC.toFixed(2)} (${gainStr}) | ${r.swapsDone} swap`);
        if (r.failedLegs?.length) console.log(chalk.yellow(`     ⚠️ ${r.failedLegs.join(', ')}`));
    }
    console.log(chalk.cyan.bold('─'.repeat(76)));
    console.log(chalk.green.bold(`  TOTAL: +${totalGained.toFixed(4)} CC | ${totalSwaps} swap | ✅ ${okCount}  ⏭️  ${skipCount}  ❌ ${failCount}`));
    console.log(chalk.cyan.bold(`${'═'.repeat(76)}\n`));
}

// ── Main Entry Point ─────────────────────────────────────────────────────

// Global state untuk pola swap yang dipilih user
//   'A'   = a) Triangle    : CC→USDCx→cETH→CC (round-trip)
//   'CCU' = b) CC↔USDCx     : CC→USDCx→CC      (round-trip)
//   'UCE' = c) USDCx↔cETH   : USDCx→cETH→USDCx (round-trip)
//   'CCE' = d) CC↔cETH      : CC→cETH→CC       (round-trip)
//   'SMART' = e) Smart Swap : anti rate-limit, auto-switch pair
//   'AR'  = f) Reverse Tri  : CC→cETH→USDCx→CC (round-trip)
let SWAP_PATTERN = 'A';

// Tanya user pilih pola swap (1-6) via readline
function askPattern() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = () => {
            rl.question(chalk.cyan('  Pilih pola swap [0, 1, 2, 3, 4, 5, 6]: '), (answer) => {
                const a = String(answer || '').trim();
                const map = { '0': 'BULKBACK', '1': 'A', '2': 'CCU', '3': 'UCE', '4': 'CCE', '5': 'SMART', '6': 'AR' };
                if (map[a]) {
                    rl.close();
                    resolve(map[a]);
                } else {
                    console.log(chalk.yellow('  ↳ Masukkan 0, 1, 2, 3, 4, 5, atau 6.'));
                    ask();
                }
            });
        };
        ask();
    });
}

async function main() {
    const accounts = config.accounts || [];

    if (!accounts.length) {
        console.error(chalk.red('❌ No accounts configured in config.json'));
        process.exit(1);
    }

    process.stdout.write('\x1B[H\x1B[2J');
    console.log(chalk.cyan.bold(`  🤖 CANTOR8 MULTI-ACCOUNT BOT V2 — ${accounts.length} account(s)\n`));

    // ── Step 1: Pilih pola swap ──
    console.log(chalk.bold.cyan(`  Pola swap (round-trip, looping):`));
    console.log(chalk.yellow(`  0) BULK BACK CC: swap semua USDCx + cETH → CC (semua akun)`));
    console.log(chalk.gray(`  1) Triangle   : CC → USDCx → cETH → CC`));
    console.log(chalk.gray(`  2) CC ↔ USDCx : CC → USDCx → CC`));
    console.log(chalk.gray(`  3) USDCx ↔ cETH: USDCx → cETH → USDCx`));
    console.log(chalk.gray(`  4) CC ↔ cETH  : CC → cETH → CC`));
    console.log(chalk.gray(`  5) Smart Swap : anti rate-limit, auto-switch pair (CC↔USDCx↔cETH)`));
    console.log(chalk.gray(`  6) Reverse Tri: CC → cETH → USDCx → CC\n`));

    SWAP_PATTERN = await askPattern();
    const patternLabel = {
        'BULKBACK': 'Bulk Back CC (USDCx + cETH → CC)',
        'A': 'Triangle (CC→USDCx→cETH→CC)',
        'CCU': 'CC↔USDCx (CC→USDCx→CC)',
        'UCE': 'USDCx↔cETH (USDCx→cETH→USDCx)',
        'CCE': 'CC↔cETH (CC→cETH→CC)',
        'SMART': 'Smart Swap (anti rate-limit, auto-switch pair)',
        'AR': 'Reverse Triangle (CC→cETH→USDCx→CC)',
    }[SWAP_PATTERN];
    console.log(chalk.green(`\n  ✅ Pola swap: ${patternLabel}\n`));

    // ── Step 2: Auto-detect proxy mode ──
    const hasProxy = proxyLines.length > 0 && accounts.some(a => a.proxy);
    if (hasProxy) {
        console.log(chalk.green(`  ✅ Mode: PROXY — ${proxyLines.length} proxy loaded, langsung eksekusi parallel\n`));
    } else {
        for (const acc of accounts) acc.proxy = '';
        console.log(chalk.green(`  ✅ Mode: NON-PROXY — koneksi langsung\n`));
    }

    // ── Opsi 0: BULK BACK CC — jalur terpisah (one-shot, lalu exit) ──
    if (SWAP_PATTERN === 'BULKBACK') {
        await runBulkBack(accounts);
        process.exit(0);
    }

    dashboard.init(accounts);
    dashboard.startAutoRefresh();
    const telegramTimer = startTelegramScheduler();
    const dashPushTimer = startDashboardPush();
    const cmdPollTimer = startCommandPoller();

    // Stagger account starts with random delay to prevent ECONNRESET stampede and detection
    const STAGGER_MIN_SEC = config.stagger_min_seconds ?? 1;
    const STAGGER_MAX_SEC = config.stagger_max_seconds ?? 1;

    // Calculate cumulative delays for each account
    const staggerDelays = accounts.map((_, i) => {
        if (i === 0) return 0; // First account starts immediately
        // Random delay for each subsequent account
        return getRandomDelay(STAGGER_MIN_SEC, STAGGER_MAX_SEC);
    });

    // Log stagger plan
    console.log(chalk.gray(`  📋 Stagger plan:`));
    let cumulativeDelay = 0;
    staggerDelays.forEach((delay, i) => {
        cumulativeDelay += delay;
        console.log(chalk.gray(`     Acc ${i + 1}: starts after ${formatDelayTime(cumulativeDelay)}`));
    });
    console.log('');

    const results = await Promise.allSettled(
        accounts.map((acc, i) => {
            // Calculate cumulative delay for this account
            const totalDelay = staggerDelays.slice(0, i + 1).reduce((a, b) => a + b, 0);
            return new Promise(resolve => {
                setTimeout(async () => {
                    try {
                        const result = await runAccount(acc, i);
                        resolve(result);
                    } catch (err) {
                        resolve(Promise.reject(err));
                    }
                }, totalDelay * 1000);
            });
        })
    );

    dashboard.stop();
    if (telegramTimer) clearInterval(telegramTimer);
    // Final push ke dashboard sebelum exit
    await pushToDashboard();
    stopDashboardPush();
    stopCommandPoller();
    // Kirim summary final sebelum exit
    await sendTelegramSummary();

    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    console.log(chalk.bold.green(`\n  ✅ All done: ${ok} ok, ${fail} fail\n`));
}

main();
