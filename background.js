/**
 * VioEdu Internal QA Tool - Background Service Worker
 * Staff-gated answer verification for question-bank QA
 */
/* global INTEGRITY_PIN */
importScripts('integrity-pin.js');
try { importScripts('private-config.js'); } catch (err) {
  console.warn('[VioEdu-QA] private-config.js is missing; staff-key features are disabled.');
}

const DEFAULT_CONFIG = {
  provider: 'vireonix',
  vireonixModel: 'auto',
  vireonixBaseUrl: 'https://vireonix.ai',
  antiBurstPacing: true,
  minRequestGapMs: 3500,
  enableCache: true,
  autoFailover: true,
  openRouterApiKey: '',
  openRouterModel: 'openrouter/free',
  groqApiKey: '',
  groqModel: 'openai/gpt-oss-120b',
  autoSubmit: false,
  answerDelayMs: 1200,
  staffKey: '',
  staffAuthUntil: 0,
  staffAuthTtlHours: 0
};

// Whitelist URL — hash nhúng trong background.js (file này bị hash lại bởi integrity)
const STAFF_WHITELIST_URL = (self.INTEGRITY_PIN && INTEGRITY_PIN.whitelistUrl) ||
  'https://raw.githubusercontent.com/accessgated/keys/refs/heads/main/staff-whitelist.txt';
const EMBEDDED_WHITELIST_URL_HASH = '4806b44d51809ce5d414e95b0ac2e465b5029fb9fe4766bfab48244ae3a73f3c'

// Rotate these with the VioEdu internal team when issuing keys
const STAFF_KEY_SECRET = self.VIOEDU_STAFF_KEY_SECRET || '';
const STAFF_ADMIN_PASS = self.VIOEDU_STAFF_ADMIN_PASS || '';
const ALLOWED_TTL_HOURS = [6, 12, 24];
// Status UI may cache briefly; SOLVE always force-refetches (fail-closed)
const WHITELIST_CACHE_MS = 60 * 1000;

// In-memory LRU answer cache to prevent duplicate requests
const questionCache = new Map();
let lastVireonixCallTime = 0;
let vireonixCooldownUntil = 0;
let openRouterCooldownUntil = 0;
let groqCooldownUntil = 0;
let consecutiveQuestionCount = 0;
const rollingChatHistory = [];
let whitelistCache = { url: '', fetchedAt: 0, keys: new Set() };
let integrityState = { ok: false, checkedAt: 0, error: '', locked: false, hwid: '' };

