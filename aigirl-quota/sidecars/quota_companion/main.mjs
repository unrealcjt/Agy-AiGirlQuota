/**
 * AI Girl Quota — Antigravity UI Sidecar Backend
 *
 * Serves the virtual avatar HUD, queries RetrieveUserQuotaSummary (real live 5H
 * & weekly buckets) and GetUserStatus (user tier & per-model breakdown) from
 * the local Antigravity Language Server, and resolves active model /
 * Orchestrator mode from hooks (live_model.json) + transcript.jsonl.
 */
import { createServer } from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_FILE = fileURLToPath(import.meta.url);
const __dirname = dirname(MAIN_FILE);
const ASSETS_DIR = join(__dirname, 'assets');
const ID_RE = /^[0-9a-f-]{8,}$/i;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const CACHE_TTL_MS = 3000;
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

// ---------------------------------------------------------------------------
// Load Antigravity sidecar_sdk, or fall back to standalone HTTP server for
// local preview & verification outside Antigravity.
// ---------------------------------------------------------------------------
let SidecarApp;
let SdkResponse;
let isStandaloneMode = process.argv.includes('--standalone') || !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;

if (!isStandaloneMode) {
  try {
    const sdk = await import('sidecar_sdk');
    SidecarApp = sdk.SidecarApp;
    SdkResponse = sdk.Response;
  } catch {
    isStandaloneMode = true;
  }
}

class StandaloneResponse {
  constructor(body, opts = {}) {
    this.body = body;
    this.status = opts.status || 200;
    this.contentType = opts.contentType || 'application/octet-stream';
    this.headers = opts.headers || {};
  }
}

class StandaloneSidecarApp {
  constructor() {
    this.routes = [];
    this.config = { conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || '' };
  }
  page(path, handler) {
    this.routes.push({ method: 'GET', path, handler, isPage: true });
  }
  api(path, handler, method = 'GET') {
    this.routes.push({ method: method.toUpperCase(), path, handler, isPage: false });
  }
  run() {
    const portArg = process.argv.find((a) => a.startsWith('--port='));
    const port = Number(portArg ? portArg.split('=')[1] : process.env.PORT || 39451);
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        if (url.pathname === '/preload.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...NO_STORE_HEADERS });
          res.end(`window.sidecar = { conversationId: ${JSON.stringify(this.config.conversationId)}, fetch: (p, o) => fetch(p, o) };`);
          return;
        }
        const match = this.routes.find((r) => r.path === url.pathname && r.method === (req.method || 'GET').toUpperCase());
        if (!match) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        let data = Object.fromEntries(url.searchParams.entries());
        if (req.method === 'POST' || req.method === 'PUT') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const raw = Buffer.concat(chunks).toString('utf8').trim();
          if (raw) {
            try { data = { ...data, ...JSON.parse(raw) }; } catch { /* ignore */ }
          }
        }
        const out = await match.handler(data);
        if (out instanceof StandaloneResponse) {
          res.writeHead(out.status, { 'Content-Type': out.contentType, ...out.headers });
          res.end(out.body);
        } else if (match.isPage) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE_HEADERS });
          res.end(String(out));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE_HEADERS });
          res.end(JSON.stringify(out));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`[quota_companion] standalone listening on http://127.0.0.1:${port}`);
    });
  }
}

const AppClass = SidecarApp || StandaloneSidecarApp;
const ResponseClass = SdkResponse || StandaloneResponse;

// Auto-restart when main.mjs is updated on disk (Antigravity restart_policy: always)
if (!isStandaloneMode) {
  let startupMtime = 0;
  try { startupMtime = statSync(MAIN_FILE).mtimeMs; } catch { /* ignore */ }
  if (startupMtime) {
    setInterval(() => {
      try {
        const cur = statSync(MAIN_FILE).mtimeMs;
        if (cur && cur !== startupMtime) {
          console.log('[quota_companion] detected main.mjs update on disk, exiting for restart');
          process.exit(1);
        }
      } catch { /* ignore */ }
    }, 5000).unref();
  }
}

// ---------------------------------------------------------------------------
// Path discovery (mirrors builtin swarm_board conventions)
// ---------------------------------------------------------------------------
function safeReaddir(p) {
  try { return readdirSync(p); } catch { return []; }
}

