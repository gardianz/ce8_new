/**
 * ╔══════════════════════════════════════════════════════╗
 * ║       🤖 CANTOR8 MULTI-ACCOUNT WALLET BOT V2.1       ║
 * ║    Auto CC ↔ USDCX Round-Trip Swap (Parallel)        ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Usage: node index.js
 * Config: config.json (accounts[], swap settings, API URLs)
 */

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { randomBytes } from 'crypto';
import http from 'http';
import https from 'https';
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
        interval_seconds: 600,
    },
    retry: {
        rate_limit_initial_delay_minutes: userCfg.rate_limit?.tunggu_pertama_menit ?? 50,
        rate_limit_delays: userCfg.rate_limit?.tunggu_lanjutan_detik ?? [15, 30, 60],
        server_rejected_delays: [15, 30, 60],
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
};

config.accounts = accountLines.map((mnemonic, i) => ({
    name: `Acc ${i + 1}`,
    mnemonic,
    proxy: proxyLines[i] || '',
}));

const BACKEND = config.api.backend_url;
const SWAP_API = config.api.swap_url;
const EXCHANGE = config.api.exchange_url;

const ASSET_TO_INSTRUMENT = { '0x0': 'Amulet', 'USDCX': 'USDCx', 'CETH': 'cETH' };

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