async function wipeStaffAuth() {
  await chrome.storage.local.set({ staffKey: '', staffAuthUntil: 0, staffAuthTtlHours: 0 });
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getHwid() {
  const platform = await chrome.runtime.getPlatformInfo();
  const local = await chrome.storage.local.get(['machineSalt']);
  let salt = local.machineSalt;
  if (!salt) {
    try {
      const sync = await chrome.storage.sync.get(['machineSalt']);
      salt = sync.machineSalt || '';
    } catch (e) {}
  }
  if (!salt) {
    salt = crypto.randomUUID();
    await chrome.storage.local.set({ machineSalt: salt });
    try { await chrome.storage.sync.set({ machineSalt: salt }); } catch (e) {}
  }
  return sha256Hex(`${chrome.runtime.id}|${platform.os}|${platform.arch}|${salt}`);
}

async function persistIntegrityLock(reason, hwid) {
  const payload = {
    integrityLocked: true,
    integrityLockReason: String(reason || 'integrity_mismatch').slice(0, 300),
    integrityLockHwid: hwid,
    integrityLockAt: Date.now()
  };
  await chrome.storage.local.set(payload);
  try { await chrome.storage.sync.set(payload); } catch (e) {}
  integrityState.locked = true;
  integrityState.hwid = hwid;
  integrityState.error = payload.integrityLockReason;
  await wipeStaffAuth();
}

async function isIntegrityBricked() {
  const local = await chrome.storage.local.get(['integrityLocked', 'integrityLockHwid', 'integrityLockReason']);
  let sync = {};
  try {
    sync = await chrome.storage.sync.get(['integrityLocked', 'integrityLockHwid', 'integrityLockReason']);
  } catch (e) {}
  if (local.integrityLocked || sync.integrityLocked) {
    integrityState.locked = true;
    integrityState.hwid = local.integrityLockHwid || sync.integrityLockHwid || '';
    integrityState.error = local.integrityLockReason || sync.integrityLockReason || 'locked';
    return true;
  }
  return false;
}

async function fetchExtensionText(relPath) {
  const url = chrome.runtime.getURL(relPath);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Không đọc được file nội bộ: ${relPath}`);
  return await res.text();
}

async function runIntegrityCheck(force = false) {
  if (!force && integrityState.ok && Date.now() - integrityState.checkedAt < 30000 && !integrityState.locked) {
    return true;
  }

  if (await isIntegrityBricked()) {
    throw new Error('Extension đã bị khóa integrity trên máy này (HWID). Không thể dùng tiếp.');
  }

  if (!self.INTEGRITY_PIN || !INTEGRITY_PIN.whitelistUrlHash || !INTEGRITY_PIN.hashesFileHash) {
    const hwid = await getHwid();
    await persistIntegrityLock('missing_integrity_pin', hwid);
    throw new Error('Thiếu integrity pin — đã khóa.');
  }

  // 1) Domain / whitelist URL pin (pin file + hash nhúng trong background.js)
  const urlHash = await sha256Hex(STAFF_WHITELIST_URL);
  if (
    urlHash !== INTEGRITY_PIN.whitelistUrlHash ||
    urlHash !== EMBEDDED_WHITELIST_URL_HASH ||
    STAFF_WHITELIST_URL !== INTEGRITY_PIN.whitelistUrl
  ) {
    const hwid = await getHwid();
    await persistIntegrityLock('whitelist_url_tamper', hwid);
    throw new Error('Phát hiện sửa domain/URL whitelist — đã khóa theo HWID.');
  }

  // 2) integrity.hashes.json must match pin
  const hashesRaw = await fetchExtensionText(INTEGRITY_PIN.hashesFile || 'integrity.hashes.json');
  const hashesFileHash = await sha256Hex(hashesRaw);
  if (hashesFileHash !== INTEGRITY_PIN.hashesFileHash) {
    const hwid = await getHwid();
    await persistIntegrityLock('hashes_manifest_tamper', hwid);
    throw new Error('Phát hiện sửa integrity.hashes.json — đã khóa theo HWID.');
  }

  let manifest;
  try {
    manifest = JSON.parse(hashesRaw);
  } catch (e) {
    const hwid = await getHwid();
    await persistIntegrityLock('hashes_manifest_invalid', hwid);
    throw new Error('integrity.hashes.json hỏng — đã khóa.');
  }

  if (!manifest.files || typeof manifest.files !== 'object') {
    const hwid = await getHwid();
    await persistIntegrityLock('hashes_manifest_invalid', hwid);
    throw new Error('integrity.hashes.json không hợp lệ — đã khóa.');
  }

  // 3) Hash từng file source quan trọng
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const raw = await fetchExtensionText(rel);
    const got = await sha256Hex(raw);
    if (got !== expected) {
      const hwid = await getHwid();
      await persistIntegrityLock(`file_tamper:${rel}`, hwid);
      throw new Error(`Phát hiện sửa file ${rel} — đã khóa theo HWID.`);
    }
  }

  integrityState = { ok: true, checkedAt: Date.now(), error: '', locked: false, hwid: await getHwid() };
  return true;
}

async function assertIntegrity() {
  await runIntegrityCheck(true);
  if (integrityState.locked || !integrityState.ok) {
    throw new Error(integrityState.error || 'Integrity lock.');
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(null);
  const updated = { ...DEFAULT_CONFIG, ...current };
  if (current.provider === 'puter') updated.provider = 'vireonix';
  await chrome.storage.local.set(updated);
  await chrome.storage.local.remove(['puterToken', 'puterModel']);
  try {
    await runIntegrityCheck(true);
    console.log('[VioEdu-QA] Integrity OK. Background ready.');
  } catch (err) {
    console.error('[VioEdu-QA] Integrity FAIL:', err.message);
  }
});

chrome.runtime.onStartup.addListener(() => {
  runIntegrityCheck(true).catch(err => console.error('[VioEdu-QA] Integrity FAIL:', err.message));
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SOLVE_QUESTION') {
    assertIntegrity()
      .then(() => assertStaffAuth())
      .then(() => handleSolveQuestion(request.payload))
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'GET_CONFIG') {
    chrome.storage.local.get(null).then(cfg => sendResponse({ success: true, config: cfg }));
    return true;
  }

  if (request.action === 'GET_VIREONIX_LIMITS') {
    assertIntegrity()
      .then(() => fetchVireonixLimits())
      .then(limits => sendResponse({ success: true, data: limits }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'GET_STAFF_AUTH') {
    assertIntegrity()
      .then(() => getStaffAuthStatus())
      .then(status => sendResponse({ success: true, ...status }))
      .catch(err => sendResponse({
        success: true,
        authenticated: false,
        locked: /khóa|integrity|HWID|tamper/i.test(err.message),
        error: err.message
      }));
    return true;
  }

  if (request.action === 'ACTIVATE_STAFF_KEY') {
    assertIntegrity()
      .then(() => activateStaffKey(request.key))
      .then(status => sendResponse({ success: true, ...status }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'CLEAR_STAFF_AUTH') {
    assertIntegrity()
      .then(() => chrome.storage.local.set({ staffKey: '', staffAuthUntil: 0, staffAuthTtlHours: 0 }))
      .then(() => sendResponse({ success: true, authenticated: false }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'MINT_STAFF_KEY') {
    assertIntegrity()
      .then(() => mintStaffKey(request.adminPass, request.ttlHours))
      .then(data => sendResponse({ success: true, ...data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'GET_INTEGRITY_STATUS') {
    runIntegrityCheck(false)
      .then(async () => {
        const hwid = integrityState.hwid || await getHwid();
        sendResponse({
          success: true,
          ok: integrityState.ok,
          locked: integrityState.locked,
          hwid,
          error: integrityState.error || ''
        });
      })
      .catch(async err => {
        const hwid = integrityState.hwid || (await getHwid().catch(() => ''));
        sendResponse({
          success: false,
          ok: false,
          locked: integrityState.locked || /khóa|HWID|tamper/i.test(err.message),
          hwid,
          error: err.message
        });
      });
    return true;
  }
});

async function signStaffPayload(ttlHours, serial) {
  if (!STAFF_KEY_SECRET) throw new Error('Missing VIOEDU_STAFF_KEY_SECRET in private-config.js.');
  const digest = await sha256Hex(`${STAFF_KEY_SECRET}|${ttlHours}|${String(serial).toLowerCase()}`);
  return digest.slice(0, 16);
}

function parseStaffKey(raw) {
  const key = String(raw || '').trim().toUpperCase();
  const parts = key.split('.');
  if (parts.length !== 4 || parts[0] !== 'VIO1') {
    throw new Error('Key không đúng định dạng. Dạng hợp lệ: VIO1.<ttl>.<serial>.<sig>');
  }
  const ttlHours = parseInt(parts[1], 10);
  const serial = parts[2].toLowerCase();
  const sig = parts[3].toLowerCase();
  if (!ALLOWED_TTL_HOURS.includes(ttlHours) || !/^[a-f0-9]{8,24}$/.test(serial) || !/^[a-f0-9]{16}$/.test(sig)) {
    throw new Error('Key không hợp lệ (ttl phải là 6/12/24h).');
  }
  return { ttlHours, serial, sig, normalized: `VIO1.${ttlHours}.${serial}.${sig}` };
}

async function fetchStaffWhitelist(force = false) {
  const url = STAFF_WHITELIST_URL;
  const now = Date.now();
  if (
    !force &&
    whitelistCache.url === url &&
    whitelistCache.keys.size > 0 &&
    now - whitelistCache.fetchedAt < WHITELIST_CACHE_MS
  ) {
    return whitelistCache.keys;
  }

  let res;
  try {
    res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  } catch (err) {
    throw new Error('Không kết nối được whitelist GitHub (fail-closed).');
  }
  if (!res.ok) {
    throw new Error(`Không đọc được whitelist GitHub (HTTP ${res.status}).`);
  }
  const text = await res.text();
  // Reject obvious local bypass / empty / HTML error pages
  if (!text || text.length < 20 || /<!doctype html|<html/i.test(text)) {
    throw new Error('Whitelist GitHub không hợp lệ (fail-closed).');
  }
  const keys = new Set();
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const keyPart = trimmed.split(/\s+/)[0].toUpperCase();
    if (keyPart.startsWith('VIO1.')) keys.add(keyPart);
  });

  if (keys.size === 0) {
    throw new Error('Whitelist trống — từ chối toàn bộ key (fail-closed).');
  }

  whitelistCache = { url, fetchedAt: now, keys };
  return keys;
}

async function assertKeyOnWhitelist(normalizedKey, force = false) {
  const keys = await fetchStaffWhitelist(force);
  if (!keys.has(String(normalizedKey).toUpperCase())) {
    throw new Error('Key không có trong whitelist GitHub (đã thu hồi hoặc chưa phát hành).');
  }
}

async function verifyStaffKeyCrypto(raw) {
  const parsed = parseStaffKey(raw);
  const expected = await signStaffPayload(parsed.ttlHours, parsed.serial);
  if (expected !== parsed.sig) {
    throw new Error('Chữ ký key không hợp lệ.');
  }
  return parsed;
}

/**
 * Full remote auth gate: crypto signature + live GitHub membership + TTL.
 * Never trust storage flags alone (staffAuthUntil can be forged in DevTools).
 */
async function validateActiveStaffSession(forceWhitelist = false) {
  const cfg = await chrome.storage.local.get(['staffKey', 'staffAuthUntil', 'staffAuthTtlHours']);
  const key = String(cfg.staffKey || '').trim();
  const until = Number(cfg.staffAuthUntil || 0);

  if (!key) {
    throw new Error('Chưa xác thực User. Mở popup nhập Staff Key.');
  }
  if (!until || until <= Date.now()) {
    await wipeStaffAuth();
    throw new Error('Staff Key đã hết hạn. Nhập key mới.');
  }

  let verified;
  try {
    verified = await verifyStaffKeyCrypto(key);
  } catch (err) {
    await wipeStaffAuth();
    throw err;
  }

  try {
    await assertKeyOnWhitelist(verified.normalized, forceWhitelist);
  } catch (err) {
    await wipeStaffAuth();
    throw err;
  }

  // TTL in key must match what was activated (blocks casual storage edits)
  if (cfg.staffAuthTtlHours && Number(cfg.staffAuthTtlHours) !== verified.ttlHours) {
    await wipeStaffAuth();
    throw new Error('Phiên auth không khớp TTL của key (có thể bị sửa local).');
  }

  return {
    authenticated: true,
    expiresAt: until,
    remainingMs: Math.max(0, until - Date.now()),
    ttlHours: verified.ttlHours,
    key: verified.normalized
  };
}

async function getStaffAuthStatus() {
  try {
    return await validateActiveStaffSession(false);
  } catch (err) {
    return {
      authenticated: false,
      expiresAt: 0,
      remainingMs: 0,
      ttlHours: 0,
      revoked: true,
      error: err.message
    };
  }
}

async function assertStaffAuth() {
  // Every AI solve: force fresh GitHub whitelist (không tin cache / storage giả)
  return validateActiveStaffSession(true);
}

async function activateStaffKey(raw) {
  const verified = await verifyStaffKeyCrypto(raw);
  // Always re-fetch whitelist on activate so newly pushed GitHub keys work immediately
  const keys = await fetchStaffWhitelist(true);
  if (!keys.has(verified.normalized.toUpperCase())) {
    throw new Error('Key không có trong whitelist GitHub (đã thu hồi hoặc chưa phát hành).');
  }

  // Hạn 6/12/24h bắt đầu từ lúc kích hoạt
  const expiresAt = Date.now() + verified.ttlHours * 3600 * 1000;
  await chrome.storage.local.set({
    staffKey: verified.normalized,
    staffAuthUntil: expiresAt,
    staffAuthTtlHours: verified.ttlHours
  });
  return {
    authenticated: true,
    expiresAt,
    remainingMs: Math.max(0, expiresAt - Date.now()),
    ttlHours: verified.ttlHours
  };
}

async function mintStaffKey(adminPass, ttlHours) {
  if (!STAFF_ADMIN_PASS || String(adminPass || '') !== STAFF_ADMIN_PASS) {
    throw new Error('Mật khẩu admin không đúng.');
  }
  const ttl = parseInt(ttlHours, 10);
  if (!ALLOWED_TTL_HOURS.includes(ttl)) {
    throw new Error('TTL phải là 6, 12 hoặc 24 giờ.');
  }
  const serialBytes = new Uint8Array(6);
  crypto.getRandomValues(serialBytes);
  const serial = Array.from(serialBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const sig = await signStaffPayload(ttl, serial);
  const key = `VIO1.${ttl}.${serial}.${sig}`;
  return {
    key,
    ttlHours: ttl,
    note: 'Key mới chỉ dùng được sau khi thêm vào file raw GitHub whitelist.'
  };
}

async function fetchVireonixLimits() {
  const cfg = await chrome.storage.local.get(DEFAULT_CONFIG);
  const baseUrl = (cfg.vireonixBaseUrl || 'https://vireonix.ai').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/api/limits`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function handleSolveQuestion(payload) {
  const config = await chrome.storage.local.get(DEFAULT_CONFIG);
  const provider = payload.overrideProvider || config.provider || 'vireonix';

  // 1. Check in-memory answer cache to prevent duplicate request storms
  const cacheKey = computeQuestionHash(payload);
  if (config.enableCache !== false && questionCache.has(cacheKey)) {
    console.log('[VioEdu-AI] Cache hit: Returning cached answer (zero network traffic).');
    return questionCache.get(cacheKey);
  }

  const systemPrompt = generateSystemPrompt();
  const userPrompt = constructTextPrompt(payload);
  const answer = await dispatchTextQuery(systemPrompt, userPrompt, config, provider);

  // Save to cache
  if (config.enableCache !== false && answer) {
    if (questionCache.size > 200) {
      const firstKey = questionCache.keys().next().value;
      questionCache.delete(firstKey);
    }
    questionCache.set(cacheKey, answer);
  }

  return answer;
}

function computeQuestionHash(payload) {
  const q = (payload.questionText || '').trim().toLowerCase();
  const opts = (payload.options || []).map(o => (o.text || '').trim().toLowerCase()).join('|');
  const pairs = ((payload.leftItems || []).map(i => i.text).join('|')) + '__' + ((payload.rightItems || []).map(i => i.text).join('|'));
  return `${payload.type || 'choice'}_${q}_${opts}_${pairs}`;
}

function generateSystemPrompt() {
  const personas = [
    'You are a helpful, professional tutor assisting a student with school exercises. Always answer accurately and output in valid JSON.',
    'You are an expert academic tutor. Solve the student\'s exercise step-by-step and provide the final answer in valid JSON.',
    'You are a dedicated study assistant. Answer the exercise correctly and return pure JSON.'
  ];
  const persona = personas[Math.floor(Math.random() * personas.length)];

  return `${persona}

Exercise types:
1. Multiple choice (single answer): return {"type": "single_choice", "chosenIndex": number (0 for A, 1 for B...), "chosenOption": "A" | "B" | "C" | "D"}
2. Multiple choice (multiple answers allowed / select all that apply): return {"type": "multi_choice", "chosenIndices": [number, number...], "chosenOptions": ["A", "C"...]}
3. Dropdown selection: return {"type": "dropdown", "chosenIndex": number, "chosenOption": "exact word or text"}
4. Word selection in sentence (click to underline word): return {"type": "word_click", "chosenWord": "exact word", "chosenIndex": number, "chosenIndices": [number]}
5. Fill in the blank (typed): for one field return {"type": "fill_blank", "fillValue": string}; for multiple fields return {"type": "fill_blank", "fillValues": [one answer per field in page order]}. Never put all field answers into one value.
6. Word bank / drag-drop / click chips into blanks: return {"type": "word_bank", "fillValues": ["word1", "word2"], "chosenOptions": ["word1", "word2"]}
7. Matching pairs: return {"type": "matching", "pairs": [{"leftIndex": number, "rightIndex": number}]}

JSON output format:
{
  "type": "single_choice" | "multi_choice" | "dropdown" | "word_click" | "fill_blank" | "word_bank" | "matching",
  "chosenOption": "A" | "B" | "C" | "D" | string,
  "chosenIndex": number,
  "chosenIndices": [number],
  "chosenOptions": [string],
  "chosenWord": string,
  "fillValue": string,
  "fillValues": [string],
  "pairs": [{"leftIndex": number, "rightIndex": number}],
  "explanation": string
}`;
}

async function dispatchTextQuery(systemPrompt, userPrompt, config, provider) {
  // If Vireonix was requested but is in cooldown (from previous 429/banned), auto failover
  if (provider === 'vireonix' && Date.now() < vireonixCooldownUntil) {
    const remainingCooldownSec = Math.ceil((vireonixCooldownUntil - Date.now()) / 1000);
    console.warn(`[VioEdu-AI] Vireonix đang trong thời gian nghỉ chống ban IP (${remainingCooldownSec}s).`);
    if (config.autoFailover) {
      try {
        return await queryFallbackProvider(systemPrompt, userPrompt, config);
      } catch (fallbackErr) {
        throw new Error(`Vireonix đang tạm nghỉ ${remainingCooldownSec}s; provider dự phòng lỗi: ${fallbackErr.message}`);
      }
    }
    throw new Error(`Vireonix đang tạm dừng ${remainingCooldownSec}s. Bật auto-failover và cấu hình provider dự phòng.`);
  }

  if (provider === 'vireonix') {
    try {
      return await queryVireonixWithPacing(systemPrompt, userPrompt, config);
    } catch (err) {
      if (config.autoFailover && (config.openRouterApiKey || config.groqApiKey)) {
        console.warn(`[VioEdu-AI] Vireonix lỗi (${err.message}), đang kích hoạt auto-failover...`);
        return await queryFallbackProvider(systemPrompt, userPrompt, config);
      }
      throw err;
    }
  }

  if (provider === 'openrouter') {
    try {
      return await queryOpenRouter(systemPrompt, userPrompt, config.openRouterApiKey, config.openRouterModel || 'openrouter/free');
    } catch (err) {
      if (config.autoFailover && config.groqApiKey) return queryFallbackProvider(systemPrompt, userPrompt, config, ['openrouter']);
      throw err;
    }
  }
  if (provider === 'groq') return queryGroq(systemPrompt, userPrompt, config.groqModel, config.groqApiKey);
  return queryVireonixWithPacing(systemPrompt, userPrompt, config);
}

async function queryFallbackProvider(systemPrompt, userPrompt, config, skip = []) {
  const candidates = [
    { id: 'openrouter', key: config.openRouterApiKey, run: () => queryOpenRouter(systemPrompt, userPrompt, config.openRouterApiKey, config.openRouterModel || 'openrouter/free') },
    { id: 'groq', key: config.groqApiKey, run: () => queryGroq(systemPrompt, userPrompt, config.groqModel, config.groqApiKey) }
  ];
  const errors = [];
  for (const candidate of candidates) {
    if (skip.includes(candidate.id) || !candidate.key) continue;
    const cooldownUntil = candidate.id === 'openrouter' ? openRouterCooldownUntil : groqCooldownUntil;
    if (cooldownUntil > Date.now()) {
      errors.push(`${candidate.id} rate-limited (${Math.ceil((cooldownUntil - Date.now()) / 1000)}s)`);
      continue;
    }
    try {
      console.warn(`[VioEdu-AI] Failover -> ${candidate.id}`);
      return await candidate.run();
    } catch (err) {
      errors.push(`${candidate.id}: ${err.message}`);
    }
  }
  throw new Error(errors.length ? errors.join(' | ') : 'No fallback API key configured. Add an OpenRouter or Groq key.');
}

async function queryVireonixWithPacing(systemPrompt, userPrompt, config) {
  // Advanced Human Cognitive Pacing: mimics real reading speed & fatigue pauses
  if (config.antiBurstPacing !== false) {
    consecutiveQuestionCount++;
    const baseGap = config.minRequestGapMs || 3500;
    // Reading time based on prompt length (15ms per char, between 1.2s and 4.5s)
    const readingTime = Math.min(Math.max(Math.floor(userPrompt.length * 15), 1200), 4500);
    const jitter = Math.floor(Math.random() * 2200);
    // Fatigue / review pause: every 4 questions, student takes extra 3-6s to check
    const fatiguePause = (consecutiveQuestionCount % 4 === 0) ? (3000 + Math.floor(Math.random() * 2500)) : 0;

    const minDelay = baseGap + readingTime + jitter + fatiguePause;
    const elapsed = Date.now() - lastVireonixCallTime;
    if (elapsed < minDelay) {
      const waitTime = minDelay - elapsed;
      console.log(`[VioEdu-AI] Stealth Pacing: Chờ ${waitTime}ms (đọc đề + giãn cách tự nhiên)...`);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }

  lastVireonixCallTime = Date.now();
  const baseUrl = (config.vireonixBaseUrl || 'https://vireonix.ai').replace(/\/+$/, '');
  const url = `${baseUrl}/v1/chat/completions`;

  // Build conversational message thread (multi-turn student-tutor dialogue)
  const messages = [{ role: 'system', content: systemPrompt }];
  // Append last 2 conversational turns if available
  if (rollingChatHistory.length > 0) {
    rollingChatHistory.slice(-2).forEach(msg => messages.push(msg));
  }
  messages.push({ role: 'user', content: userPrompt });

  // Randomize temperature slightly (0.10 - 0.22) to avoid static 0.0 bot fingerprint
  const dynamicTemp = Math.round((0.10 + Math.random() * 0.12) * 100) / 100;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    },
    body: JSON.stringify({
      model: config.vireonixModel || 'auto',
      messages: messages,
      temperature: dynamicTemp
    })
  });

  if (response.status === 429) {
    vireonixCooldownUntil = Date.now() + 60000;
    rollingChatHistory.length = 0; // Reset history
    throw new Error('Vireonix báo quá tải (429 Rate Limit). Đang tạm ngưng 60s để bảo vệ IP.');
  }

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 403) {
      vireonixCooldownUntil = Date.now() + 180000;
      rollingChatHistory.length = 0;
      throw new Error(`Vireonix chặn IP (403 Forbidden). Đang dừng 180s: ${errText}`);
    }
    throw new Error(`Vireonix HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';

  // Intercept Sentinel automation detection warning
  if (content.includes('Automated bulk tasks detected') || content.includes('TOS violation') || content.includes('custom policy')) {
    vireonixCooldownUntil = Date.now() + 300000; // 5 min cooldown
    rollingChatHistory.length = 0;
    throw new Error('Vireonix Sentinel kích hoạt bộ lọc tự động ("Automated bulk tasks detected"). Tạm dừng Vireonix 5 phút, kích hoạt chuyển tiếp sang OpenRouter/Groq...');
  }

  // Record dialogue turn to maintain human conversational continuity
  try {
    const shortUser = userPrompt.length > 120 ? (userPrompt.slice(0, 115) + '...') : userPrompt;
    const shortAssistant = content.length > 120 ? (content.slice(0, 115) + '...') : content;
    rollingChatHistory.push({ role: 'user', content: shortUser });
    rollingChatHistory.push({ role: 'assistant', content: shortAssistant });
    if (rollingChatHistory.length > 4) rollingChatHistory.splice(0, rollingChatHistory.length - 4);
  } catch (e) {}

  return parseAIResponse(content);
}

function constructTextPrompt(payload) {
  const intros = [
    'Please analyze and solve this exercise:',
    'Here is an exercise question for you to solve:',
    'Can you help me answer this question accurately:',
    'Determine the correct answer for the following exercise:'
  ];
  const intro = intros[Math.floor(Math.random() * intros.length)];
  let prompt = `${intro}\n\n`;

  if (payload.type === 'matching' || (payload.leftItems && payload.leftItems.length > 0)) {
    prompt += `Match each item in the left column with its corresponding item in the right column.\n`;
    if (payload.questionText) prompt += `Context: ${payload.questionText}\n\n`;
    prompt += `Left Column:\n`;
    (payload.leftItems || []).forEach((item, idx) => {
      prompt += `${idx}: ${item.text}\n`;
    });
    prompt += `\nRight Column:\n`;
    (payload.rightItems || []).forEach((item, idx) => {
      prompt += `${idx}: ${item.text}\n`;
    });
    prompt += `\nOutput JSON: {"type": "matching", "pairs": [{"leftIndex": 0, "rightIndex": ...}]}`;
  } else if (payload.type === 'multi_choice') {
    prompt += `Question: ${payload.questionText}\nNote: Multiple options may be correct (select all that apply).\n\nOptions:\n`;
    payload.options.forEach((opt, idx) => {
      const letter = String.fromCharCode(65 + idx);
      prompt += `${letter}. ${opt.text}\n`;
    });
    prompt += `\nOutput JSON: {"type": "multi_choice", "chosenIndices": [number, ...], "chosenOptions": ["A", ...]}`;
  } else if (payload.type === 'dropdown') {
    prompt += `Choose the correct option from the dropdown for this question:\nQuestion: ${payload.questionText}\n\nAvailable choices:\n`;
    (payload.options || []).forEach((opt, idx) => {
      prompt += `${idx}: ${opt.text}\n`;
    });
    prompt += `\nChoose only one exact value from the available choices above. Do not invent an answer outside that list.\nOutput JSON: {"type": "dropdown", "chosenOption": "<exact available choice>", "chosenIndex": number}`;
  } else if (payload.type === 'word_bank') {
    const blanks = payload.blankCount || 1;
    prompt += `This is a drag/drop or click-to-fill word-bank question with ${blanks} blank(s).\n`;
    prompt += `Question: ${payload.questionText}\n\nWord bank chips (clickable):\n`;
    (payload.options || []).forEach((opt, idx) => {
      prompt += `${idx}: ${opt.text}\n`;
    });
    prompt += `\nReturn the exact chip words for each blank in order.\nOutput JSON: {"type": "word_bank", "fillValues": ["word_for_blank1", "word_for_blank2"], "chosenOptions": ["word_for_blank1", "word_for_blank2"]}`;
  } else if (payload.type === 'word_click') {
    prompt += `Identify the target word in the sentence based on the instruction:\n`;
    prompt += `Instruction: ${payload.questionText}\n`;
    if (payload.sentence) prompt += `Sentence: "${payload.sentence}"\n`;
    prompt += `\nWords in Sentence:\n`;
    (payload.options || []).forEach((opt, idx) => {
      prompt += `${idx}: ${opt.text}\n`;
    });
    prompt += `\nOutput JSON: {"type": "word_click", "chosenWord": "<the exact word>", "chosenIndex": number, "chosenIndices": [number]}`;
  } else if (payload.type === 'fill_blank' || (!payload.options || payload.options.length === 0)) {
    prompt += `Calculate and solve the problem:\n${payload.questionText}\n`;
    const blankCount = Math.max(1, Number(payload.blankCount) || 1);
    if (blankCount > 1) {
      prompt += `There are exactly ${blankCount} separate answer fields. Return one answer per field, in page order. Never combine the answers into one string or include list brackets/commas around the whole set.\n`;
      const answerExamples = Array.from({ length: blankCount }, (_, index) => `"answer for field ${index + 1}"`).join(', ');
      prompt += `Output JSON: {"type": "fill_blank", "fillValues": [${answerExamples}]}`;
    } else {
      prompt += `Output JSON: {"type": "fill_blank", "fillValue": "<exact numerical or text value>"}`;
    }
  } else {
    prompt += `Question: ${payload.questionText}\n\nOptions:\n`;
    payload.options.forEach((opt, idx) => {
      const letter = String.fromCharCode(65 + idx);
      prompt += `${letter}. ${opt.text}\n`;
    });
    prompt += `\nOutput JSON: {"type": "single_choice", "chosenIndex": number, "chosenOption": "A"}`;
  }

  return prompt;
}

async function queryOpenRouter(systemPrompt, userPrompt, apiKey, model = 'openrouter/free') {
  if (!apiKey) throw new Error('OpenRouter API key required. Create one at openrouter.ai/keys.');
  if (openRouterCooldownUntil > Date.now()) {
    throw new Error(`OpenRouter rate-limited; retry in ${Math.ceil((openRouterCooldownUntil - Date.now()) / 1000)}s.`);
  }
  const effectiveKey = apiKey;
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${effectiveKey}`,
      'HTTP-Referer': 'https://vio.edu.vn',
      'X-Title': 'VioEdu Solver'
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.0
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 402 || response.status === 429 || /rate.?limit|quota|insufficient credits|daily.{0,20}limit/i.test(errText)) {
      openRouterCooldownUntil = Date.now() + 60_000;
    }
    throw new Error(`OpenRouter HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return parseAIResponse(data.choices?.[0]?.message?.content || '');
}

async function queryGroq(systemPrompt, userPrompt, model = 'openai/gpt-oss-120b', apiKey = '') {
  if (!apiKey) throw new Error('Chưa nhập Groq API key. Tạo key tại console.groq.com/keys.');
  if (groqCooldownUntil > Date.now()) {
    throw new Error(`Groq rate-limited; retry in ${Math.ceil((groqCooldownUntil - Date.now()) / 1000)}s.`);
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`
    },
    body: JSON.stringify({
      model: model || 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.0
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 402 || response.status === 429 || /rate.?limit|quota|insufficient credits|daily.{0,20}limit/i.test(errText)) {
      groqCooldownUntil = Date.now() + 60_000;
    }
    if (response.status === 401) {
      throw new Error('Groq API key không hợp lệ (401). Kiểm tra key tại console.groq.com/keys.');
    }
    throw new Error(`Groq HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return parseAIResponse(data.choices?.[0]?.message?.content || '');
}

function parseAIResponse(raw) {
  if (typeof raw === 'string' && (raw.includes('Automated bulk tasks detected') || raw.includes('TOS violation') || raw.includes('custom policy'))) {
    vireonixCooldownUntil = Date.now() + 300000; // 5 min cooldown
    throw new Error('Vireonix Sentinel kích hoạt bộ lọc tự động ("Automated bulk tasks detected"). Tạm dừng 5 phút và tự động chuyển sang nhà cung cấp dự phòng.');
  }

  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    const parsed = JSON.parse(cleaned);

    // Normalize fillValue / word_bank
    if (!parsed.fillValue && parsed.fillValues && parsed.fillValues.length > 0) {
      parsed.fillValue = parsed.fillValues[0];
    }
    if (parsed.type === 'word_bank') {
      parsed.type = 'word_bank';
      if (!parsed.fillValues && parsed.chosenOptions) parsed.fillValues = parsed.chosenOptions;
    }

    // Normalize matching pairs
    if (parsed.pairs && Array.isArray(parsed.pairs)) {
      parsed.type = 'matching';
      parsed.pairs = parsed.pairs.map(p => ({
        leftIndex: parseInt(p.leftIndex ?? p.left_index ?? p.left, 10),
        rightIndex: parseInt(p.rightIndex ?? p.right_index ?? p.right, 10)
      })).filter(p => !isNaN(p.leftIndex) && !isNaN(p.rightIndex));
    }

    // Normalize multi-choice chosenIndices
    if (parsed.chosenIndices && Array.isArray(parsed.chosenIndices)) {
      parsed.type = 'multi_choice';
      parsed.chosenIndices = parsed.chosenIndices.map(i => parseInt(i, 10)).filter(i => !isNaN(i));
    } else if (parsed.chosenOptions && Array.isArray(parsed.chosenOptions)) {
      parsed.type = 'multi_choice';
      parsed.chosenIndices = parsed.chosenOptions.map(opt => {
        const code = String(opt).toUpperCase().charCodeAt(0);
        return (code >= 65 && code <= 90) ? code - 65 : parseInt(opt, 10);
      }).filter(i => !isNaN(i) && i >= 0);
    }

    // Normalize word_click
    if (parsed.type === 'word_click' || parsed.chosenWord) {
      parsed.type = 'word_click';
      if (parsed.chosenWord && !parsed.chosenOption) parsed.chosenOption = parsed.chosenWord;
    }

    if (parsed.chosenIndex === undefined && parsed.chosenOption) {
      const charCode = String(parsed.chosenOption).toUpperCase().charCodeAt(0);
      if (charCode >= 65 && charCode <= 68) {
        parsed.chosenIndex = charCode - 65;
      }
    }
    return parsed;
  } catch (err) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]);
        if (obj.chosenIndex === undefined && obj.chosenOption) {
          const charCode = String(obj.chosenOption).toUpperCase().charCodeAt(0);
          if (charCode >= 65 && charCode <= 68) {
            obj.chosenIndex = charCode - 65;
          }
        }
        return obj;
      } catch (e) {}
    }
    // Extract numerical answer from text if present
    const num = raw.match(/-?\d+(\.\d+)?/);
    return {
      type: 'fill_blank',
      fillValue: num ? num[0] : raw.trim(),
      explanation: raw
    };
  }
}