function findAppDataDirs() {
  const dirs = [];
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(join(appData, 'brain'))) dirs.push(appData);
        break;
      }
    }
  }
  const envAppData = process.env.ANTIGRAVITY_APP_DATA_DIR;
  if (envAppData && existsSync(join(envAppData, 'brain')) && !dirs.includes(envAppData)) {
    dirs.push(envAppData);
  }
  if (!dirs.length) {
    const root = join(homedir(), '.gemini');
    for (const name of safeReaddir(root).sort()) {
      const candidate = join(root, name);
      if (existsSync(join(candidate, 'brain'))) dirs.push(candidate);
    }
  }
  return dirs;
}

function resolvePluginDataDir() {
  if (process.env.PLUGIN_DATA) return process.env.PLUGIN_DATA;
  const appDirs = findAppDataDirs();
  const base = appDirs[0] || join(homedir(), '.gemini', 'antigravity');
  return join(base, 'plugin_data', 'aigirl-quota');
}

// ---------------------------------------------------------------------------
// Helpers: classification & formatting
// ---------------------------------------------------------------------------
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function classifyFamily(name) {
  const s = String(name || '').toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(s)) return 'claude';
  if (/gemini|neon|carbon|argon|hydrogen|orchestrator/.test(s)) return 'gemini';
  return 'other';
}

function isOrchestratorModel(name) {
  return /orchestrator/i.test(String(name || ''));
}

function cap(w) {
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
}

function prettyModelName(raw, configs = []) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const hit = configs.find((m) =>
    m.modelId === s ||
    m.label === s ||
    m.modelOrAlias?.model === s
  );
  if (hit?.label) return hit.label;
  if (/^[a-z0-9._-]+$/i.test(s) && s.includes('-')) {
    return s
      .replace(/claude-opus-(\d+)-(\d+)/i, 'Claude Opus $1.$2')
      .replace(/claude-sonnet-(\d+)-(\d+)/i, 'Claude Sonnet $1.$2')
      .replace(/claude-haiku-(\d+)-(\d+)/i, 'Claude Haiku $1.$2')
      .replace(/gemini-pro-orchestrator(?:-([a-z]+))?/i, (_, v) => (v ? `Orchestrator (${cap(v)})` : 'Orchestrator (Carbon)'))
      .replace(/-/g, ' ')
      .replace(/\b([a-z])/g, (m) => m.toUpperCase());
  }
  return s;
}

// ---------------------------------------------------------------------------
// Antigravity LanguageServerService Clients
// ---------------------------------------------------------------------------
const rpcCaches = {
  quotaSummary: { fetchedAt: 0, payload: null },
  userStatus: { fetchedAt: 0, payload: null },
};