async function retryOnNetwork(fn, { maxRetries = Infinity, baseDelay = 3, label = '', log = null, onRateLimitRetry = null } = {}) {
    let rateLimitAttempt = 0;
    const rateLimitInitialDelayMin = config.retry?.rate_limit_initial_delay_minutes ?? 61;
    const rateLimitDelays = config.retry?.rate_limit_delays || [15, 30, 60];
    let consecutiveTimeouts = 0;
    const MAX_CONSECUTIVE_TIMEOUTS = 3;

    for (let attempt = 0; ; attempt++) {
        try {
            const result = await fn();
            consecutiveTimeouts = 0; // reset on success
            return result;
        } catch (err) {
            // 500+ → throw immediately (soft restart by runAccount)
            if (err.response?.status >= 500) throw err;

            // 429 rate limit → first time: 61 minutes, then escalating delays
            if (err.response?.status === 429) {
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
                await sleep(delay);
                if (typeof onRateLimitRetry === 'function') {
                    await onRateLimitRetry({ attempt: rateLimitAttempt, delay, err });
                }
                continue;
            }

            // 422 → throw immediately (handled specifically by executeSwap with fresh quotes)
            if (err.response?.status === 422) throw err;

            if (!isRetryableError(err)) throw err;

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
        acceptOfferPrepare: (token, body) =>
            ax.post(`${BACKEND}/offer/accept/prepare`, {
                contract_id: body.contractId, party_id: body.partyId
            }, { headers: auth(token) }).then(r => r.data),
        getTransferStatus: (token, commandId) =>
            ax.get(`${BACKEND}/transfer/status`, { params: { command_id: commandId }, headers: auth(token) }).then(r => r.data),
        getRegisterStatus: (token) =>
            ax.get(`${BACKEND}/register/status_v2`, { headers: auth(token) }).then(r => r.data),
        postConfirmV2: (token) =>
            ax.post(`${BACKEND}/register/post_confirm_v2`, {}, { headers: auth(token) }).then(r => r.data),
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
            ax.post(`${SWAP_API}/orders`, { orderId, quoteId, toAddress, slippageBps }, { headers: auth(swapToken) }).then(r => r.data),
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
    if (length > width) {
        const plain = Array.from(stripAnsi(text));
        if (width <= 3) {
            let out = '', outWidth = 0;
            for (const char of plain) {
                const w = charDisplayWidth(char);
                if (outWidth + w > width) break;
                out += char; outWidth += w;
            }
            return out;
        }
        const maxTextWidth = width - 3;
        let out = '', outWidth = 0;
        for (const char of plain) {
            const w = charDisplayWidth(char);
            if (outWidth + w > maxTextWidth) break;
            out += char; outWidth += w;
        }
        return `${out}...`;
    }
    return text + ' '.repeat(width - length);
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
    const cols = process.stdout.columns || 80;
    const usable = Math.min(cols, 80);
    const left = Math.floor((usable - 3) / 2);
    const right = usable - 3 - left;
    return { left, right };
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
const MAX_LOG_LINES = Math.max(5, Number(config.max_log_lines) || 50);
const DASHBOARD_LOG_ROWS = MAX_LOG_LINES;
const MAX_GLOBAL_LOGS = MAX_LOG_LINES;

const dashboard = {
    accounts: [],
    globalLogs: [],
    _timer: null,
    _renderPending: false,

    init(accountConfigs) {
        this.accounts = accountConfigs.map((acc, i) => ({
            name: acc.name || `Acc ${i + 1}`,
            num: i + 1,
            startTime: Date.now(),
            cc: 0, usdcx: 0, ceth: 0,
            swapsCCtoU: 0, swapsUtCC: 0,
            swapsUtoCETH: 0, swapsCETHtoCC: 0,
            maxCCtoU: config.swap.rounds || 0, maxUtCC: 0,
            totalSwaps: 0, lastSwapDir: '',
            monthReward: 0, monthVolume: 0, monthTxns: 0,
            totalReward: 0, pendingReward: 0, rank: 0,
            rewardDate: '',
            initialTxns: null, initialReward: null,
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
        console.clear();
        const { left: L, right: R } = getTermWidth();

        const headerTime = new Date().toLocaleTimeString('en-GB', { hour12: false });
        const modeLabel = 'CC <> USDCx <> CETH';

        const left = [];
        left.push(centerToWidth(chalk.bold.hex('#67E8F9')('Cantor8 Bot V2.1'), L));
        left.push(SEP);
        left.push(` ${chalk.hex('#67E8F9')('Mode')} ${chalk.white(modeLabel)}`);
        left.push(` ${chalk.hex('#67E8F9')('Acc')}  ${chalk.white(String(this.accounts.length))}  ${chalk.hex('#67E8F9')('Time')} ${chalk.white(headerTime)}`);
        left.push(SEP);

        const compact = this.accounts.length > 10;
        let totCC = 0, totUSDCx = 0, totCETH = 0, totReward = 0, totDelta = 0, totSwaps = 0;

        for (const a of this.accounts) {
            totCC += a.cc;
            totUSDCx += a.usdcx;
            totCETH += a.ceth || 0;
            totReward += a.monthReward;
            totDelta += a.diffReward;
            totSwaps += a.totalSwaps;

            const deltaVal = a.diffReward;
            const deltaFmt = deltaVal >= 0 ? `+${deltaVal.toFixed(1)}` : `${deltaVal.toFixed(1)}`;
            const upStr = formatUptime(a.startTime);

            const ccColor = a.cc >= 25 ? chalk.green : a.cc >= 10 ? chalk.yellow : chalk.red;
            const deltaColor = deltaVal > 0 ? chalk.green : deltaVal < 0 ? chalk.red : chalk.gray;
            const statusColor = a.status === 'swapping' ? chalk.cyan :
                a.status === 'bulk-back' ? chalk.magenta :
                    a.status === 'init' ? chalk.gray :
                        a.status === 'done' ? chalk.green :
                            a.status?.includes('kurang') ? chalk.red :
                                a.status?.includes('wait') ? chalk.yellow :
                                    chalk.white;

            if (compact) {
                const num = chalk.hex('#6EE7B7')(String(a.num).padStart(2) + '.');
                const st = (a.status || 'init').slice(0, 8);
                left.push(` ${num} ${ccColor(a.cc.toFixed(1))}CC ${chalk.blue(a.usdcx.toFixed(1))}USDC ${chalk.cyan((a.ceth || 0).toFixed(4))}cETH`);
                left.push(`     ${chalk.gray(upStr)} ${statusColor(st)} ${deltaColor(deltaFmt)}`);
            } else {
                const proxyTag = a.proxyIp ? chalk.gray(` [${a.proxyIp}]`) : a.proxyHost ? chalk.gray(` [${a.proxyHost}]`) : '';
                left.push(` ${chalk.hex('#6EE7B7')(String(a.num) + '.')} ${chalk.white(a.name)}${proxyTag}`);
                left.push(`    ${chalk.hex('#A7F3D0')('CC')} ${ccColor(a.cc.toFixed(1))} ${chalk.hex('#A7F3D0')('USDC')} ${chalk.blue(a.usdcx.toFixed(1))} ${chalk.hex('#A7F3D0')('cETH')} ${chalk.cyan((a.ceth || 0).toFixed(4))}`);
                left.push(`    ${chalk.hex('#A7F3D0')('Up')} ${chalk.gray(upStr)} ${chalk.hex('#A7F3D0')('D')} ${deltaColor(deltaFmt)} ${statusColor(a.status || 'init')}`);
            }
        }

        left.push(SEP);

        const totDeltaFmt = totDelta >= 0 ? `+${totDelta.toFixed(2)}` : `${totDelta.toFixed(2)}`;
        left.push(` ${chalk.bold.hex('#FBBF24')('TOT')} ${chalk.hex('#67E8F9')('CC')} ${chalk.green.bold(totCC.toFixed(2))} ${chalk.hex('#67E8F9')('Ux')} ${chalk.blue.bold(totUSDCx.toFixed(4))}`);
        left.push(`     ${chalk.hex('#67E8F9')('cE')} ${chalk.cyan.bold(totCETH.toFixed(6))} ${chalk.hex('#67E8F9')('Sw')} ${chalk.white.bold(String(totSwaps))}`);
        left.push(`     ${chalk.hex('#67E8F9')('Rw')} ${chalk.green.bold(totReward.toFixed(2))} ${chalk.hex('#67E8F9')('D')} ${chalk.green.bold(totDeltaFmt)}`);

        const right = [];
        right.push(centerToWidth(chalk.bold.hex('#FBBF24')('Activity Log'), R));
        right.push(SEP);

        const allLogRows = [];
        const recentLogs = this.globalLogs.slice(-DASHBOARD_LOG_ROWS);
        for (const entry of recentLogs) {
            const wrapped = wrapLine(` ${stripAnsi(entry)}`, R);
            for (const row of wrapped) {
                allLogRows.push(row);
            }
        }
        const visibleLogRows = allLogRows.slice(-DASHBOARD_LOG_ROWS);
        for (const row of visibleLogRows) right.push(row);
        const emptyRows = Math.max(0, DASHBOARD_LOG_ROWS - visibleLogRows.length);
        for (let i = 0; i < emptyRows; i++) right.push('');

        const maxRows = Math.max(left.length, right.length);
        const c = chalk.hex('#555');

        console.log(c(`┌${'─'.repeat(L)}┬${'─'.repeat(R)}┐`));

        for (let i = 0; i < maxRows; i++) {
            const lVal = left[i] ?? '';
            const rVal = right[i] ?? '';
            const lIsSep = lVal === SEP;
            const rIsSep = rVal === SEP;

            if (lIsSep && rIsSep) {
                console.log(c(`├${'─'.repeat(L)}┼${'─'.repeat(R)}┤`));
            } else if (lIsSep) {
                console.log(c(`├${'─'.repeat(L)}┤`) + padCell(rVal, R) + c('│'));
            } else if (rIsSep) {
                console.log(c('│') + padCell(lVal, L) + c(`├${'─'.repeat(R)}┤`));
            } else {
                console.log(c('│') + padCell(lVal, L) + c('│') + padCell(rVal, R) + c('│'));
            }
        }

        console.log(c(`└${'─'.repeat(L)}┴${'─'.repeat(R)}┘`));
    },

    startAutoRefresh() {
        if (this._timer) return;
        this._timer = setInterval(() => this._scheduleRender(), 10000);
    },

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },
};

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

async function runAccount(accConfig, index) {
    const name = accConfig.name || `Acc ${index + 1}`;
    const log = (msg) => dashboard.log(index, msg);

    for (let accountAttempt = 1; ; accountAttempt++) {
        try {
            await runAccountOnce(accConfig, index, name, log);
            return; // success, exit retry loop
        } catch (err) {
            // Error 500+ → soft restart immediately (short delay)
            if (err.response?.status >= 500) {
                log(`🔄 [${err.response.status}] soft restart 5s`);
                dashboard.update(index, { status: 'soft-restart' });
                await sleep(5);
                accountAttempt = Math.max(1, accountAttempt - 1); // don't escalate delay for 500
                continue;
            }

            // ERR_BAD_RESPONSE → soft restart immediately
            if (err.code === 'ERR_BAD_RESPONSE' || err.message?.includes('ERR_BAD_RESPONSE')) {
                log(`🔄 [ERR_BAD_RESPONSE] soft restart 5s`);
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

async function runAccountOnce(accConfig, index, name, log) {
    const ax = createAxiosInstance(accConfig.proxy || '');
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
        // Fetch actual outbound IP in background (non-blocking)
        const IP_ENDPOINTS = [
            { url: 'https://api.ipify.org?format=json', extract: r => r.data?.ip },
            { url: 'https://api4.my-ip.io/ip.json', extract: r => r.data?.ip },
            { url: 'https://ipinfo.io/json', extract: r => r.data?.ip },
            { url: 'https://api.ipify.org', extract: r => String(r.data).trim() },
        ];
        (async () => {
            for (const ep of IP_ENDPOINTS) {
                try {
                    const r = await ax.get(ep.url, { timeout: 15000 });
                    const ip = ep.extract(r);
                    if (ip && ip.includes('.')) { dashboard.update(index, { proxyIp: ip }); return; }
                } catch { /* try next */ }
            }
        })();
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
                // Challenge expired in transit — fetch fresh one immediately, no wait
                log(`🔄 [login] Challenge expired, retrying immediately... (attempt ${loginAttempt})`);
                continue;
            }
            if (!isRetryableError(err)) throw err;
            const delay = Math.min(3 * Math.pow(2, loginAttempt - 1), 30);
            log(`🔄 [login] ${formatError(err)} (attempt ${loginAttempt}, wait ${delay}s)`);
            await sleep(delay);
        }
    }
    log('✅ Authenticated');

    // Step 3b: Post-login registration checks (HAR flow)
    try {
        const regStatus = await walletApi.getRegisterStatus(session.walletToken);
        log(`📋 Registration: ${regStatus.is_registered ? '✅' : '⏳'}`);
        await walletApi.postConfirmV2(session.walletToken);
        await walletApi.getOutgoingExpired(session.walletToken);
    } catch { /* non-critical */ }

    // Step 4: Dashboard data
    const ctx = { session, walletApi, swapApi, log, name, index, ax };
    log('📊 Fetching balance & stats...');
    const holdings = await refreshAccountData(ctx);

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
        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
    );

    let cc = 0, usdcx = 0, ceth = 0;
    for (const [tok, info] of Object.entries(holdings)) {
        if (tok === 'Amulet' || tok === 'CC (Amulet)' || tok === 'CC') cc = info.balance || 0;
        if (tok === 'USDCx' || tok === 'USDCX') usdcx = info.balance || 0;
        if (tok === 'CETH' || tok === 'cETH' || tok === 'Ceth') ceth = info.balance || 0;
    }

    let monthReward = 0, monthVolume = 0, monthTxns = 0;
    let totalReward = 0, pendingReward = 0, rank = 0;
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
        }
    } catch { /* skip */ }

    // Track initial values for diff calculation
    const currentAccount = dashboard.accounts[index];
    let diffTxns = currentAccount.diffTxns || 0;
    let diffReward = currentAccount.diffReward || 0;

    if (currentAccount.initialTxns === null) {
        // First time - set initial values
        dashboard.update(index, { initialTxns: monthTxns, initialReward: monthReward });
    } else {
        // Calculate diff from initial
        diffTxns = monthTxns - currentAccount.initialTxns;
        diffReward = monthReward - currentAccount.initialReward;
    }

    dashboard.update(index, {
        cc, usdcx, ceth,
        monthReward, monthVolume, monthTxns,
        totalReward, pendingReward, rank,
        diffTxns, diffReward,
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
                }
            } catch { /* skip leaderboard errors */ }

            // Track diff values
            const currentAccount = dashboard.accounts[index];
            let diffTxns = currentAccount.diffTxns || 0;
            let diffReward = currentAccount.diffReward || 0;

            if (currentAccount.initialTxns !== null) {
                diffTxns = monthTxns - currentAccount.initialTxns;
                diffReward = monthReward - currentAccount.initialReward;
            }

            // Update dashboard silently
            dashboard.update(index, {
                cc, usdcx, ceth,
                monthReward, monthVolume, monthTxns,
                totalReward, pendingReward, rank,
                diffTxns, diffReward,
                rewardDate: new Date().toISOString().slice(0, 10),
            });

            const diffStr = diffReward >= 0 ? `+${diffReward.toFixed(2)}` : diffReward.toFixed(2);
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
    dashboard.update(index, { status: 'swap-auth' });
    log('🔐 Authenticating swap API...');
    await retryOnNetwork(async () => {
        const { nonce } = await swapApi.getNonce();
        const swapAuth = await swapApi.bindSignature(nonce, session.partyId);
        session.swapToken = swapAuth.accessToken;
        session.swapLoginTime = Date.now();
    }, { maxRetries: 8, baseDelay: 5, label: 'swapAuth', log });
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
            dashboard.update(index, { cc: ccBalance, usdcx: usdcxBalance, ceth: cethBalance });
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

    log(`⚡ ${rounds} rounds (alur CC→USDCx→CETH→CC, no bulk-back)`);

    for (let round = 1; round <= rounds; round++) {
        await session.ensureFreshTokens(walletApi, swapApi, log);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
        await refreshBalances();

        if (ccBalance >= rewardThreshold) {
            log(`🎉 Reward landed mid-loop! CC(${ccBalance.toFixed(2)})`);
            dashboard.update(index, { status: 'reward-landed', swap: false, totalSwaps });
            return;
        }

        // ── STEP A: Selesaikan CETH dulu kalau ada saldo (CETH → CC) ──
        if (pair_c && cethBalance > 0) {
            dashboard.update(index, { status: `${pair_c.label}→CC R${round}` });
            const r = await doLeg(pair_c, pair_a, cethBalance, `R${round} ${pair_c.label}→CC`, { pollTimeoutMinutes: 10 });
            if (r) {
                totalSwaps++;
                dashboard.update(index, {
                    totalSwaps, lastSwapDir: '↩CC',
                    swapsUtCC: (dashboard.accounts[index].swapsUtCC || 0) + 1,
                    swapsCETHtoCC: (dashboard.accounts[index].swapsCETHtoCC || 0) + 1,
                });
                consecutiveFails = 0;
                await refreshBalances();
            } else {
                consecutiveFails++;
                await sleep(Math.min(15 * consecutiveFails, 120));
                round--; continue;
            }
        }

        // ── STEP B: Selesaikan USDCx kalau ada saldo (USDCx → CETH) ──
        if (pair_c && usdcxBalance >= 0.0001) {
            dashboard.update(index, { status: `U→${pair_c.label} R${round}` });
            const r = await doLeg(pair_b, pair_c, usdcxBalance, `R${round} U→${pair_c.label}`, { pollTimeoutMinutes: 10 });
            if (r) {
                totalSwaps++;
                dashboard.update(index, {
                    totalSwaps, lastSwapDir: `→${pair_c.label}`,
                    swapsUtoCETH: (dashboard.accounts[index].swapsUtoCETH || 0) + 1,
                });
                consecutiveFails = 0;
                await refreshBalances();
                // Lanjut ke STEP A di iterasi berikutnya untuk swap CETH→CC
                round--; continue;
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
        // Lanjut ke CETH→CC dulu, lalu CETH→CC lagi
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

// ── Accept Pending Offers ────────────────────────────────────────────────

async function acceptPendingOffers(ctx) {
    const { session, walletApi, swapApi, log, ax } = ctx;

    let offers = [];
    const OFFER_WAITS = [2, 3];
    for (let attempt = 1; attempt <= OFFER_WAITS.length; attempt++) {
        try {
            const result = await session.withRetry(
                () => walletApi.getOffers(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            offers = result.offers || [];
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
            const preparedTxB64 = offer.prepared_tx_b64 || offer.preparedTxB64;
            const hashB64 = offer.hash_b64 || offer.hashB64;

            if (preparedTxB64 && hashB64) {
                const signature = signMessage(session.keyPair.privateKey, Buffer.from(hashB64, 'base64'));
                await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
                    commandId, preparedTxB64,
                    signatureB64: toBase64(signature),
                    hashingSchemeVersion: offer.hashing_scheme_version || 'HASHING_SCHEME_VERSION_V2',
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
                const rejectedDelays = config.retry?.server_rejected_delays || [15, 30, 60];
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

        const instrumentId = ASSET_TO_INSTRUMENT[fromAsset] || fromAsset;
        log(`📦 Transfer ${order.requiredAmount} ${instrumentId}`);
        let rawPrepare = null;
        for (let retry = 0; retry < 3; retry++) {
            try {
                rawPrepare = await session.withRetry(() => walletApi.prepareTransfer(session.walletToken, {
                    instrumentAdminId: instrumentAdminId || '',
                    instrumentId,
                    receiverPartyId: order.deposit.address,
                    amount: order.requiredAmount,
                    reason: orderId,
                    appName: 'swap-v1',
                    metadata: {},
                }), 'wallet', walletApi, swapApi, log);
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

        log('✍️ Signing & executing transfer...');
        const signature = signMessage(session.keyPair.privateKey, Buffer.from(hashB64, 'base64'));
        await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
            commandId, preparedTxB64,
            signatureB64: toBase64(signature),
            hashingSchemeVersion,
        }), 'wallet', walletApi, swapApi, log);

        // Poll transfer/status until confirmed (HAR flow)
        log('⏳ Waiting for deposit confirmation...');
        for (let ts = 0; ts < 20; ts++) {
            await sleep(3);
            try {
                const txStatus = await walletApi.getTransferStatus(session.walletToken, commandId);
                if (txStatus.status === 'success') {
                    log('✅ Deposit confirmed on-chain');
                    break;
                }
            } catch { /* continue polling */ }
        }

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
            const offerResult = await session.withRetry(
                () => walletApi.getOffers(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            if ((offerResult.offers?.length || 0) > 0) {
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

// ── Main Entry Point ─────────────────────────────────────────────────────

async function main() {
    const accounts = config.accounts || [];

    if (!accounts.length) {
        console.error(chalk.red('❌ No accounts configured in config.json'));
        process.exit(1);
    }

    process.stdout.write('\x1B[H\x1B[2J');
    console.log(chalk.cyan.bold(`  🤖 CANTOR8 MULTI-ACCOUNT BOT V2 — ${accounts.length} account(s)\n`));

    await fetchAndLogProxyIps(accounts);

    dashboard.init(accounts);
    dashboard.startAutoRefresh();
    const telegramTimer = startTelegramScheduler();

    // Stagger account starts with random delay to prevent ECONNRESET stampede and detection
    const STAGGER_MIN_SEC = config.stagger_min_seconds ?? 5;
    const STAGGER_MAX_SEC = config.stagger_max_seconds ?? 60;

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
    // Kirim summary final sebelum exit
    await sendTelegramSummary();

    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    console.log(chalk.bold.green(`\n  ✅ All done: ${ok} ok, ${fail} fail\n`));
}

main();
