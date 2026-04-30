/**
 * ╔══════════════════════════════════════════════════════╗
 * ║        CANTOR8 MULTI-ACCOUNT WALLET BOT V2        ║
 * ║    Auto CC  USDCX Round-Trip Swap (Parallel)       ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Usage: node index.js
 * Config: config.json (accounts[], swap settings, API URLs)
 */

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { createInterface } from 'readline';
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

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

// Load accounts from accounts.json (one mnemonic per line) + proxy.txt (one proxy per line)
const accountLines = readFileSync(new URL('./accounts.json', import.meta.url), 'utf-8')
    .split('\n').map(l => l.trim()).filter(l => l.length > 0);
let proxyLines = [];
try {
    proxyLines = readFileSync(new URL('./proxy.txt', import.meta.url), 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l.length > 0);
} catch { /* proxy.txt optional */ }

config.accounts = accountLines.map((mnemonic, i) => ({
    name: `Acc ${i + 1}`,
    mnemonic,
    proxy: proxyLines[i] || '',
}));

const BACKEND = config.api.backend_url;
const SWAP_API = config.api.swap_url;
const EXCHANGE = config.api.exchange_url;

const ASSET_TO_INSTRUMENT = { '0x0': 'Amulet', 'USDCX': 'USDCx', 'CETH': 'cETH' };
const CETH_INST_ADMIN = 'rails-cethMain-1::12200350ba6e96e3b701c3048b5aa013a8c1c08833e8ebf54339cff581055c29003a';

// ── Active Pair Mode (set at startup) ────────────────────────────────────
let activePairMode = 'USDCX'; // 'USDCX' or 'CETH'
let swapMode = 4; // 1=CCUSDCx, 2=CCCETH, 3=Triangular, 4=Extended

const CC_ASSET_KEYS = ['Amulet', 'CC (Amulet)', 'CC'];
const USDCX_ASSET_KEYS = ['USDCx', 'USDCX'];
const CETH_ASSET_KEYS = ['cETH', 'CETH'];

function getPairBAssetKeys() {
    return activePairMode === 'CETH' ? CETH_ASSET_KEYS : USDCX_ASSET_KEYS;
}
function getPairBLabel() {
    return activePairMode === 'CETH' ? 'CETH' : 'USDCx';
}
function getBulkMin() {
    return activePairMode === 'CETH' ? (config.swap.ceth_bulk_min ?? 0.0005) : 1;
}
function getPairBDecimals() {
    return activePairMode === 'CETH' ? 8 : 4;
}
function getHoldingBal(holdings, keys) {
    for (const k of keys) {
        if (holdings?.[k]?.balance != null) return holdings[k].balance;
    }
    return 0;
}
function getActivePairB() {
    return activePairMode === 'CETH'
        ? (config.swap.pair_ceth || { chain: 'CC', asset: 'CETH', label: 'CETH' })
        : config.swap.pair_b;
}

// ── Dynamic Minimum Swap Config (SIMPLE) ─────────────────────────────────
const dynamicMinSwap = {
    enabled: config.swap?.dynamic_minimum_swap?.enabled ?? false,
    extraCc: config.swap?.dynamic_minimum_swap?.extra_cc ?? 1.5,
    fallbackMin: config.swap?.dynamic_minimum_swap?.fallback_min || config.swap.min_amount || 27,
    lastRawMin: null,  // cache untuk bulk-back check
};

const BASE_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://wallet.cantor8.tech',
    'Referer': 'https://wallet.cantor8.tech/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

const TOKEN_MAX_AGE_MS = 45 * 60 * 1000;
const SETUP_WAIT_MAX = 30;   // max retries waiting for account setup (422) — ~15 min at 30s intervals
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