async function callLsRpc(method, cacheKey, force = false) {
  const now = Date.now();
  const cache = rpcCaches[cacheKey];
  if (!force && cache.payload && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { data: cache.payload, error: null };
  }
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf) {
    return {
      data: cache.payload,
      error: 'ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN not set',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
      },
      body: JSON.stringify({
        metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
    const json = await res.json();
    rpcCaches[cacheKey] = { fetchedAt: Date.now(), payload: json };
    return { data: json, error: null };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `${method} timeout` : String(err?.message || err);
    return { data: cache.payload, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Real Quota Extraction (RetrieveUserQuotaSummary primary + GetUserStatus models)
// ---------------------------------------------------------------------------
function parseBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  let remainingFraction = null;
  if (typeof bucket.remainingFraction === 'number') {
    remainingFraction = clamp01(bucket.remainingFraction);
  } else if (bucket.resetTime) {
    // Protobuf omits 0 values in JSON when resetTime is present
    remainingFraction = 0;
  }
  const isFull = remainingFraction !== null && remainingFraction >= 0.9999;
  const resetTime = isFull ? null : (bucket.resetTime || null);
  const hasTimer = Boolean(resetTime) && !isFull;
  return {
    remainingFraction,
    resetTime,
    isFull,
    hasTimer,
    available: remainingFraction === null ? true : remainingFraction > 0,
    source: 'live',
    description: bucket.description || '',
  };
}

function classifySummaryGroup(group) {
  const text = `${group?.displayName || ''} ${group?.description || ''} ${(group?.buckets || []).map((b) => b.bucketId).join(' ')}`.toLowerCase();
  if (/gemini/.test(text)) return 'gemini';
  if (/claude|3p-/.test(text)) return 'claude';
  return null;
}

function extractFamilyQuotas(quotaSummary, userStatus) {
  const configs = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  const byFamilyModels = { claude: [], gemini: [] };

  for (const m of configs) {
    const fam = classifyFamily(m.modelId || m.label);
    if (fam !== 'claude' && fam !== 'gemini') continue;
    const qi = m.quotaInfo || null;
    let remainingFraction = null;
    if (qi) {
      if (typeof qi.remainingFraction === 'number') {
        remainingFraction = clamp01(qi.remainingFraction);
      } else if (qi.resetTime) {
        remainingFraction = 0;
      }
    }
    const isFull = remainingFraction !== null && remainingFraction >= 0.9999;
    byFamilyModels[fam].push({
      label: m.label || m.modelId || 'Unknown',
      modelId: m.modelId || '',
      remainingFraction,
      resetTime: isFull ? null : (qi?.resetTime || null),
      tagTitle: m.tagTitle || '',
      isOrchestrator: isOrchestratorModel(m.modelId || m.label),
    });
  }

  // Primary source: RetrieveUserQuotaSummary groups (real 5h & weekly buckets)
  const summaryGroups = quotaSummary?.response?.groups || quotaSummary?.groups || [];
  const parsedGroups = { claude: {}, gemini: {} };
  for (const grp of summaryGroups) {
    const fam = classifySummaryGroup(grp);
    if (!fam) continue;
    for (const b of grp.buckets || []) {
      const win = String(b.window || '').toLowerCase();
      const id = String(b.bucketId || '').toLowerCase();
      if (win === '5h' || id.endsWith('-5h')) {
        parsedGroups[fam].fiveHour = parseBucket(b);
      } else if (win === 'weekly' || id.endsWith('-weekly')) {
        parsedGroups[fam].weekly = parseBucket(b);
      }
    }
  }

  const result = {};
  for (const fam of ['claude', 'gemini']) {
    const models = byFamilyModels[fam];
    let fiveHour = parsedGroups[fam].fiveHour || null;
    let weekly = parsedGroups[fam].weekly || null;

    // Fallback for 5H only from GetUserStatus if RetrieveUserQuotaSummary failed
    if (!fiveHour) {
      const known = models.filter((m) => typeof m.remainingFraction === 'number');
      const preferred = known.filter((m) => !/leaving soon|notice/i.test(m.tagTitle));
      const pool = preferred.length ? preferred : known;
      if (pool.length) {
        const positive = pool.filter((m) => m.remainingFraction > 0);
        const rep = positive.length ? positive[0] : pool[0];
        const isFull = rep.remainingFraction >= 0.9999;
        const resetTime = isFull ? null : (rep.resetTime || null);
        fiveHour = {
          remainingFraction: rep.remainingFraction,
          resetTime,
          isFull,
          hasTimer: Boolean(resetTime) && !isFull,
          available: rep.remainingFraction > 0,
          source: 'live',
          description: '',
        };
      } else {
        fiveHour = {
          remainingFraction: null,
          resetTime: null,
          isFull: false,
          hasTimer: false,
          available: true,
          source: 'unavailable',
          description: '',
        };
      }
    }

    if (!weekly) {
      weekly = {
        remainingFraction: null,
        resetTime: null,
        isFull: false,
        hasTimer: false,
        available: true,
        source: 'unavailable',
        description: '',
      };
    }

    result[fam] = {
      fiveHour,
      weekly,
      available: fiveHour.available && weekly.available,
      models,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Active Model & Orchestrator Mode Resolution (transcript + hook telemetry)
// ---------------------------------------------------------------------------
const transcriptCache = new Map();

function readTranscriptTail(filePath) {
  try {
    const st = statSync(filePath);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = transcriptCache.get(filePath);
    if (hit && hit.key === key) return hit.parsed;

    const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (start > 0 && lines.length > 0) lines.shift();

    const steps = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { steps.push(JSON.parse(line)); } catch { /* ignore partial */ }
    }

    const parsed = analyzeTranscriptSteps(steps);
    transcriptCache.set(filePath, { key, parsed });
    if (transcriptCache.size > 32) transcriptCache.delete(transcriptCache.keys().next().value);
    return parsed;
  } catch {
    return null;
  }
}

function analyzeTranscriptSteps(steps) {
  let latestUserIdx = -1;
  let latestUserTs = 0;
  let settingsSelection = '';
  let sawPlanExecuteProtocol = false;

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.type === 'USER_INPUT' || st.source === 'USER_EXPLICIT') {
      latestUserIdx = i;
      const ts = Date.parse(st.created_at || '');
      if (Number.isFinite(ts)) latestUserTs = ts;
      const content = String(st.content || '');
      const matches = [...content.matchAll(/changed setting `Model Selection` from .*? to ([^.\n<]+)/gi)];
      if (matches.length) {
        settingsSelection = matches[matches.length - 1][1].trim();
      }
    }
  }

  const turnSlice = latestUserIdx >= 0 ? steps.slice(latestUserIdx) : steps.slice(-25);
  const turnModels = [];
  let sawPlanTool = false;
  let plannerModel = null;
  let executorModel = null;

  for (const st of turnSlice) {
    const content = String(st.content || '');
    if (content.includes('<plan_execute_protocol>') || content.includes('[plan review due]')) {
      sawPlanExecuteProtocol = true;
    }
    if (st.model) {
      if (!turnModels.includes(st.model)) turnModels.push(st.model);
      if (!sawPlanTool && !plannerModel) plannerModel = st.model;
      else if (sawPlanTool) executorModel = st.model;
    }
    if (Array.isArray(st.tool_calls)) {
      for (const tc of st.tool_calls) {
        if (tc?.name === 'exit_plan_mode' || tc?.name === 'enter_plan_mode') {
          sawPlanTool = true;
        }
      }
    }
  }

  const recentModels = [];
  for (const st of steps.slice(-15)) {
    if (st.model && !recentModels.includes(st.model)) recentModels.push(st.model);
  }

  return {
    latestUserTs,
    settingsSelection,
    turnModels,
    recentModels,
    lastModel: turnModels[turnModels.length - 1] || recentModels[recentModels.length - 1] || settingsSelection || '',
    sawPlanTool: sawPlanTool || sawPlanExecuteProtocol,
    plannerModel,
    executorModel,
  };
}

function findMostRecentTranscript(appDirs) {
  let best = { path: null, mtimeMs: 0, convId: '' };
  for (const appData of appDirs) {
    const brainDir = join(appData, 'brain');
    for (const id of safeReaddir(brainDir)) {
      if (!ID_RE.test(id)) continue;
      const tPath = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const st = statSync(tPath);
        if (st.mtimeMs > best.mtimeMs) {
          best = { path: tPath, mtimeMs: st.mtimeMs, convId: id };
        }
      } catch { /* ignore */ }
    }
  }
  return best;
}

function readLiveHookState() {
  const candidates = [
    join(resolvePluginDataDir(), 'live_model.json'),
    join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'aigirl-quota', 'live_model.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch { /* try next */ }
  }
  return null;
}

function resolveModelContext(requestedConvId, userStatus) {
  const configs = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  const defaultModelId = userStatus?.cascadeModelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model || '';
  const appDirs = findAppDataDirs();

  let convId = requestedConvId && ID_RE.test(requestedConvId) ? requestedConvId : '';
  let transcriptPath = null;
  if (convId) {
    for (const appData of appDirs) {
      const p = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (existsSync(p)) { transcriptPath = p; break; }
    }
  }
  if (!transcriptPath) {
    const latest = findMostRecentTranscript(appDirs);
    if (latest.path) {
      transcriptPath = latest.path;
      if (!convId) convId = latest.convId;
    }
  }

  const tr = transcriptPath ? readTranscriptTail(transcriptPath) : null;
  const hookState = readLiveHookState();
  const hookConv = (convId && hookState?.byConversation?.[convId]) || hookState?.latest || null;

  const turnRawModels = [];
  if (tr?.turnModels?.length) turnRawModels.push(...tr.turnModels);
  if (tr?.settingsSelection) turnRawModels.push(tr.settingsSelection);
  if (hookConv) {
    const recents = Array.isArray(hookConv.recentModels) ? hookConv.recentModels : [];
    const cutoff = Math.max(Date.now() - 10 * 60 * 1000, (tr?.latestUserTs || 0) - 2000);
    for (const r of recents) {
      if (r?.model && (!r.ts || r.ts >= cutoff)) turnRawModels.push(r.model);
    }
    const hookFresh = !tr?.latestUserTs || !hookConv.updatedMs || hookConv.updatedMs >= tr.latestUserTs - 2000;
    if (hookFresh) {
      if (hookConv.lastModel) turnRawModels.push(hookConv.lastModel);
      if (hookConv.model) turnRawModels.push(hookConv.model);
    }
  }

  const uniqueRaw = [...new Set(turnRawModels.filter(Boolean))];
  const primaryRaw =
    tr?.settingsSelection ||
    tr?.lastModel ||
    hookConv?.lastModel ||
    hookConv?.model ||
    defaultModelId ||
    '';

  const primaryLabel = prettyModelName(primaryRaw, configs) || 'Gemini';
  const distinctFamilies = new Set();
  for (const m of uniqueRaw) {
    const fam = classifyFamily(m);
    if (fam === 'claude' || fam === 'gemini') distinctFamilies.add(fam);
  }

  const isOrch =
    uniqueRaw.some((m) => isOrchestratorModel(m)) ||
    Boolean(tr?.sawPlanTool) ||
    distinctFamilies.size >= 2 ||
    (tr?.turnModels?.length >= 2);

  let activeFamilies = [];
  if (isOrch) {
    activeFamilies = [...distinctFamilies];
    if (!activeFamilies.length) {
      const f = classifyFamily(primaryRaw);
      if (f === 'claude' || f === 'gemini') activeFamilies = [f];
      else activeFamilies = ['gemini'];
    }
  } else {
    const f = classifyFamily(primaryRaw);
    if (f === 'claude' || f === 'gemini') activeFamilies = [f];
  }

  let mode = 'idle';
  if (isOrch) mode = 'orchestrator';
  else if (activeFamilies[0] === 'claude') mode = 'claude';
  else if (activeFamilies[0] === 'gemini') mode = 'gemini';

  const dualActive = mode === 'orchestrator' && activeFamilies.includes('claude') && activeFamilies.includes('gemini');

  return {
    conversationId: convId || null,
    mode,
    activeFamilies,
    dualActive,
    primaryModelLabel: primaryLabel,
    primaryModelRaw: primaryRaw,
    usedModels: uniqueRaw.map((m) => ({
      raw: m,
      label: prettyModelName(m, configs),
      family: classifyFamily(m),
    })),
    orchestratorRoles: isOrch
      ? {
          planner: tr?.plannerModel ? prettyModelName(tr.plannerModel, configs) : null,
          executor: tr?.executorModel ? prettyModelName(tr.executorModel, configs) : null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Asset caching & HTTP routing
// ---------------------------------------------------------------------------
const STATIC_TEXT = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const assetCache = new Map();
function readAssetPng(fileName) {
  if (assetCache.has(fileName)) return assetCache.get(fileName);
  const fullPath = join(ASSETS_DIR, fileName);
  const buf = readFileSync(fullPath);
  assetCache.set(fileName, buf);
  return buf;
}

function fileMtimeTag(fileName) {
  try { return Math.floor(statSync(join(__dirname, fileName)).mtimeMs); } catch { return Date.now(); }
}

const app = new AppClass();

app.page('/', () => {
  const cssVer = fileMtimeTag('styles.css');
  const jsVer = fileMtimeTag('app.js');
  return readFileSync(join(__dirname, 'index.html'), 'utf8')
    .replace('href="/styles.css"', `href="/styles.css?v=${cssVer}"`)
    .replace('src="/app.js"', `src="/app.js?v=${jsVer}"`);
});

for (const [route, [file, contentType]] of Object.entries(STATIC_TEXT)) {
  app.api(
    route,
    () =>
      new ResponseClass(readFileSync(join(__dirname, file), 'utf8'), {
        contentType,
        headers: NO_STORE_HEADERS,
      }),
    'GET'
  );
}

app.api(
  '/assets/Claude.png',
  () =>
    new ResponseClass(readAssetPng('Claude.png'), {
      contentType: 'image/png',
      headers: { 'Cache-Control': 'private, max-age=86400' },
    }),
  'GET'
);

app.api(
  '/assets/Gemini.png',
  () =>
    new ResponseClass(readAssetPng('Gemini.png'), {
      contentType: 'image/png',
      headers: { 'Cache-Control': 'private, max-age=86400' },
    }),
  'GET'
);

app.api(
  '/api/status',
  async (data = {}) => {
    const conv = String(data.conversationId || app.config?.conversationId || '').trim();
    const force = data.force === '1' || data.force === 'true';

    const [summaryRes, userRes] = await Promise.all([
      callLsRpc('RetrieveUserQuotaSummary', 'quotaSummary', force),
      callLsRpc('GetUserStatus', 'userStatus', force),
    ]);

    const quotaSummary = summaryRes.data || null;
    const userStatus = userRes.data?.userStatus || null;
    const families = extractFamilyQuotas(quotaSummary, userStatus);
    const activeContext = resolveModelContext(conv, userStatus);
    const errors = [summaryRes.error, userRes.error].filter(Boolean);

    return {
      ok: true,
      timestamp: Date.now(),
      standalone: isStandaloneMode,
      connected: Boolean(quotaSummary || userStatus),
      error: errors.length ? errors.join('; ') : null,
      user: userStatus
        ? {
            name: userStatus.name || '',
            tierName: userStatus.userTier?.name || userStatus.planStatus?.planInfo?.planName || '',
          }
        : null,
      activeContext,
      families,
    };
  },
  'GET'
);

app.run();