// ── Telegram Notifications ───────────────────────────────────────────────
async function sendTelegramMessage(text) {
    const tcfg = config.telegram;
    if (!tcfg?.enabled || !tcfg?.bot_token || !tcfg?.user_id) return;
    try {
        const url = `https://api.telegram.org/bot${tcfg.bot_token}/sendMessage`;
        await axios.post(url, {
            chat_id: tcfg.user_id,
            text: text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (err) { }
}

async function sendSwapNotification(ctx, type, sendAmount, result) {
    if (!config.telegram?.enabled) return;
    const { index } = ctx;
    const a = dashboard.accounts[index];
    if (!a) return;

    const pairLabel = getPairBLabel();
    const pairDec = getPairBDecimals();
    const isMain = type === 'MAIN';
    const fromSymbol = isMain ? 'CC' : pairLabel;
    const toSymbol = isMain ? pairLabel : 'CC';
    const nextText = isMain ? `${pairLabel} → CC` : `CC → ${pairLabel}`;

    const receiveAmount = typeof result === 'object' ? result?.receiveAmount : result;
    const swapData = typeof result === 'object' ? result : {};

    const formatUptimeLocal = (startMs) => {
        const sec = Math.floor((Date.now() - startMs) / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
        return `${m}m${String(s).padStart(2, '0')}s`;
    };
    const uptimeStr = formatUptimeLocal(a.startTime);

    const now = new Date();
    const wibDate = new Date(now.getTime() + (420 + now.getTimezoneOffset()) * 60000);
    let dateStr = wibDate.toLocaleString('en-GB', { hour12: false }) + ' WIB';
    try {
        const d = String(wibDate.getDate()).padStart(2, '0');
        const m = String(wibDate.getMonth() + 1).padStart(2, '0');
        const y = wibDate.getFullYear();
        const t = wibDate.toTimeString().split(' ')[0];
        dateStr = `${d}/${m}/${y} ${t} WIB`;
    } catch (e) { }

    const pairBBal = activePairMode === 'CETH' ? (a.ceth ?? 0) : a.usdcx;
    const balLine = ` <code>${a.cc.toFixed(5)} CC</code>  |  <code>${pairBBal.toFixed(pairDec)} ${pairLabel}</code>`;

    // TX Detail block
    let txBlock = '';
    const fee = swapData.fee ?? 0;
    const slippagePct = (swapData.slippageBps ?? 200) / 100;
    const userTx = swapData.userTxId || '';
    const solverTx = swapData.solverTxId || '';
    txBlock += `\n\n<b> TX Detail</b>\n`;
    txBlock += `   Dir     : <code>OUT</code>\n`;
    txBlock += `   Amount  : <code>${parseFloat(sendAmount || 0).toFixed(4)} ${fromSymbol}</code>\n`;
    txBlock += `   Fee TX  : <code>${parseFloat(fee).toFixed(6)} ${fromSymbol}</code>\n`;
    txBlock += `   Slippage: <code>${slippagePct.toFixed(1)}%</code>\n`;
    if (userTx) txBlock += `   <a href='https://ccview.io/updates/${userTx}/'>Send TX</a>\n`;
    if (solverTx) txBlock += `   <a href='https://ccview.io/updates/${solverTx}/'>Recv TX</a>\n`;

    // Leaderboard block with delta
    let lbBlock = '';
    if (a.rank > 0 || a.monthReward > 0) {
        const medal = a.rank === 1 ? '' : a.rank === 2 ? '' : a.rank === 3 ? '' : '';
        const deltaRew = a.diffReward > 0 ? ` <code>(+${a.diffReward.toFixed(6)})</code>` : '';
        lbBlock += `\n\n<b> Leaderboard</b>\n`;
        lbBlock += `  ${medal} Rank      : <b>#${a.rank}</b>\n`;
        lbBlock += `   Swaps     : <code>${a.monthTxns}</code>\n`;
        lbBlock += `   Volume    : <code>$${a.monthVolume.toFixed(2)}</code>\n`;
        lbBlock += `   Accrued   : <code>${a.pendingReward.toFixed(6)} CC</code>${deltaRew}\n`;
        lbBlock += `   Paid      : <code>${(a.totalReward - a.pendingReward).toFixed(6)} CC</code>\n`;
        lbBlock += `   Total     : <code>${a.totalReward.toFixed(6)} CC</code>`;
    }

    const text = ` <b>Swap #${a.totalSwaps} done</b>\n` +
        ` ${a.name}\n` +
        `──────────────────\n` +
        ` <code>${parseFloat(sendAmount || 0).toFixed(4)} ${fromSymbol}</code>  →  <code>${parseFloat(receiveAmount || 0).toFixed(pairDec)} ${toSymbol}</code>\n` +
        ` next: <code>${nextText}</code>\n` +
        ` ${uptimeStr}\n\n` +
        `${balLine}` +
        `${txBlock}${lbBlock}\n<i>${dateStr}</i>`;

    await sendTelegramMessage(text);
}

// ── Round Notification (Swap + Bulkback + P/L) ──────────────────────────

async function sendRoundNotification(ctx, round, rounds, info) {
    if (!config.telegram?.enabled) return;
    const { index } = ctx;
    const a = dashboard.accounts[index];
    if (!a) return;

    const pairLabel = getPairBLabel();
    const pairDec = getPairBDecimals();
    const { swapAmount, swapResult, bulkResult, bulkbackSuccess, ccBeforeSwap, ccAfterBulk, spread, rewardEstimate, netPL } = info;

    const swapData = (swapResult && typeof swapResult === 'object') ? swapResult : {};
    const bulkData = (bulkResult && typeof bulkResult === 'object') ? bulkResult : {};

    const formatUptimeLocal = (startMs) => {
        const sec = Math.floor((Date.now() - startMs) / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
        return `${m}m${String(s).padStart(2, '0')}s`;
    };
    const uptimeStr = formatUptimeLocal(a.startTime);

    const now = new Date();
    const wibDate = new Date(now.getTime() + (420 + now.getTimezoneOffset()) * 60000);
    let dateStr;
    try {
        const d = String(wibDate.getDate()).padStart(2, '0');
        const mo = String(wibDate.getMonth() + 1).padStart(2, '0');
        const y = wibDate.getFullYear();
        const t = wibDate.toTimeString().split(' ')[0];
        dateStr = `${d}/${mo}/${y} ${t} WIB`;
    } catch { dateStr = wibDate.toLocaleString('en-GB', { hour12: false }) + ' WIB'; }

    const pairBBal = activePairMode === 'CETH' ? (a.ceth ?? 0) : a.usdcx;
    const plIcon = netPL >= 0 ? '' : '';
    const plSign = netPL >= 0 ? '+' : '';

    // ── Build message ──
    let text = ` <b>Round ${round}/${rounds} Complete</b>\n`;
    text += ` ${a.name}\n`;
    text += `──────────────────\n`;

    // Swap line: CC → CETH/USDCx
    text += ` <code>${parseFloat(swapAmount || 0).toFixed(4)} CC</code>  →  <code>${parseFloat(swapData.receiveAmount || 0).toFixed(pairDec)} ${pairLabel}</code>\n`;

    // Bulkback line: CETH/USDCx → CC
    if (bulkbackSuccess && bulkData.receiveAmount) {
        text += ` <code>${parseFloat(bulkData.sendAmount || 0).toFixed(pairDec)} ${pairLabel}</code>  →  <code>${parseFloat(bulkData.receiveAmount || 0).toFixed(4)} CC</code>\n`;
    } else {
        text += ` <i>Bulkback pending/failed</i>\n`;
    }

    text += `──────────────────\n`;

    // P/L block
    if (bulkbackSuccess && spread !== 0) {
        text += ` Spread  : <code>-${spread.toFixed(4)} CC</code>\n`;
        text += ` Reward  : <code>+${rewardEstimate.toFixed(2)} CC</code> <i>(est)</i>\n`;
        text += ` Net P/L : <code>${plSign}${netPL.toFixed(4)} CC</code> ${plIcon}\n`;
    } else {
        text += ` P/L     : <i>bulkback pending</i>\n`;
    }
    text += `──────────────────\n`;

    // Balance
    text += ` <code>${a.cc.toFixed(4)} CC</code>  |  <code>${pairBBal.toFixed(pairDec)} ${pairLabel}</code>\n`;
    text += ` ${uptimeStr}\n`;

    // Leaderboard compact
    if (a.rank > 0) {
        const medal = a.rank === 1 ? '' : a.rank === 2 ? '' : a.rank === 3 ? '' : '';
        const deltaRew = a.diffReward > 0 ? ` (+${a.diffReward.toFixed(4)})` : '';
        text += `${medal} #${a.rank} |  ${a.monthTxns} swaps |  ${a.pendingReward.toFixed(4)} CC${deltaRew}\n`;
    }

    text += `<i>${dateStr}</i>`;

    await sendTelegramMessage(text);
}


// ── Cycle Notification (Full Circular Swap P/L + Rebates) ────────────────

async function sendCycleNotification(ctx, cycle, rounds, info) {
    if (!config.telegram?.enabled) return;
    const { index } = ctx;
    const a = dashboard.accounts[index];
    if (!a) return;

    const { ccCycleStart, ccCycleEnd, spreadLoss, rebatesBefore, rebatesAfter, rewardGain, netPL, stepFailed, totalSwaps: swaps } = info;

    const formatUptimeLocal = (startMs) => {
        const sec = Math.floor((Date.now() - startMs) / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
        return `${m}m${String(s).padStart(2, '0')}s`;
    };
    const uptimeStr = formatUptimeLocal(a.startTime);

    const now = new Date();
    const wibDate = new Date(now.getTime() + (420 + now.getTimezoneOffset()) * 60000);
    let dateStr;
    try {
        const d = String(wibDate.getDate()).padStart(2, '0');
        const mo = String(wibDate.getMonth() + 1).padStart(2, '0');
        const y = wibDate.getFullYear();
        const t = wibDate.toTimeString().split(' ')[0];
        dateStr = `${d}/${mo}/${y} ${t} WIB`;
    } catch { dateStr = wibDate.toLocaleString('en-GB', { hour12: false }) + ' WIB'; }

    const plIcon = netPL >= 0 ? '' : '';
    const plSign = netPL >= 0 ? '+' : '';
    const status = stepFailed ? ' INCOMPLETE' : ' SELESAI';

    let text = ` <b>Siklus #${cycle}/${rounds} ${status}</b>\n`;
    text += ` ${a.name}\n`;
    text += `──────────────────\n`;
    text += ` CC Awal     : <code>${ccCycleStart.toFixed(4)} CC</code>\n`;
    text += ` CC Akhir    : <code>${ccCycleEnd.toFixed(4)} CC</code>\n`;
    text += ` Spread Loss : <code>-${spreadLoss.toFixed(4)} CC</code>\n`;
    text += `──────────────────\n`;
    text += ` Rebates Before: <code>${rebatesBefore.toFixed(4)} CC</code>\n`;
    text += ` Rebates After : <code>${rebatesAfter.toFixed(4)} CC</code>\n`;
    text += ` Reward Gained : <code>+${rewardGain.toFixed(4)} CC</code>\n`;
    text += `──────────────────\n`;
    text += ` Net P/L: <code>${plSign}${netPL.toFixed(4)} CC</code> ${plIcon} (${netPL >= 0 ? 'UNTUNG' : 'RUGI'})\n`;
    text += `──────────────────\n`;
    text += ` <code>${(a.cc ?? 0).toFixed(4)} CC</code> | <code>${(a.usdcx ?? 0).toFixed(4)} USDCx</code> | <code>${(a.ceth ?? 0).toFixed(10)} CETH</code>\n`;
    text += ` Total swaps: ${swaps}\n`;
    text += ` ${uptimeStr}\n`;

    if (a.rank > 0) {
        const medal = a.rank === 1 ? '' : a.rank === 2 ? '' : a.rank === 3 ? '' : '';
        const deltaRew = a.diffReward > 0 ? ` (+${a.diffReward.toFixed(4)})` : '';
        text += `${medal} #${a.rank} |  ${a.monthTxns} swaps |  ${a.pendingReward.toFixed(4)} CC${deltaRew}\n`;
    }

    text += `<i>${dateStr}</i>`;
    await sendTelegramMessage(text);
}

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

    const { pair_a } = config.swap;
    const pair_b = getActivePairB();

    try {
        // Fetch minimum dari API
        const rawMin = await swapApi.getMinimumSwap(pair_a.chain, pair_a.asset, pair_b.chain, pair_b.asset);

        if (rawMin !== null && !isNaN(rawMin) && rawMin > 0) {
            dynamicMinSwap.lastRawMin = rawMin;  // simpan untuk bulk-back check
            const swapAmount = rawMin + dynamicMinSwap.extraCc;
            log(` Min: ${rawMin}CC + ${dynamicMinSwap.extraCc}CC = ${swapAmount.toFixed(2)}CC`);
            return swapAmount;
        }
    } catch (err) {
        // Silent fail, use fallback
    }

    // Fallback jika API gagal
    const fallbackAmount = dynamicMinSwap.fallbackMin + dynamicMinSwap.extraCc;
    return fallbackAmount;
}


// ── Fetch minimum for a SPECIFIC pair (for CETH leg) ─────────────────────
async function fetchMinSwapForPair(swapApi, log, fromPair, toPair) {
    try {
        const rawMin = await swapApi.getMinimumSwap(fromPair.chain, fromPair.asset, toPair.chain, toPair.asset);
        if (rawMin !== null && !isNaN(rawMin) && rawMin > 0) {
            const extra = dynamicMinSwap.enabled ? dynamicMinSwap.extraCc : 0;
            const swapAmount = rawMin + extra;
            log(` Min ${fromPair.label}→${toPair.label}: ${rawMin}CC + ${extra}CC = ${swapAmount.toFixed(2)}CC`);
            return swapAmount;
        }
    } catch { /* silent */ }
    return dynamicMinSwap.enabled
        ? (dynamicMinSwap.fallbackMin + dynamicMinSwap.extraCc)
        : config.swap.min_amount;
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

    const { pair_a } = config.swap;
    const pair_b = getActivePairB();
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

async function retryOnNetwork(fn, { maxRetries = Infinity, baseDelay = 3, label = '', log = null } = {}) {
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
                    if (log) log(` Rate limited — waiting ${rateLimitInitialDelayMin} minutes (first hit)`);
                } else {
                    // Subsequent 429s: use escalating delays
                    delay = getEscalatingDelay(rateLimitAttempt - 1, rateLimitDelays);
                    if (log) log(` Rate limited — ${delay}s (#${rateLimitAttempt})`);
                }
                rateLimitAttempt++;
                await sleep(delay);
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
                    if (log) log(` ${MAX_CONSECUTIVE_TIMEOUTS}x conn fail — soft restart`);
                    throw err; // trigger soft restart via runAccount
                }
            } else {
                consecutiveTimeouts = 0;
            }

            const rawDelay = Math.min(baseDelay * Math.pow(2, attempt), 30);
            const jitter = rawDelay * (0.7 + Math.random() * 0.6); // ±30% jitter
            const delay = Math.round(jitter * 10) / 10;
            if (log) log(` ${formatError(err)} — ${delay}s (#${attempt + 1})`);
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
    const h = BASE_HEADERS;
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

// ── Split-Screen UI Utilities (ported from handl.js) ─────────────────────

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
const DASHBOARD_LOG_ROWS = MAX_LOG_LINES; // max log rows in right panel
const MAX_GLOBAL_LOGS = MAX_LOG_LINES; // execution logs in right panel

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
        // Filter noisy lines that break the table layout (separators, batch dividers, blank lines)
        const stripped = stripAnsi(String(msg)).trim();
        if (!stripped) { this._scheduleRender(); return; }
        if (/^[═━─-]{3,}$/.test(stripped)) { this._scheduleRender(); return; }
        if (/^Batch\s+\d+\/\d+/i.test(stripped)) { this._scheduleRender(); return; }
        const cleanMsg = String(msg).replace(/^\n+/, '');
        a.logs.push(cleanMsg);
        while (a.logs.length > MAX_ACC_LOGS) a.logs.shift();
        // Also push to global execution logs (no timestamp — short and table-friendly)
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

        // ── Build LEFT panel lines ──
        const left = [];

        left.push(centerToWidth(chalk.bold.hex('#67E8F9')('Cantor8 Bot V2'), L));
        left.push(SEP);

        // Status
        left.push(` ${chalk.hex('#67E8F9')('Mode')} ${chalk.white(modeLabel)}`);
        left.push(` ${chalk.hex('#67E8F9')('Acc')}  ${chalk.white(String(this.accounts.length))}  ${chalk.hex('#67E8F9')('Time')} ${chalk.white(headerTime)}`);
        left.push(SEP);

        // Per-account (adaptive: compact when >10 accounts)
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

            // Color coding
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
                // Compact: 2 lines per account
                const num = chalk.hex('#6EE7B7')(String(a.num).padStart(2) + '.');
                const st = (a.status || 'init').slice(0, 8);
                left.push(` ${num} ${ccColor(a.cc.toFixed(1))}CC ${chalk.blue(a.usdcx.toFixed(1))}USDC ${chalk.cyan((a.ceth || 0).toFixed(4))}cETH`);
                left.push(`     ${chalk.gray(upStr)} ${statusColor(st)} ${deltaColor(deltaFmt)}`);
            } else {
                // Detailed: 3 lines per account
                const proxyTag = a.proxyIp ? chalk.gray(` [${a.proxyIp}]`) : a.proxyHost ? chalk.gray(` [${a.proxyHost}]`) : '';
                left.push(` ${chalk.hex('#6EE7B7')(String(a.num) + '.')} ${chalk.white(a.name)}${proxyTag}`);
                left.push(`    ${chalk.hex('#A7F3D0')('CC')} ${ccColor(a.cc.toFixed(1))} ${chalk.hex('#A7F3D0')('USDC')} ${chalk.blue(a.usdcx.toFixed(1))} ${chalk.hex('#A7F3D0')('cETH')} ${chalk.cyan((a.ceth || 0).toFixed(4))}`);
                left.push(`    ${chalk.hex('#A7F3D0')('Up')} ${chalk.gray(upStr)} ${chalk.hex('#A7F3D0')('D')} ${deltaColor(deltaFmt)} ${statusColor(a.status || 'init')}`);
            }
        }

        left.push(SEP);

        // Totals
        const totDeltaFmt = totDelta >= 0 ? `+${totDelta.toFixed(2)}` : `${totDelta.toFixed(2)}`;
        left.push(` ${chalk.bold.hex('#FBBF24')('TOT')} ${chalk.hex('#67E8F9')('CC')} ${chalk.green.bold(totCC.toFixed(2))} ${chalk.hex('#67E8F9')('Ux')} ${chalk.blue.bold(totUSDCx.toFixed(4))}`);
        left.push(`     ${chalk.hex('#67E8F9')('cE')} ${chalk.cyan.bold(totCETH.toFixed(6))} ${chalk.hex('#67E8F9')('Sw')} ${chalk.white.bold(String(totSwaps))}`);
        left.push(`     ${chalk.hex('#67E8F9')('Rw')} ${chalk.green.bold(totReward.toFixed(2))} ${chalk.hex('#67E8F9')('D')} ${chalk.green.bold(totDeltaFmt)}`);

        // ── Build RIGHT panel lines ──
        const right = [];

        right.push(centerToWidth(chalk.bold.hex('#FBBF24')('Activity Log'), R));
        right.push(SEP);

        // Wrap log lines into multiple rows (no truncation)
        const allLogRows = [];
        const recentLogs = this.globalLogs.slice(-DASHBOARD_LOG_ROWS);
        for (const entry of recentLogs) {
            const wrapped = wrapLine(` ${stripAnsi(entry)}`, R);
            for (const row of wrapped) {
                allLogRows.push(row);
            }
        }
        // Take last N rows to fit panel
        const visibleLogRows = allLogRows.slice(-DASHBOARD_LOG_ROWS);
        for (const row of visibleLogRows) {
            right.push(row);
        }
        const emptyRows = Math.max(0, DASHBOARD_LOG_ROWS - visibleLogRows.length);
        for (let i = 0; i < emptyRows; i++) {
            right.push('');
        }

        // ── Merge and render side by side ──
        const maxRows = Math.max(left.length, right.length);
        const c = chalk.hex('#555');

        console.log(c(`\u250c${'─'.repeat(L)}\u252c${'─'.repeat(R)}\u2510`));

        for (let i = 0; i < maxRows; i++) {
            const lVal = left[i] ?? '';
            const rVal = right[i] ?? '';
            const lIsSep = lVal === SEP;
            const rIsSep = rVal === SEP;

            if (lIsSep && rIsSep) {
                console.log(c(`\u251c${'─'.repeat(L)}\u253c${'─'.repeat(R)}\u2524`));
            } else if (lIsSep) {
                console.log(c(`\u251c${'─'.repeat(L)}\u2524`) + padCell(rVal, R) + c('\u2502'));
            } else if (rIsSep) {
                console.log(c('\u2502') + padCell(lVal, L) + c(`\u251c${'─'.repeat(R)}\u2524`));
            } else {
                console.log(c('\u2502') + padCell(lVal, L) + c('\u2502') + padCell(rVal, R) + c('\u2502'));
            }
        }

        console.log(c(`\u2514${'─'.repeat(L)}\u2534${'─'.repeat(R)}\u2518`));
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
            log(' Refreshing wallet token...');
            await retryOnNetwork(async () => {
                const { challenge } = await walletApi.getChallenge(this.partyId);
                const sig = toHex(signMessage(this.keyPair.privateKey, challenge));
                const { access_token } = await walletApi.login(this.partyId, challenge, sig);
                this.walletToken = access_token;
                this.walletLoginTime = Date.now();
            }, { maxRetries: 8, baseDelay: 3, label: 'refreshWallet', log });
        },

        async refreshSwapToken(swapApi, log) {
            log(' Refreshing swap token...');
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
                    log(` Wallet token refresh failed: ${formatError(err)}`);
                }
            }
            if (this.swapLoginTime && (now - this.swapLoginTime) > TOKEN_MAX_AGE_MS) {
                try {
                    await this.refreshSwapToken(swapApi, log);
                } catch (err) {
                    log(` Swap token refresh failed: ${formatError(err)}`);
                }
            }
        },

        async withRetry(fn, tokenType, walletApi, swapApi, log) {
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
            }, { maxRetries: 5, baseDelay: 3, label: 'apiCall', log });
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
        log(` Active order ${shortId(active.orderId)} (${active.status}), polling...`);
        for (let rp = 0; rp < 60; rp++) {
            await sleep(5);
            if (rp % 12 === 0 && rp > 0) await session.ensureFreshTokens(walletApi, swapApi, log);
            try {
                const st = await retryOnNetwork(
                    () => swapApi.getOrderStatus(session.swapToken, active.orderId),
                    { maxRetries: 3, baseDelay: 3, label: 'resolveOrder', log }
                );
                log(` ${shortId(active.orderId)} → ${st.status}`);
                if (TERMINAL_S.includes(st.status)) {
                    log(` Order ${shortId(active.orderId)} → ${st.status}`);
                    return true;
                }
            } catch (pe) {
                if (pe.response?.status === 401) { await session.refreshSwapToken(swapApi, log); continue; }
                log(` resolveOrder poll error: ${formatError(pe)}`);
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
                log(` [${err.response.status}] soft restart 5s`);
                dashboard.update(index, { status: 'soft-restart' });
                await sleep(5);
                accountAttempt = Math.max(1, accountAttempt - 1); // don't escalate delay for 500
                continue;
            }

            // ERR_BAD_RESPONSE → soft restart immediately
            if (err.code === 'ERR_BAD_RESPONSE' || err.message?.includes('ERR_BAD_RESPONSE')) {
                log(` [ERR_BAD_RESPONSE] soft restart 5s`);
                dashboard.update(index, { status: 'soft-restart' });
                await sleep(5);
                accountAttempt = Math.max(1, accountAttempt - 1);
                continue;
            }

            log(` ${formatError(err)}`);
            const delay = Math.min(ACCOUNT_RETRY_BASE_DELAY * Math.pow(1.5, accountAttempt - 1), 120);
            log(` Restart ${Math.round(delay)}s (#${accountAttempt})`);
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
    log(' Deriving key pairs...');
    const keyPairs = generateKeyPairs(accConfig.mnemonic);
    log(` ${keyPairs.length} keys derived`);

    // Step 2: Recover account (with network retry)
    dashboard.update(index, { status: 'recovering' });
    log(' Recovering account...');
    const recovery = await retryOnNetwork(
        () => walletApi.recoverAccount(keyPairs.map(k => k.publicKeyHex)),
        { maxRetries: 5, baseDelay: 3, label: 'recover', log }
    );
    const matchIdx = (recovery.results || []).findIndex(r => r !== null);
    if (matchIdx === -1) throw new Error('No account found for this mnemonic');
    const acct = recovery.results[matchIdx];
    log(` Party: ${shortId(acct.party_id)}`);

    // Step 3: Login (with network retry)
    dashboard.update(index, { status: 'auth', nonce: true });
    log(' Authenticating...');
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
                log(` [login] Challenge expired, retrying immediately... (attempt ${loginAttempt})`);
                continue;
            }
            if (!isRetryableError(err)) throw err;
            const delay = Math.min(3 * Math.pow(2, loginAttempt - 1), 30);
            log(` [login] ${formatError(err)} (attempt ${loginAttempt}, wait ${delay}s)`);
            await sleep(delay);
        }
    }
    log(' Authenticated');

    // Step 3b: Post-login registration checks (HAR flow)
    try {
        const regStatus = await walletApi.getRegisterStatus(session.walletToken);
        log(` Registration: ${regStatus.is_registered ? '' : ''}`);
        await walletApi.postConfirmV2(session.walletToken);
        await walletApi.getOutgoingExpired(session.walletToken);
    } catch { /* non-critical */ }

    // Step 4: Dashboard data
    const ctx = { session, walletApi, swapApi, log, name, index, ax };
    log(' Fetching balance & stats...');
    const holdings = await refreshAccountData(ctx);

    // Step 4b: Start background refresh for balance & reward
    const bgRefreshId = startBackgroundRefresh(ctx);

    // Step 5: Swap
    try {
        if (config.swap.enabled) {
            dashboard.update(index, { swap: true });
            await performSwap(ctx, holdings);
        } else {
            log(' Swap disabled');
            dashboard.update(index, { status: 'idle' });
        }
    } finally {
        // Always stop background refresh when done
        stopBackgroundRefresh(bgRefreshId);
    }

    log(' Completed');
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
        if (CC_ASSET_KEYS.includes(tok)) cc = info.balance || 0;
        if (USDCX_ASSET_KEYS.includes(tok)) usdcx = info.balance || 0;
        if (CETH_ASSET_KEYS.includes(tok)) ceth = info.balance || 0;
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
    } else if (monthReward > 0) {
        // Calculate diff from initial (only when API returned valid data)
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
        log(' Background refresh disabled');
        return null;
    }

    log(` BG refresh (${intervalSec}s)`);

    const intervalId = setInterval(async () => {
        try {
            // Ensure tokens are fresh before refresh
            await session.ensureFreshTokens(walletApi, swapApi, () => { });

            // Refresh balance
            const { holdings = {} } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, () => { }
            );

            let cc = 0, usdcx = 0, ceth = 0;
            for (const [tok, info] of Object.entries(holdings)) {
                if (CC_ASSET_KEYS.includes(tok)) cc = info.balance || 0;
                if (USDCX_ASSET_KEYS.includes(tok)) usdcx = info.balance || 0;
                if (CETH_ASSET_KEYS.includes(tok)) ceth = info.balance || 0;
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

            if (currentAccount.initialTxns !== null && monthReward > 0) {
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
        } catch {
            // Silent fail for background refresh
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
    for (let i = 1; i <= SETUP_WAIT_MAX; i++) {
        log(` Setup pending (${i}), wait 30s...`);
        await sleep(30);
        try {
            // Only test with getQuote - don't create orders during setup
            const pb = getActivePairB();
            const minAmt = config.swap.min_amount || 27;
            const q = await swapApi.getQuote('CC', '0x0', pb.chain, pb.asset, minAmt);
            if (q && q.quoteId) {
                log(' Account setup complete (quote OK)');
                return true;
            }
        } catch (err) {
            const status = err.response?.status;
            const detail = String(err.response?.data?.detail || err.response?.data?.message || '');
            if (status === 422 && detail.includes('Account setup not complete')) {
                log(` Still setting up... (attempt ${i})`);
                continue;
            }
            // Different error = setup might be done
            log(` Setup check got: [${status}] ${detail.slice(0, 80)}`);
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
        'CETH': ['cETH', 'CETH'],
    };
    const names = nameMap[assetKey] || [assetKey];
    for (const n of names) {
        if (holdings?.[n]?.instrument_admin_id) return holdings[n].instrument_admin_id;
    }
    // Fallback for CETH if not found in holdings
    if (assetKey === 'CETH') return CETH_INST_ADMIN;
    return '';
}

// ── Perform Swap ─────────────────────────────────────────────────────────

async function performSwap(ctx, holdings) {
    const { session, walletApi, swapApi, log, name, index } = ctx;
    const { rounds, delay_min_seconds, delay_max_seconds, min_amount, pair_a } = config.swap;
    const pair_b = getActivePairB();

    dashboard.update(index, { status: 'checking', maxCCtoU: rounds });

    log(' Checking exchange status...');
    const exchangeOk = await swapApi.checkExchange();
    if (!exchangeOk) {
        log(' Exchange offline → soft restart 30s');
        dashboard.update(index, { status: 'offline', swap: false });
        const offlineErr = new Error('EXCHANGE_OFFLINE');
        offlineErr.response = { status: 500 }; // trigger soft restart
        throw offlineErr;
    }

    // ── Dynamic Minimum Swap: Initial fetch ──
    if (dynamicMinSwap.enabled) {
        log(' Fetching minimum swap from API...');
        const initialAmount = await fetchDynamicMinSwap(swapApi, log);
        log(` Initial swap amount: ${initialAmount.toFixed(2)}CC (raw: ${dynamicMinSwap.lastRawMin})`);
    }

    // Get effective swap amount (dynamic or static) - will be fetched fresh before each swap
    const getMinThreshold = () => dynamicMinSwap.enabled
        ? (dynamicMinSwap.lastRawMin + dynamicMinSwap.extraCc)
        : min_amount;

    let ccBalance = getHoldingBal(holdings, CC_ASSET_KEYS);
    let usdcxBalance = getHoldingBal(holdings, getPairBAssetKeys());
    let holdingsCache = holdings || {}; // cache for instrument_admin_id lookups
    const rewardThreshold = config.swap.reward_landed_threshold ?? 100;

    // Check if reward landed (CC > threshold) → stop swapping
    if (ccBalance >= rewardThreshold) {
        log(` Reward landed! CC(${ccBalance.toFixed(2)}) >= ${rewardThreshold} → pausing`);
        dashboard.update(index, { status: 'reward-landed', swap: false });
        return;
    }

    // Auth swap API
    dashboard.update(index, { status: 'swap-auth' });
    log(' Authenticating swap API...');
    await retryOnNetwork(async () => {
        const { nonce } = await swapApi.getNonce();
        const swapAuth = await swapApi.bindSignature(nonce, session.partyId);
        session.swapToken = swapAuth.accessToken;
        session.swapLoginTime = Date.now();
    }, { maxRetries: 8, baseDelay: 5, label: 'swapAuth', log });
    dashboard.update(index, { swap: true });
    log(' Swap API ready');

    // Check eligibility (retry infinitely until eligible)
    for (let eligAttempt = 1; ; eligAttempt++) {
        try {
            const eligibility = await swapApi.checkEligibility(session.partyId);
            if (eligibility.eligible) {
                log(' Eligible for swap');
                break;
            }
            log(` Not eligible, retry 30s (#${eligAttempt})`);
            dashboard.update(index, { status: `ineligible #${eligAttempt}` });
            await sleep(30);
            await session.ensureFreshTokens(walletApi, swapApi, log);
        } catch {
            // API error = non-critical, assume eligible and continue
            break;
        }
    }

    // ── Recovery: check for in-flight orders from previous session ──
    log(' Checking for unfinished orders...');
    let hadActiveOrderAtStart = false; // Track if there was an active order at start
    try {
        const activeOrder = await swapApi.getActiveOrder(session.swapToken, {});
        if (activeOrder?.orderId) {
            const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
            if (!TERMINAL.includes(activeOrder.status)) {
                hadActiveOrderAtStart = true; // Mark that we had active order
                log(` Resume ${shortId(activeOrder.orderId)} (${activeOrder.status})`);
                dashboard.update(index, { status: `resuming ${activeOrder.status}` });

                const maxResumePoll = Infinity;
                let resumeCount = 0;
                let lastResumeStatus = activeOrder.status;
                while (resumeCount < maxResumePoll) {
                    await sleep(5);
                    resumeCount++;
                    if (resumeCount % 12 === 0) await session.ensureFreshTokens(walletApi, swapApi, log);
                    try {
                        const check = await swapApi.getOrderStatus(session.swapToken, activeOrder.orderId);
                        if (check.status !== lastResumeStatus) {
                            log(` Order: ${lastResumeStatus} → ${check.status}`);
                            lastResumeStatus = check.status;
                        }
                        if (TERMINAL.includes(check.status)) {
                            log(` Order ${shortId(activeOrder.orderId)} → ${check.status}`);
                            break;
                        }
                    } catch (pollErr) {
                        if (pollErr.response?.status === 401) {
                            await session.refreshSwapToken(swapApi, log);
                            continue;
                        }
                        log(` Order resolved`);
                        break;
                    }
                }
            } else {
                log(` Previous order already ${activeOrder.status}`);
            }
        } else {
            log(' No unfinished orders');
        }
    } catch {
        log(' No active orders found');
    }

    log(' Checking pending offers...');
    await acceptPendingOffers(ctx);

    log(' Refreshing balances...');
    try {
        const { holdings: h } = await session.withRetry(
            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
        );
        ccBalance = getHoldingBal(h, CC_ASSET_KEYS);
        usdcxBalance = getHoldingBal(h, getPairBAssetKeys());
        holdingsCache = h || holdingsCache;
        dashboard.update(index, { cc: ccBalance, usdcx: usdcxBalance });
        log(` CC:${ccBalance.toFixed(2)} ${getPairBLabel()}:${usdcxBalance.toFixed(getPairBDecimals())}`);
    } catch { /* use original */ }

    // ── Legacy Bulk-Back Loop Removed ──
    const ccReserve = config.swap.cc_reserve ?? 0.1;
    const initialSwapAmount = getMinThreshold();
    log(` ${rounds} siklus (swap_amount:${initialSwapAmount.toFixed(2)}CC${dynamicMinSwap.enabled ? ' [dynamic]' : ''})`);
    let totalSwaps = 0;

    // ══════════════════════════════════════════════════════════════
    // ── TRIANGULAR SWAP CYCLE ENGINE (3 TX/hour)                ──
    // ══════════════════════════════════════════════════════════════
    // Mode B: No pre-emptive cooldown, 429-driven timing
    //   Step 1: CC   → USDCx          (langsung)
    //   Step 2: USDCx → CETH          (langsung)
    //   Step 3: CETH → CC             (kena 429 → tunggu 28m → retry)
    //    Smart cooldown: sisa waktu untuk genap 1 jam dari start siklus
    // Total: ~60 min per cycle, 3 TX/hour = max allowed
    // ══════════════════════════════════════════════════════════════

    const pair_usdcx = config.swap.pair_b;
    const pair_ceth = config.swap.pair_ceth;
    const rateLimitWaitSec = config.swap.rate_limit_wait_seconds ?? 1860; // 31 minutes default

    // Helper: fetch pending rebates from leaderboard API
    async function fetchPendingRebates() {
        try {
            await session.ensureFreshTokens(walletApi, swapApi, log);
            const lb = await swapApi.getLeaderboard(session.partyId);
            const me = lb.requestedAddress || null;
            if (me) return parseFloat(me.rewardAccruedCc ?? 0);
        } catch { /* skip */ }
        return 0;
    }

    // Helper: execute one swap step
    async function doSwapStep(stepNum, fromPair, toPair, amount) {
        const decimals = fromPair.asset === 'CETH' ? 10 : 4;
        log(`\n Step ${stepNum}: ${amount.toFixed(decimals)} ${fromPair.label} → ${toPair.label}`);
        dashboard.update(index, { status: `S${stepNum} ${fromPair.label}→${toPair.label}` });

        await session.ensureFreshTokens(walletApi, swapApi, log);
        await resolveActiveOrder(ctx);

        const result = await executeSwap(ctx, {
            fromChain: fromPair.chain, fromAsset: fromPair.asset,
            toChain: toPair.chain, toAsset: toPair.asset,
            amount, fromLabel: fromPair.label, toLabel: toPair.label,
            instrumentAdminId: getInstrumentAdminId(holdingsCache, fromPair.asset),
        }, { pollTimeoutMinutes: 15 });

        if (!result || result.error) {
            log(` Step ${stepNum} failed: ${result?.message || 'unknown'}`);
            return null;
        }

        await sleep(5);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
        await sleep(3);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }

        try {
            const refreshed = await refreshAccountData(ctx);
            holdingsCache = refreshed || holdingsCache;
            ccBalance = getHoldingBal(refreshed, CC_ASSET_KEYS);
        } catch { /* use cached */ }

        const uBal = getHoldingBal(holdingsCache, USDCX_ASSET_KEYS);
        const cBal = getHoldingBal(holdingsCache, CETH_ASSET_KEYS);
        dashboard.update(index, { cc: ccBalance, usdcx: uBal, ceth: cBal, totalSwaps: totalSwaps + 1 });
        totalSwaps++;

        const recvDec = toPair.asset === 'CETH' ? 10 : 4;
        log(` Step ${stepNum} OK: +${parseFloat(result.receiveAmount || 0).toFixed(recvDec)} ${toPair.label} | CC:${ccBalance.toFixed(2)} USDCx:${uBal.toFixed(4)} CETH:${cBal.toFixed(10)}`);
        await sendSwapNotification(ctx, `S${stepNum}`, amount, result);

        return { result, ccBalance, usdcxBal: uBal, cethBal: cBal };
    }

    // Helper: do the 31-minute cooldown wait with countdown in dashboard
    async function doCooldownWait(reason) {
        const waitSec = rateLimitWaitSec;
        const waitMin = Math.round(waitSec / 60);
        log(`\n ${reason}: menunggu ${waitMin} menit...`);
        dashboard.update(index, { status: `cooldown ${waitMin}m` });
        await sleep(waitSec);
        log(` Cooldown selesai, lanjut swap...`);
    }

    // ══════════════════════════════════════════════════════
    // ── MULTI-MODE SWAP ENGINE (Mode 1-4)               ──
    // ══════════════════════════════════════════════════════

    const cooldownBetweenBatches = config.swap.cooldown_seconds ?? 1320;

    if (swapMode === 1 || swapMode === 2) {
        // ════════════════════════════════════════════════════
        // PING-PONG ENGINE (Mode 1: CCUSDCx, Mode 2: CCCETH)
        //
        // tx_per_cycle  → jumlah TX per window (dari config)
        // cooldown / TX → rate_limit_wait_seconds ÷ tx_per_cycle
        //
        // Contoh config:
        //   tx_per_cycle: 2, rate_limit_wait_seconds: 3600
        //   → 2 TX/jam, jeda 30 menit per TX
        //   → TX1: CC→USDCx  30m  TX2: USDCx→CC  30m  (next window)
        //
        //   tx_per_cycle: 3, rate_limit_wait_seconds: 3600
        //   → 3 TX/jam, jeda 20 menit per TX
        //   → TX1 20m  TX2 20m  TX3 20m  (next window)
        // ════════════════════════════════════════════════════
        const ppPairB = swapMode === 1 ? pair_usdcx : pair_ceth;
        const ppAssetKeys = swapMode === 1 ? USDCX_ASSET_KEYS : CETH_ASSET_KEYS;
        const ppMinBal = swapMode === 1 ? 1 : 0.0005;
        const ppLabel = swapMode === 1 ? 'USDCx' : 'CETH';
        const ppDecimals = swapMode === 1 ? 4 : 10;
        activePairMode = swapMode === 1 ? 'USDCX' : 'CETH';

        // ── Baca tx_per_cycle dari config (default 2) ──
        const txPerCycle = config.swap.tx_per_cycle ?? 2;
        const ppCooldownSec = Math.floor(rateLimitWaitSec / txPerCycle);
        const ppCooldownMin = Math.round(ppCooldownSec / 60);

        log(` Mode ${swapMode} Ping-Pong: ${txPerCycle} TX/window | cooldown ${ppCooldownMin}m per TX`);

        let ppWindow = 1;
        while (ppWindow <= rounds) {
            log('\n' + '═'.repeat(55));
            log(` WINDOW #${ppWindow}/${rounds} [${ppLabel} Ping-Pong | ${txPerCycle}TX | ${ppCooldownMin}m/TX]`);
            log('═'.repeat(55));

            for (let txIdx = 0; txIdx < txPerCycle; txIdx++) {
                await session.ensureFreshTokens(walletApi, swapApi, log);

                try {
                    const { holdings: h } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    ccBalance = getHoldingBal(h, CC_ASSET_KEYS);
                    holdingsCache = h || holdingsCache;
                } catch { /* cached */ }
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }

                const pairBBal = getHoldingBal(holdingsCache, ppAssetKeys);
                dashboard.update(index, {
                    cc: ccBalance,
                    usdcx: getHoldingBal(holdingsCache, USDCX_ASSET_KEYS),
                    ceth: getHoldingBal(holdingsCache, CETH_ASSET_KEYS),
                });

                if (ccBalance >= rewardThreshold) {
                    log(' Reward landed! CC(' + ccBalance.toFixed(2) + ') >= ' + rewardThreshold);
                    dashboard.update(index, { status: 'reward-landed', swap: false });
                    return;
                }

                log(`\n TX ${txIdx + 1}/${txPerCycle} | CC: ${ccBalance.toFixed(4)} | ${ppLabel}: ${pairBBal.toFixed(ppDecimals)}`);

                let stepFailed = false;
                const stepLabel = `${ppWindow}-${txIdx + 1}`;

                if (pairBBal >= ppMinBal) {
                    // Punya pair B → swap B→CC
                    log(` ${ppLabel}(${pairBBal.toFixed(ppDecimals)}) → CC`);
                    const s = await doSwapStep(stepLabel, ppPairB, pair_a, pairBBal);
                    if (!s) { stepFailed = true; }
                    else { ccBalance = s.ccBalance; }
                } else {
                    // Punya CC → swap CC→B
                    const swapAmt = await fetchDynamicMinSwap(swapApi, log);
                    if (ccBalance < swapAmt) {
                        log(` CC(${ccBalance.toFixed(2)}) < min(${swapAmt.toFixed(2)}), skip TX`);
                        stepFailed = true;
                    } else {
                        log(` CC(${ccBalance.toFixed(4)}) → ${ppLabel}`);
                        const s = await doSwapStep(stepLabel, pair_a, ppPairB, swapAmt);
                        if (!s) { stepFailed = true; }
                        else { ccBalance = s.ccBalance; }
                    }
                }

                if (stepFailed) {
                    log(` TX ${txIdx + 1}/${txPerCycle} gagal, tunggu 60s...`);
                    dashboard.update(index, { status: `failed TX ${txIdx + 1}/${txPerCycle}` });
                    await sleep(60);
                    // lanjut TX berikutnya dalam window yang sama (tidak reset window)
                    continue;
                }

                // ── Cooldown per TX (termasuk setelah TX terakhir) ──
                // Cooldown setelah TX terakhir = jeda sebelum window berikutnya
                log(`\n Cooldown TX ${txIdx + 1}/${txPerCycle}: ${ppCooldownMin} menit...`);
                dashboard.update(index, { status: `cd ${ppCooldownMin}m (TX ${txIdx + 1}/${txPerCycle})` });
                await sleep(ppCooldownSec);
                log(` Cooldown selesai`);
            }

            log(` Window #${ppWindow}/${rounds} selesai`);
            ppWindow++;
        }

    } else {
        // ════════════════════════════════════════════════════
        // TRIANGULAR ENGINE (Mode 3: 3TX, Mode 4: Configurable)
        // Chain: CC → USDCx → CETH → CC → ... (circular)
        // ════════════════════════════════════════════════════
        const schedule = swapMode === 3
            ? [2, 1]
            : (config.swap.swaps_per_window_schedule || [2, 3]);
        const totalTxPerCycle = schedule.reduce((a, b) => a + b, 0);

        const CHAIN = [
            { from: pair_a, to: pair_usdcx },
            { from: pair_usdcx, to: pair_ceth },
            { from: pair_ceth, to: pair_a },
        ];

        function detectChainPos(h) {
            const cBal = getHoldingBal(h, CETH_ASSET_KEYS);
            const uBal = getHoldingBal(h, USDCX_ASSET_KEYS);
            if (cBal >= 0.0005) return 2;
            if (uBal >= 1) return 1;
            return 0;
        }

        async function getSwapAmtForPos(pos, h) {
            const idx = pos % 3;
            if (idx === 0) return await fetchDynamicMinSwap(swapApi, log);
            if (idx === 1) return getHoldingBal(h, USDCX_ASSET_KEYS);
            return getHoldingBal(h, CETH_ASSET_KEYS);
        }

        function getMinBalForPos(pos) {
            const idx = pos % 3;
            if (idx === 0) return 0;
            if (idx === 1) return 1;
            return 0.0005;
        }

        let cycle = 1;
        let isRetry = false;
        let rebatesBefore = 0;
        let ccCycleStart = 0;
        let cycleStartMs_saved = 0;

        while (cycle <= rounds) {
            await session.ensureFreshTokens(walletApi, swapApi, log);

            try {
                const { holdings: h } = await session.withRetry(
                    () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                );
                ccBalance = getHoldingBal(h, CC_ASSET_KEYS);
                holdingsCache = h || holdingsCache;
            } catch { /* cached */ }
            try { await acceptPendingOffers(ctx); } catch { /* ignore */ }

            let usdcxBal = getHoldingBal(holdingsCache, USDCX_ASSET_KEYS);
            let cethBal = getHoldingBal(holdingsCache, CETH_ASSET_KEYS);
            dashboard.update(index, { cc: ccBalance, usdcx: usdcxBal, ceth: cethBal });

            if (ccBalance >= rewardThreshold) {
                log(' Reward landed! CC(' + ccBalance.toFixed(2) + ') >= ' + rewardThreshold);
                dashboard.update(index, { status: 'reward-landed', swap: false });
                return;
            }

            if (!isRetry) rebatesBefore = await fetchPendingRebates();

            log('\n' + '═'.repeat(55));
            log(' SIKLUS #' + cycle + '/' + rounds + ' ' + (isRetry ? '(RETRY)' : '') + ' [' + totalTxPerCycle + 'TX: batch ' + schedule.join('+') + ']');
            log('═'.repeat(55));
            log(' CC: ' + ccBalance.toFixed(4) + ' | USDCx: ' + usdcxBal.toFixed(4) + ' | CETH: ' + cethBal.toFixed(10));
            log(' Rebates Before: ' + rebatesBefore.toFixed(4) + ' CC');

            let chainPos = detectChainPos(holdingsCache);
            const posNames = ['CC→USDCx', 'USDCx→CETH', 'CETH→CC'];
            log(' Start posisi ' + chainPos + ': ' + posNames[chainPos]);

            if (!isRetry) {
                ccCycleStart = ccBalance;
                cycleStartMs_saved = Date.now();
            }
            let stepFailed = false;
            let stepCounter = 0;

            for (let batchIdx = 0; batchIdx < schedule.length && !stepFailed; batchIdx++) {
                const batchSize = schedule[batchIdx];
                log('\n Batch ' + (batchIdx + 1) + '/' + schedule.length + ' (' + batchSize + ' TX)');

                for (let s = 0; s < batchSize && !stepFailed; s++) {
                    stepCounter++;
                    const step = CHAIN[chainPos % 3];

                    // Refresh balance before each step
                    try {
                        const { holdings: h } = await session.withRetry(
                            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                        );
                        ccBalance = getHoldingBal(h, CC_ASSET_KEYS);
                        usdcxBal = getHoldingBal(h, USDCX_ASSET_KEYS);
                        cethBal = getHoldingBal(h, CETH_ASSET_KEYS);
                        holdingsCache = h || holdingsCache;
                    } catch { /* cached */ }

                    const swapAmount = await getSwapAmtForPos(chainPos, holdingsCache);
                    const minBal = getMinBalForPos(chainPos);

                    // Check minimum balance
                    if (chainPos % 3 === 0) {
                        if (ccBalance < swapAmount) {
                            log(' CC(' + ccBalance.toFixed(2) + ') < min(' + swapAmount.toFixed(2) + '), skip');
                            stepFailed = true;
                            break;
                        }
                    } else {
                        if (swapAmount < minBal) {
                            const dec = chainPos % 3 === 2 ? 10 : 4;
                            log(' ' + step.from.label + '(' + swapAmount.toFixed(dec) + ') < min, skip');
                            stepFailed = true;
                            break;
                        }
                    }

                    const result = await doSwapStep(stepCounter, step.from, step.to, swapAmount);
                    if (!result) {
                        stepFailed = true;
                        break;
                    }

                    ccBalance = result.ccBalance;
                    usdcxBal = result.usdcxBal;
                    cethBal = result.cethBal;
                    chainPos++;
                }

                // Cooldown between batches (not after last batch)
                if (!stepFailed && batchIdx < schedule.length - 1) {
                    const cdMin = Math.round(cooldownBetweenBatches / 60);
                    log('\n Cooldown antar batch: ' + cdMin + ' menit...');
                    dashboard.update(index, { status: 'cooldown ' + cdMin + 'm' });
                    await sleep(cooldownBetweenBatches);
                    log(' Cooldown selesai');
                }
            }

            // Handle step failure → retry same cycle
            if (stepFailed) {
                log(' Step gagal, tunggu 60s sebelum retry...');
                dashboard.update(index, { status: 'failed retry cycle ' + cycle });
                isRetry = true;
                await sleep(60);
                continue;
            }

            // ── P/L Calculation ──
            let rebatesAfter = rebatesBefore;
            for (let rp = 1; rp <= 5; rp++) {
                const val = await fetchPendingRebates();
                if (val > rebatesBefore) {
                    rebatesAfter = val;
                    log(' Rebates updated: ' + val.toFixed(4) + ' CC (poll ' + rp + ')');
                    break;
                }
                if (rp < 5) {
                    log(' Rebates belum update (' + rp + '/5), tunggu 30s...');
                    await sleep(30);
                }
            }

            const spreadLoss = ccCycleStart - ccBalance;
            const rewardGain = rebatesAfter - rebatesBefore;
            const netPL = rewardGain - spreadLoss;
            const plIcon = netPL >= 0 ? '' : '';

            log('\n SIKLUS #' + cycle + ' SELESAI');
            log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            log(' CC Awal       : ' + ccCycleStart.toFixed(4));
            log(' CC Sisa       : ' + ccBalance.toFixed(4));
            log(' Spread Loss   : -' + spreadLoss.toFixed(4) + ' CC');
            log(' Rebates Before: ' + rebatesBefore.toFixed(4) + ' CC');
            log(' Rebates After : ' + rebatesAfter.toFixed(4) + ' CC');
            log(' Reward Gained : +' + rewardGain.toFixed(4) + ' CC');
            log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            log(plIcon + ' Net P/L: ' + (netPL >= 0 ? '+' : '') + netPL.toFixed(4) + ' CC (' + (netPL >= 0 ? 'UNTUNG' : 'RUGI') + ')');

            await sendCycleNotification(ctx, cycle, rounds, {
                ccCycleStart, ccCycleEnd: ccBalance, spreadLoss,
                rebatesBefore, rebatesAfter, rewardGain, netPL,
                stepFailed, totalSwaps,
            });

            isRetry = false;

            // Smart cooldown: wait remaining time to fill 1 hour from cycle start
            if (cycle < rounds) {
                const cycleElapsedSec = Math.floor((Date.now() - cycleStartMs_saved) / 1000);
                const targetCycleSec = rateLimitWaitSec; // 3600s = 60 min
                const remainingSec = Math.max(60, targetCycleSec - cycleElapsedSec); // min 60s
                const remainingMin = Math.round(remainingSec / 60);
                const elapsedMin = Math.round(cycleElapsedSec / 60);
                log('\n Siklus selesai dalam ' + elapsedMin + 'm, tunggu ' + remainingMin + 'm untuk genap ' + Math.round(targetCycleSec / 60) + 'm...');
                dashboard.update(index, { status: 'cycle-wait ' + remainingMin + 'm' });
                await sleep(remainingSec);
                log(' Cooldown selesai, mulai siklus baru');
            }
            cycle++;
        }
    }

    // ── Final Cleanup ──
    dashboard.update(index, { status: 'final cleanup' });
    await session.ensureFreshTokens(walletApi, swapApi, log);
    try {
        const { holdings: h } = await session.withRetry(
            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
        );
        holdingsCache = h || holdingsCache;
        const finalUsdcx = getHoldingBal(h, USDCX_ASSET_KEYS);
        const finalCeth = getHoldingBal(h, CETH_ASSET_KEYS);

        if (finalUsdcx >= 1) {
            log(' Final: ' + finalUsdcx.toFixed(4) + ' USDCx → CC');
            await doSwapStep('F1', pair_usdcx, pair_a, finalUsdcx);
        }
        if (finalCeth >= 0.0005) {
            log(' Final: ' + finalCeth.toFixed(10) + ' CETH → CC');
            await doSwapStep('F2', pair_ceth, pair_a, finalCeth);
        }
    } catch (err) {
        log(' Final cleanup: ' + formatError(err));
    }

    await refreshAccountData(ctx);
    log(' Done! ' + totalSwaps + ' swaps across ' + rounds + ' siklus');
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

    log(` ${offers.length} offer(s)`);

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
                log(` Accept ${amount} ${instrumentId}`);
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
                        log(` Accept ${amount} ${instrumentId}`);
                    }
                }
            }
        } catch (err) {
            log(` Offer: ${formatError(err)}`);
        }
    }
}

// ── Execute Single Swap ──────────────────────────────────────────────────

async function executeSwap(ctx, { fromChain, fromAsset, toChain, toAsset, amount, fromLabel, toLabel, instrumentAdminId }, opts = {}) {
    const { session, walletApi, swapApi, log } = ctx;
    const { pollTimeoutMinutes } = opts;

    try {
        log(` Quote ${parseFloat(amount).toFixed(2)} ${fromLabel}→${toLabel}...`);
        const quote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
        const _dec = (toAsset === 'CETH' || fromAsset === 'CETH') ? 10 : 4;
        log(` ${parseFloat(quote.sendAmount).toFixed(2)}→${parseFloat(quote.receiveAmount).toFixed(_dec)} @${parseFloat(quote.rate).toFixed(_dec)}`);

        let orderId = generateOrderId();
        log(` Order ${shortId(orderId)}`);
        let order;
        try {
            order = await session.withRetry(
                () => swapApi.createOrder(session.swapToken, orderId, quote.quoteId, session.partyId), 'swap', walletApi, swapApi, log
            );
        } catch (createErr) {
            const errStatus = createErr.response?.status;
            const errDetail = String(createErr.response?.data?.detail || createErr.response?.data?.message || '');

            // Handle 422 "Account setup not complete"
            if (errStatus === 422 && errDetail.includes('Account setup not complete')) {
                log(` Account setup not complete, retrying createOrder with delays...`);
                let setupRetrySuccess = false;
                for (let setupRetry = 1; setupRetry <= 10; setupRetry++) {
                    log(` Setup retry ${setupRetry}/10, wait 30s...`);
                    await sleep(30);
                    try {
                        await session.ensureFreshTokens(walletApi, swapApi, log);
                        const freshQuote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
                        Object.assign(quote, freshQuote);
                        const freshOrderId = generateOrderId();
                        order = await swapApi.createOrder(session.swapToken, freshOrderId, freshQuote.quoteId, session.partyId);
                        orderId = freshOrderId;
                        log(` Order ${shortId(orderId)} (setup retry #${setupRetry})`);
                        setupRetrySuccess = true;
                        break;
                    } catch (setupErr) {
                        const setupMsg = String(setupErr.response?.data?.detail || setupErr.response?.data?.message || '');
                        if (setupErr.response?.status === 422 && setupMsg.includes('Account setup not complete')) {
                            log(` Still pending... (${setupRetry}/10)`);
                            continue;
                        }
                        // Different error — re-throw to outer handler
                        throw setupErr;
                    }
                }
                if (!setupRetrySuccess) {
                    // Exhausted 10 retries (~5 min) — soft restart this account
                    log(` Setup still pending after 10 retries → soft restart`);
                    const softErr = new Error('SETUP_TIMEOUT');
                    softErr.response = { status: 500 };
                    throw softErr;
                }
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

                log(` Active order ${shortId(staleId)}, resolving...`);

                let cancelled = false;
                try {
                    await swapApi.cancelOrder(session.swapToken, staleId);
                    cancelled = true;
                    log(` Cancelled ${shortId(staleId)}`);
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
                            log(` ${shortId(staleId)} → ${check.status}`);
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
                const newQuote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
                Object.assign(quote, newQuote);
                order = await swapApi.createOrder(session.swapToken, orderId, newQuote.quoteId, session.partyId);
            }
            // Handle generic 422 (not setup-related)
            // ── Fast path: quote expired → fetch fresh quote IMMEDIATELY, no delay ──
            // ── Slow path: escalating retry 15/30/60s for other 422 reasons        ──
            else if (errStatus === 422 || errStatus === 410 || errStatus >= 500) {
                const errMsg = createErr.response?.data?.detail || createErr.response?.data?.message || 'Unknown';
                const errMsgStr = typeof errMsg === 'object' ? JSON.stringify(errMsg) : String(errMsg);
                log(` [${errStatus}] ${errMsgStr}`);

                // Detect quote-expired / quote-invalid (no delay needed, just fetch new quote)
                // 410 Gone = always quote expired
                const isQuoteExpired = errStatus === 410
                    || /quote.*(expired|invalid|not.?found|stale)/i.test(errMsgStr)
                    || /expired.*quote/i.test(errMsgStr);

                if (isQuoteExpired) {
                    log(` Quote expired → fetch fresh quote immediately (step lanjut, tidak restart)...`);
                    try {
                        await session.ensureFreshTokens(walletApi, swapApi, log);
                        const freshQuote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
                        Object.assign(quote, freshQuote);
                        const freshOrderId = generateOrderId();
                        order = await swapApi.createOrder(session.swapToken, freshOrderId, freshQuote.quoteId, session.partyId);
                        orderId = freshOrderId;
                        log(` Order ${shortId(orderId)} (fresh quote → lanjut step)`);
                        // order berhasil dibuat → fall-through ke prepareTransfer, tidak restart
                    } catch (freshErr) {
                        // Fast path gagal → fall into escalating retry below
                        log(` Fresh quote retry gagal: ${formatError(freshErr)}, escalating...`);
                    }
                }

                // ── Escalating retry (only if order still not set) ──
                if (!order) {
                    const rejectedDelays = config.retry?.server_rejected_delays || [15, 30, 60];
                    const max422Retries = config.retry?.max_422_retries ?? 3;
                    for (let rejAttempt = 0; rejAttempt < max422Retries; rejAttempt++) {
                        const delay = getEscalatingDelay(rejAttempt, rejectedDelays);
                        log(` [${errStatus}] wait ${delay}s (#${rejAttempt + 1}/${max422Retries})`);
                        await sleep(delay);
                        try {
                            await session.ensureFreshTokens(walletApi, swapApi, log);
                            const newQuote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
                            Object.assign(quote, newQuote);
                            const newOrderId = generateOrderId();
                            order = await swapApi.createOrder(session.swapToken, newOrderId, newQuote.quoteId, session.partyId);
                            orderId = newOrderId;
                            log(` Order ${shortId(orderId)} (retry)`);
                            break;
                        } catch (retryErr) {
                            const retryStatus = retryErr.response?.status;
                            if (retryStatus === 422 || retryStatus === 410 || retryStatus >= 500) {
                                const retryMsg = retryErr.response?.data?.detail || retryErr.response?.data?.message || retryErr.response?.data || 'Unknown';
                                log(` [${retryStatus}] ${typeof retryMsg === 'object' ? JSON.stringify(retryMsg) : retryMsg}`);
                                if (String(retryMsg).includes('Account setup not complete')) {
                                    await waitForAccountSetup(swapApi, session.swapToken, session.partyId, log);
                                }
                                if (rejAttempt >= max422Retries - 1) {
                                    log(` [${retryStatus}] ${max422Retries}x failed → soft restart`);
                                    const softRestartErr = new Error('422_SOFT_RESTART');
                                    softRestartErr.response = { status: 500 };
                                    throw softRestartErr;
                                }
                                continue;
                            }
                            throw retryErr;
                        }
                    }
                    // If loop finished without order being set, trigger soft restart
                    if (!order) {
                        log(` [${errStatus}] exhausted retries → soft restart`);
                        const softRestartErr = new Error('422_SOFT_RESTART');
                        softRestartErr.response = { status: 500 };
                        throw softRestartErr;
                    }
                }
            } else {
                throw createErr;
            }
        }

        log(` Order ${shortId(orderId)} created`);

        const instrumentId = ASSET_TO_INSTRUMENT[fromAsset] || fromAsset;
        log(` Transfer ${order.requiredAmount} ${instrumentId}`);
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
            log(' Missing prepared_tx_b64 or hash_b64');
            return false;
        }

        log(' Signing & executing transfer...');
        const signature = signMessage(session.keyPair.privateKey, Buffer.from(hashB64, 'base64'));
        await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
            commandId, preparedTxB64,
            signatureB64: toBase64(signature),
            hashingSchemeVersion,
        }), 'wallet', walletApi, swapApi, log);

        // Poll transfer/status until confirmed (HAR flow)
        log(' Waiting for deposit confirmation...');
        for (let ts = 0; ts < 20; ts++) {
            await sleep(3);
            try {
                const txStatus = await walletApi.getTransferStatus(session.walletToken, commandId);
                if (txStatus.status === 'success') {
                    log(' Deposit confirmed on-chain');
                    break;
                }
            } catch { /* continue polling */ }
        }

        log(' Polling order status...');

        await sleep(3);
        const finalStatus = await pollOrderStatus(ctx, orderId, pollTimeoutMinutes, toAsset);

        if (finalStatus === 'COMPLETED' || finalStatus === 'WALLET_CONFIRMED') {
            log(' Swap completed!');
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

            // Fetch final order data for TX details
            let userTxId = '', solverTxId = '', fee = 0;
            try {
                const orderData = await swapApi.getOrderStatus(session.swapToken, orderId);
                userTxId = orderData.userTxId || orderData.user_tx_id || orderData.depositTxId || '';
                solverTxId = orderData.solverTxId || orderData.solver_tx_id || orderData.withdrawTxId || '';
                fee = parseFloat(orderData.fee || orderData.networkFee || 0);
            } catch { /* skip */ }

            return {
                receiveAmount: quote.receiveAmount,
                sendAmount: quote.sendAmount,
                rate: quote.rate,
                orderId, commandId,
                slippageBps: 200,
                userTxId, solverTxId, fee,
            };
        } else if (finalStatus === 'TIMEOUT') {
            log(` Timeout ${pollTimeoutMinutes}m`);
            try { await swapApi.cancelOrder(session.swapToken, orderId); } catch { /* ignore */ }
            return false;
        } else {
            log(` Swap: ${finalStatus}`);
            return false;
        }

    } catch (err) {
        const errMsg = formatError(err);
        log(` ${errMsg}`);
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
    const ICONS = { COMPLETED: '', FAILED: '', CANCELLED: '', FUNDED: '', EXECUTING: '', PROCESSING: '', WITHDRAWING: '', AWAITING_DEPOSIT: '' };
    const maxPolls = maxMinutes > 0 ? Math.ceil(maxMinutes * 60 / 5) : Infinity;

    let preSwapBalance = null;
    if (toAsset) {
        try {
            const { holdings = {} } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            const assetNames = toAsset === '0x0' ? ['Amulet', 'CC (Amulet)', 'CC'] : toAsset === 'CETH' ? ['cETH', 'CETH'] : ['USDCx', 'USDCX'];
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
            const assetNames = toAsset === '0x0' ? ['Amulet', 'CC (Amulet)', 'CC'] : toAsset === 'CETH' ? ['cETH', 'CETH'] : ['USDCx', 'USDCX'];
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
                const icon = ICONS[status] || '';
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
            log(` Poll error (${consecutiveNetErrors}/${MAX_CONSECUTIVE_NET_ERRORS}): ${errDetail}`);

            // Check wallet early if we're getting repeated errors
            if (consecutiveNetErrors >= 3 && consecutiveNetErrors % 2 === 1) {
                if (await walletSideCheck()) {
                    log(` Wallet confirmed despite poll errors`);
                    return 'WALLET_CONFIRMED';
                }
            }

            if (consecutiveNetErrors >= MAX_CONSECUTIVE_NET_ERRORS) {
                log(` Too many poll errors, final wallet check...`);
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

    console.log(chalk.gray('   Fetching proxy IPs...'));
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
    console.log(chalk.gray(`   Proxy IPs saved to proxy_ips.txt\n`));
}


// ── Menu Selection ───────────────────────────────────────────────────────

async function showMenu() {
    const defaultMode = config.swap?.swap_mode ?? 4;
    const schedule = config.swap?.swaps_per_window_schedule || [2, 3];
    const cdMin = Math.round((config.swap?.cooldown_seconds ?? 1320) / 60);
    const rlSec = config.swap?.rate_limit_wait_seconds ?? 1860;
    const txPerCycle = config.swap?.tx_per_cycle ?? 2;
    const totalTx = schedule.reduce((a, b) => a + b, 0);
    const ppCooldownMin = Math.round(rlSec / txPerCycle / 60); // per-TX cooldown for Mode 1/2

    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });

        const c = chalk.hex('#555');
        const W = 54;
        console.log('');
        console.log(c(`  \u250c${'─'.repeat(W)}\u2510`));
        console.log(c(`  \u2502`) + centerToWidth(chalk.bold.hex('#67E8F9')('Cantor8 Bot V2 -- Pilih Mode Swap'), W) + c('\u2502'));
        console.log(c(`  \u251c${'─'.repeat(W)}\u2524`));
        console.log(c(`  \u2502`) + fitToWidth(` ${chalk.hex('#6EE7B7')('1.')} CC <> USDCx   (${txPerCycle}TX/window, cd ${ppCooldownMin}m/TX)`, W) + c('\u2502'));
        console.log(c(`  \u2502`) + fitToWidth(` ${chalk.hex('#6EE7B7')('2.')} CC <> CETH    (${txPerCycle}TX/window, cd ${ppCooldownMin}m/TX)`, W) + c('\u2502'));
        console.log(c(`  \u2502`) + fitToWidth(` ${chalk.hex('#6EE7B7')('3.')} Triangular   (CC>USDCx>CETH>CC) 3TX`, W) + c('\u2502'));
        console.log(c(`  \u2502`) + fitToWidth(` ${chalk.hex('#6EE7B7')('4.')} Extended     (${totalTx}TX/cycle, batch ${schedule.join('+')}, cd ${cdMin}m)`, W) + c('\u2502'));
        console.log(c(`  \u251c${'─'.repeat(W)}\u2524`));
        console.log(c(`  \u2502`) + fitToWidth(chalk.gray(` Default: [${defaultMode}] -- tekan Enter = pakai default`), W) + c('\u2502'));
        console.log(c(`  \u2514${'─'.repeat(W)}\u2518`));
        console.log('');

        rl.question(chalk.yellow('  Pilih mode (1-4): '), (answer) => {
            rl.close();
            const mode = parseInt(answer) || defaultMode;
            if (mode >= 1 && mode <= 4) {
                resolve(mode);
            } else {
                console.log(chalk.red('   Invalid, using default: ' + defaultMode));
                resolve(defaultMode);
            }
        });
    });
}
// ── Main Entry Point ─────────────────────────────────────────────────────

async function main() {
    const accounts = config.accounts || [];

    if (!accounts.length) {
        console.error(chalk.red(' No accounts configured in config.json'));
        process.exit(1);
    }

    process.stdout.write('\x1B[H\x1B[2J');
    console.log(chalk.cyan.bold(`   CANTOR8 MULTI-ACCOUNT BOT V2 — ${accounts.length} account(s)\n`));

    // ── Mode Selection ──
    swapMode = await showMenu();
    activePairMode = 'USDCX';

    const _txPerCycle = config.swap.tx_per_cycle ?? 2;
    const _rlSec = config.swap.rate_limit_wait_seconds ?? 1860;
    const _ppCdMin = Math.round(_rlSec / _txPerCycle / 60);
    const _schedule = config.swap.swaps_per_window_schedule || [2, 3];
    const _cdMin = Math.round((config.swap.cooldown_seconds ?? 1320) / 60);
    const _rlMin = Math.round(_rlSec / 60);
    const modeNames = {
        1: `CC  USDCx Ping-Pong (${_txPerCycle}TX/window, ${_ppCdMin}m/TX)`,
        2: `CC  CETH  Ping-Pong (${_txPerCycle}TX/window, ${_ppCdMin}m/TX)`,
        3: 'Triangular (CC→USDCx→CETH→CC) 3TX',
        4: 'Extended (' + String(_schedule.reduce((a, b) => a + b, 0)) + 'TX/cycle, batch ' + _schedule.join('+') + ', cd ' + _cdMin + 'm)',
    };
    console.log(chalk.green.bold('\n   Mode ' + swapMode + ': ' + modeNames[swapMode]));
    if (swapMode === 1 || swapMode === 2) {
        console.log(chalk.gray(`   Cooldown: ${_ppCdMin}m per TX | window=${_rlMin}m | tx_per_cycle=${_txPerCycle}\n`));
    } else {
        console.log(chalk.gray('   Cooldown: batch=' + _cdMin + 'm | siklus=' + _rlMin + 'm\n'));
    }
    await fetchAndLogProxyIps(accounts);

    dashboard.init(accounts);
    dashboard.startAutoRefresh();

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
    console.log(chalk.gray(`   Stagger plan:`));
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

    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    console.log(chalk.bold.green(`\n   All done: ${ok} ok, ${fail} fail\n`));
}

// ── Graceful Shutdown (Ctrl+C) ───────────────────────────────────────────
process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\n    Ctrl+C detected, shutting down...\n'));
    dashboard.stop();
    process.exit(0);
});
process.on('SIGTERM', () => {
    dashboard.stop();
    process.exit(0);
});

main();
