(() => {
  const FIVE_HOURS_MS = 5 * 3600 * 1000;
  const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
  const CIRCUMFERENCE = 2 * Math.PI * 9.5; // ~59.69 for r=9.5
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  // -------------------------------------------------------------------------
  // Theme Sync with Antigravity Host (light/dark luminance detection)
  // -------------------------------------------------------------------------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f9f3f2)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // -------------------------------------------------------------------------
  // API Helpers (use window.sidecar.fetch when embedded in Antigravity)
  // -------------------------------------------------------------------------
  async function apiFetch(path) {
    const fn = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await fn(path, { method: 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function currentConvId() {
    return window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const state = {
    liveData: null,
    simOpen: false,
    simPreset: 'live',
    simCustom: { c5: 100, cw: 100, g5: 100, gw: 100 },
    clocks: new Map(), // key -> { resetMs, resetIso, windowMs, isFull, hasTimer }
    autoIntervalMs: 10000,
    lastSyncMs: 0,
    nextPollAtMs: 0,
    inFlight: false,
    pendingForce: false,
    lastError: '',
  };

  // -------------------------------------------------------------------------
  // Formatting & Visual Tier Helpers
  // -------------------------------------------------------------------------
  function tierForPct(pct) {
    if (pct === null || pct === undefined) return 'high';
    if (pct <= 0) return 'zero';
    if (pct < 15) return 'critical';
    if (pct < 40) return 'low';
    if (pct < 70) return 'mid';
    return 'high';
  }

  function fmtPct(fraction) {
    if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return '--%';
    const pct = Math.max(0, Math.min(100, fraction * 100));
    if (pct >= 99.99) return '100%';
    if (pct <= 0) return '0%';
    return `${Math.floor(pct)}%`;
  }

  function fmtCountdown(msRemaining) {
    if (!Number.isFinite(msRemaining)) return '--';
    if (msRemaining <= 0) return '已重置';
    const sec = Math.floor(msRemaining / 1000);
    const days = Math.floor(sec / 86400);
    const hrs = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (days >= 1) return `${days}d ${hrs}h`;
    if (hrs >= 1) return `${hrs}h ${String(mins).padStart(2, '0')}m`;
    if (mins >= 1) return `${mins}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  function fmtClockShort(ms) {
    if (!ms) return '--:--:--';
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  }

  function fmtLocalDateTime(iso) {
    const ms = Date.parse(iso || '');
    if (!Number.isFinite(ms)) return '未知';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  }

  function renderSyncStrip() {
    const el = $('sync-status');
    if (!el) return;
    if (state.inFlight) {
      el.textContent = '刷新中...';
      el.classList.remove('is-err');
      return;
    }
    if (state.lastError) {
      el.textContent = `刷新异常 (${state.lastError})`;
      el.classList.add('is-err');
      return;
    }
    el.classList.remove('is-err');
    const timeStr = state.lastSyncMs ? `更新 ${fmtClockShort(state.lastSyncMs)}` : '等待首次同步';
    if (state.simPreset !== 'live') {
      el.textContent = `${timeStr} · 模拟预览中`;
      return;
    }
    if (!state.autoIntervalMs) {
      el.textContent = `${timeStr} · 手动模式`;
      return;
    }
    const leftSec = Math.max(0, Math.ceil((state.nextPollAtMs - Date.now()) / 1000));
    el.textContent = `${timeStr} · ${leftSec}s后刷新`;
  }

  // -------------------------------------------------------------------------
  // Simulation Presets (for instant visual verification of every state)
  // -------------------------------------------------------------------------
  function buildSimulatedPayload() {
    const now = Date.now();
    const base = structuredClone(
      state.liveData || {
        ok: true,
        connected: true,
        user: { name: 'Preview', tierName: 'Google AI Pro' },
        activeContext: {
          mode: 'gemini',
          activeFamilies: ['gemini'],
          dualActive: false,
          primaryModelLabel: 'Gemini 4 Neon (High)',
          usedModels: [{ label: 'Gemini 4 Neon (High)', family: 'gemini' }],
          orchestratorRoles: null,
        },
        families: {
          gemini: {
            fiveHour: { remainingFraction: 0.92, resetTime: new Date(now + 4.3 * 3600e3).toISOString(), available: true, source: 'live' },
            weekly: { remainingFraction: 0.948, resetTime: new Date(now + 6.8 * 86400e3).toISOString(), available: true, source: 'live' },
            available: true,
            models: [],
          },
          claude: {
            fiveHour: { remainingFraction: 1, resetTime: null, available: true, source: 'live' },
            weekly: { remainingFraction: 1, resetTime: null, available: true, source: 'live' },
            available: true,
            models: [],
          },
        },
      }
    );

    const p = state.simPreset;
    const g = base.families.gemini;
    const c = base.families.claude;

    // Ensure simulated reset times exist for non-full previews
    const default5h = () => new Date(now + 4.2 * 3600e3).toISOString();
    const defaultWk = () => new Date(now + 5.6 * 86400e3).toISOString();
    g.fiveHour.resetTime = g.fiveHour.resetTime || default5h();
    g.weekly.resetTime = g.weekly.resetTime || defaultWk();
    c.fiveHour.resetTime = c.fiveHour.resetTime || default5h();
    c.weekly.resetTime = c.weekly.resetTime || defaultWk();

    if (p === 'claude') {
      base.activeContext = {
        mode: 'claude',
        activeFamilies: ['claude'],
        dualActive: false,
        primaryModelLabel: 'Claude Opus 5.5 (High)',
        usedModels: [{ label: 'Claude Opus 5.5 (High)', family: 'claude' }],
        orchestratorRoles: null,
      };
      c.fiveHour.remainingFraction = 0.82;
      c.weekly.remainingFraction = 0.76;
      g.fiveHour.remainingFraction = 1.0;
      g.weekly.remainingFraction = 0.89;
    } else if (p === 'gemini') {
      base.activeContext = {
        mode: 'gemini',
        activeFamilies: ['gemini'],
        dualActive: false,
        primaryModelLabel: 'Gemini 4 Neon (High)',
        usedModels: [{ label: 'Gemini 4 Neon (High)', family: 'gemini' }],
        orchestratorRoles: null,
      };
      g.fiveHour.remainingFraction = 0.88;
      g.weekly.remainingFraction = 0.78;
      c.fiveHour.remainingFraction = 1.0;
      c.weekly.remainingFraction = 1.0;
    } else if (p === 'orch-single') {
      base.activeContext = {
        mode: 'orchestrator',
        activeFamilies: ['gemini'],
        dualActive: false,
        primaryModelLabel: 'Orchestrator (Neon)',
        usedModels: [
          { label: 'Gemini 4 Neon (High)', family: 'gemini' },
          { label: 'Gemini 4 Hydrogen (Medium)', family: 'gemini' },
        ],
        orchestratorRoles: { planner: 'Gemini 4 Neon (High)', executor: 'Gemini 4 Hydrogen (Medium)' },
      };
      g.fiveHour.remainingFraction = 0.65;
      g.weekly.remainingFraction = 0.58;
      c.fiveHour.remainingFraction = 1.0;
      c.weekly.remainingFraction = 1.0;
    } else if (p === 'orch-dual') {
      base.activeContext = {
        mode: 'orchestrator',
        activeFamilies: ['gemini', 'claude'],
        dualActive: true,
        primaryModelLabel: 'Orchestrator (Neon × Claude Opus 5.5)',
        usedModels: [
          { label: 'Gemini 4 Neon (High)', family: 'gemini' },
          { label: 'Claude Opus 5.5 (High)', family: 'claude' },
        ],
        orchestratorRoles: { planner: 'Gemini 4 Neon (High)', executor: 'Claude Opus 5.5 (High)' },
      };
      g.fiveHour.remainingFraction = 0.74;
      g.weekly.remainingFraction = 0.66;
      c.fiveHour.remainingFraction = 0.52;
      c.weekly.remainingFraction = 0.48;
    } else if (p === 'low-hp') {
      base.activeContext = {
        mode: 'orchestrator',
        activeFamilies: ['gemini', 'claude'],
        dualActive: true,
        primaryModelLabel: 'Orchestrator (低血量预警)',
        usedModels: [],
        orchestratorRoles: { planner: 'Gemini 4 Carbon', executor: 'Claude Sonnet 5.5' },
      };
      g.fiveHour.remainingFraction = 0.28;
      g.weekly.remainingFraction = 0.12;
      c.fiveHour.remainingFraction = 0.09;
      c.weekly.remainingFraction = 0.34;
    } else if (p === 'claude-zero') {
      base.activeContext = {
        mode: 'claude',
        activeFamilies: ['claude'],
        dualActive: false,
        primaryModelLabel: 'Claude Opus 5.5 (High)',
        usedModels: [{ label: 'Claude Opus 5.5 (High)', family: 'claude' }],
        orchestratorRoles: null,
      };
      c.fiveHour.remainingFraction = 0;
      c.fiveHour.resetTime = new Date(now + 2.4 * 3600e3).toISOString();
      c.weekly.remainingFraction = 0.22;
      g.fiveHour.remainingFraction = 0.9;
      g.weekly.remainingFraction = 0.85;
    } else if (p === 'gemini-zero') {
      base.activeContext = {
        mode: 'gemini',
        activeFamilies: ['gemini'],
        dualActive: false,
        primaryModelLabel: 'Gemini 4 Neon (High)',
        usedModels: [{ label: 'Gemini 4 Neon (High)', family: 'gemini' }],
        orchestratorRoles: null,
      };
      g.fiveHour.remainingFraction = 0;
      g.fiveHour.resetTime = new Date(now + 1.8 * 3600e3).toISOString();
      g.weekly.remainingFraction = 0;
      g.weekly.resetTime = new Date(now + 3.2 * 86400e3).toISOString();
      c.fiveHour.remainingFraction = 0.97;
      c.weekly.remainingFraction = 0.88;
    } else if (p === 'custom') {
      g.fiveHour.remainingFraction = state.simCustom.g5 / 100;
      g.weekly.remainingFraction = state.simCustom.gw / 100;
      c.fiveHour.remainingFraction = state.simCustom.c5 / 100;
      c.weekly.remainingFraction = state.simCustom.cw / 100;
    }

    for (const fam of [g, c]) {
      for (const bucket of [fam.fiveHour, fam.weekly]) {
        const isFull = typeof bucket.remainingFraction === 'number' && bucket.remainingFraction >= 0.9999;
        bucket.isFull = isFull;
        if (isFull) bucket.resetTime = null;
        bucket.hasTimer = Boolean(bucket.resetTime) && !isFull;
        bucket.available = bucket.remainingFraction === null ? true : bucket.remainingFraction > 0;
        bucket.source = 'live';
      }
      fam.available = fam.fiveHour.available && fam.weekly.available;
    }
    return base;
  }

  function syncSlidersFromPayload(payload) {
    const g5 = Math.round((payload.families.gemini.fiveHour.remainingFraction ?? 1) * 100);
    const gw = Math.round((payload.families.gemini.weekly.remainingFraction ?? 1) * 100);
    const c5 = Math.round((payload.families.claude.fiveHour.remainingFraction ?? 1) * 100);
    const cw = Math.round((payload.families.claude.weekly.remainingFraction ?? 1) * 100);
    state.simCustom = { g5, gw, c5, cw };
    $('sim-g5').value = g5; $('sim-g5-val').textContent = `${g5}%`;
    $('sim-gw').value = gw; $('sim-gw-val').textContent = `${gw}%`;
    $('sim-c5').value = c5; $('sim-c5-val').textContent = `${c5}%`;
    $('sim-cw').value = cw; $('sim-cw-val').textContent = `${cw}%`;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function updateHpBar(fam, kind, info) {
    const key = `${fam}-${kind}`;
    const frac = typeof info?.remainingFraction === 'number' ? Math.max(0, Math.min(1, info.remainingFraction)) : null;
    const pctVal = frac === null ? null : frac * 100;
    const tier = tierForPct(pctVal);

    const pctEl = $(`pct-${key}`);
    const fillEl = $(`fill-${key}`);
    const trailEl = $(`trail-${key}`);
    const trackEl = fillEl?.parentElement;

    if (pctEl) {
      pctEl.textContent = fmtPct(frac);
      pctEl.className = `hp-pct tier-${tier}`;
      pctEl.title = pctVal === null ? '暂无数据' : `精确剩余: ${pctVal.toFixed(2)}%`;
    }
    if (trackEl) trackEl.dataset.tier = tier;

    const widthStr = pctVal === null ? '0%' : `${pctVal.toFixed(2)}%`;
    if (fillEl) fillEl.style.width = widthStr;
    if (trailEl) trailEl.style.width = widthStr;

    if (kind === 'weekly') {
      const srcEl = $(`src-${fam}-weekly`);
      if (srcEl) {
        if (info?.source === 'live') {
          srcEl.textContent = 'API 实时';
          srcEl.classList.add('is-live');
          srcEl.title = info.description || '来自 Antigravity RetrieveUserQuotaSummary 实时周限额';
        } else {
          srcEl.textContent = '暂无数据';
          srcEl.classList.remove('is-live');
          srcEl.title = '暂未获取到周限额数据';
        }
      }
    }

    const windowMs = kind === 'five' ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
    const isFull = Boolean(info?.isFull) || (frac !== null && frac >= 0.9999);
    const resetMs = isFull ? null : Date.parse(info?.resetTime || '');
    const hasTimer = !isFull && Number.isFinite(resetMs) && info?.hasTimer !== false;

    state.clocks.set(key, {
      resetMs: Number.isFinite(resetMs) ? resetMs : null,
      resetIso: isFull ? '' : (info?.resetTime || ''),
      windowMs,
      isFull,
      hasTimer,
      description: info?.description || '',
    });
    renderClock(key);
  }

  function renderClock(key) {
    const entry = state.clocks.get(key);
    const clockEl = $(`clock-${key}`);
    const timeEl = $(`time-${key}`);
    if (!clockEl || !timeEl) return;

    if (entry?.isFull) {
      timeEl.textContent = '未计时';
      clockEl.title = '配额已满（100%），产生消耗后自动开始计时';
      clockEl.classList.add('is-full');
      clockEl.classList.remove('is-ready');
      const prog = clockEl.querySelector('.clock-ring-prog');
      if (prog) prog.style.strokeDashoffset = '0';
      const hrHand = clockEl.querySelector('.clock-hand-hr');
      const minHand = clockEl.querySelector('.clock-hand-min');
      if (hrHand) hrHand.style.transform = 'rotate(0deg)';
      if (minHand) minHand.style.transform = 'rotate(0deg)';
      return;
    }

    clockEl.classList.remove('is-full');

    if (!entry || !entry.hasTimer || !entry.resetMs) {
      timeEl.textContent = '--';
      clockEl.title = entry?.description || '暂无重置时间';
      clockEl.classList.remove('is-ready');
      return;
    }

    const now = Date.now();
    const remaining = entry.resetMs - now;
    timeEl.textContent = fmtCountdown(remaining);
    clockEl.title = `重置时间: ${fmtLocalDateTime(entry.resetIso)}${entry.description ? `\n${entry.description}` : ''}`;
    clockEl.classList.toggle('is-ready', remaining <= 0);

    const ratio = Math.max(0, Math.min(1, remaining / entry.windowMs));
    const offset = CIRCUMFERENCE * (1 - ratio);
    const prog = clockEl.querySelector('.clock-ring-prog');
    if (prog) prog.style.strokeDashoffset = offset.toFixed(2);

    const d = new Date(now);
    const minDeg = d.getMinutes() * 6 + d.getSeconds() * 0.1;
    const hrDeg = (d.getHours() % 12) * 30 + d.getMinutes() * 0.5;
    const hrHand = clockEl.querySelector('.clock-hand-hr');
    const minHand = clockEl.querySelector('.clock-hand-min');
    if (hrHand) hrHand.style.transform = `rotate(${hrDeg.toFixed(1)}deg)`;
    if (minHand) minHand.style.transform = `rotate(${minDeg.toFixed(1)}deg)`;
  }

  function renderModelsDrawer(fam, models, primaryLabel) {
    const el = $(`models-${fam}`);
    if (!el) return;
    if (!models || !models.length) {
      el.innerHTML = '<div class="model-row"><span class="model-row-name">暂无模型配置数据</span><span class="model-row-pct">--</span></div>';
      return;
    }
    el.innerHTML = models
      .map((m) => {
        const isCurr = primaryLabel && m.label === primaryLabel;
        const pct = fmtPct(m.remainingFraction);
        const safeLabel = String(m.label || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        return `<div class="model-row${isCurr ? ' is-current' : ''}"><span class="model-row-name" title="${safeLabel}">${safeLabel}</span><span class="model-row-pct">${pct}</span></div>`;
      })
      .join('');
  }

  function render(payload) {
    if (!payload) return;
    const isSim = state.simPreset !== 'live';

    const connPill = $('conn-pill');
    const connLabel = $('conn-label');
    if (isSim) {
      connPill.className = 'conn-pill sim';
      connLabel.textContent = 'Preview';
    } else if (payload.connected) {
      connPill.className = 'conn-pill';
      connLabel.textContent = 'Live';
    } else {
      connPill.className = 'conn-pill offline';
      connLabel.textContent = 'Offline';
    }

    const tierEl = $('tier-label');
    if (tierEl) {
      tierEl.textContent = payload.user?.tierName
        ? `${payload.user.tierName}`
        : 'Antigravity';
    }

    const ctx = payload.activeContext || {};
    const mode = ctx.mode || 'idle';
    const activeSet = new Set(ctx.activeFamilies || []);
    const dualActive = Boolean(ctx.dualActive || (mode === 'orchestrator' && activeSet.has('claude') && activeSet.has('gemini')));

    const banner = $('mode-banner');
    banner.className = `mode-banner mode-${mode}`;
    const modeTag = $('mode-tag');
    const modeModel = $('mode-model');
    const modeChips = $('mode-chips');

    if (mode === 'orchestrator') {
      modeTag.textContent = 'Orchestrator 模式';
      modeModel.textContent = ctx.primaryModelLabel || 'Orchestrator';
      const chips = [];
      if (dualActive) {
        chips.push('<span class="mode-chip is-dual">✦ Gemini + Claude 双系协同</span>');
      } else if (activeSet.has('gemini')) {
        chips.push('<span class="mode-chip">Gemini 协同</span>');
      } else if (activeSet.has('claude')) {
        chips.push('<span class="mode-chip">Claude 协同</span>');
      }
      if (ctx.orchestratorRoles?.planner && ctx.orchestratorRoles?.executor && ctx.orchestratorRoles.planner !== ctx.orchestratorRoles.executor) {
        chips.push(`<span class="mode-chip">Plan → Exec</span>`);
      }
      modeChips.innerHTML = chips.join('');
    } else if (mode === 'claude') {
      modeTag.textContent = 'Claude 系列激活';
      modeModel.textContent = ctx.primaryModelLabel || 'Claude';
      modeChips.innerHTML = '<span class="mode-chip">单系专注</span>';
    } else if (mode === 'gemini') {
      modeTag.textContent = 'Gemini 系列激活';
      modeModel.textContent = ctx.primaryModelLabel || 'Gemini';
      modeChips.innerHTML = '<span class="mode-chip">单系专注</span>';
    } else {
      modeTag.textContent = '待机中';
      modeModel.textContent = ctx.primaryModelLabel || '等待对话模型信号';
      modeChips.innerHTML = '';
    }

    const bridge = $('synergy-bridge');
    const gAvail = payload.families?.gemini?.available !== false;
    const cAvail = payload.families?.claude?.available !== false;
    bridge.classList.toggle('hidden', !(dualActive && gAvail && cAvail));

    for (const fam of ['gemini', 'claude']) {
      const fData = payload.families?.[fam];
      if (!fData) continue;
      const card = $(`card-${fam}`);
      const statusEl = $(`status-${fam}`);
      const exhausted = !fData.available;
      const active = activeSet.has(fam) && !exhausted;

      card.classList.toggle('is-active', active);
      card.classList.toggle('is-exhausted', exhausted);
      card.classList.toggle('is-standby', !active && !exhausted);

      if (exhausted) {
        statusEl.textContent = '不可用';
        const resetTarget = !fData.fiveHour?.available ? fData.fiveHour?.resetTime : fData.weekly?.resetTime;
        const msLeft = Date.parse(resetTarget || '') - Date.now();
        $(`veil-timer-${fam}`).textContent = Number.isFinite(msLeft) && msLeft > 0
          ? `${fmtCountdown(msLeft)} 后恢复`
          : '等待额度刷新';
      } else if (active && mode === 'orchestrator') {
        statusEl.textContent = dualActive ? '双系协同' : '协同中';
      } else if (active) {
        statusEl.textContent = '使用中';
      } else {
        statusEl.textContent = '待命';
      }

      updateHpBar(fam, 'five', fData.fiveHour);
      updateHpBar(fam, 'weekly', fData.weekly);
      renderModelsDrawer(fam, fData.models, ctx.primaryModelLabel);
    }

    renderSyncStrip();
  }

  function renderCurrentView() {
    const payload = state.simPreset === 'live' ? state.liveData : buildSimulatedPayload();
    render(payload);
  }

  // -------------------------------------------------------------------------
  // Polling & Interactive Controls
  // -------------------------------------------------------------------------
  let pollTimer = null;

  function scheduleNextPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (!state.autoIntervalMs) {
      state.nextPollAtMs = 0;
      renderSyncStrip();
      return;
    }
    state.nextPollAtMs = Date.now() + state.autoIntervalMs;
    renderSyncStrip();
    pollTimer = setTimeout(() => {
      if (!document.hidden && state.simPreset === 'live') {
        refreshStatus(false);
      } else {
        scheduleNextPoll();
      }
    }, state.autoIntervalMs);
  }

  async function refreshStatus(force = false) {
    if (state.inFlight) {
      if (force) state.pendingForce = true;
      return;
    }
    state.inFlight = true;
    const btn = $('btn-refresh');
    btn.classList.add('spinning');
    renderSyncStrip();

    try {
      const q = new URLSearchParams();
      const conv = currentConvId();
      if (conv) q.set('conversationId', conv);
      if (force) q.set('force', '1');
      q.set('_t', String(Date.now()));
      const data = await apiFetch(`/api/status?${q.toString()}`);
      state.liveData = data;
      state.lastSyncMs = Date.now();
      state.lastError = data.error && !data.connected ? data.error : '';
      if (state.simPreset === 'live') {
        render(data);
        const pill = $('conn-pill');
        pill.classList.remove('pulse-sync');
        void pill.offsetWidth;
        pill.classList.add('pulse-sync');
      }
    } catch (err) {
      state.lastError = err.message || '请求失败';
      if (!state.liveData) {
        $('conn-pill').className = 'conn-pill offline';
        $('conn-label').textContent = 'Offline';
        $('mode-model').textContent = `连接重试中 (${state.lastError})`;
      }
    } finally {
      state.inFlight = false;
      btn.classList.remove('spinning');
      scheduleNextPoll();
      if (state.pendingForce) {
        state.pendingForce = false;
        refreshStatus(true);
      }
    }
  }

  // Details drawers
  document.querySelectorAll('.details-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = $(btn.dataset.target);
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      target.classList.toggle('hidden', open);
    });
  });

  $('btn-refresh').addEventListener('click', () => {
    if (state.simPreset !== 'live') setPreset('live');
    refreshStatus(true);
  });

  $('auto-interval').addEventListener('change', (e) => {
    state.autoIntervalMs = Number(e.target.value) || 0;
    scheduleNextPoll();
  });

  // Auto-refresh immediately when pane becomes visible or gains focus
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.simPreset === 'live') refreshStatus(false);
  });
  window.addEventListener('focus', () => {
    if (state.simPreset === 'live' && Date.now() - state.lastSyncMs > 2500) {
      refreshStatus(false);
    }
  });

  // Simulation drawer controls
  $('btn-sim').addEventListener('click', () => {
    state.simOpen = !state.simOpen;
    $('btn-sim').setAttribute('aria-pressed', String(state.simOpen));
    $('sim-drawer').classList.toggle('hidden', !state.simOpen);
    if (state.simOpen && state.liveData) syncSlidersFromPayload(state.liveData);
  });

  function setPreset(preset) {
    state.simPreset = preset;
    document.querySelectorAll('.sim-chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.preset === preset);
    });
    const viewPayload = preset === 'live' ? state.liveData : buildSimulatedPayload();
    if (viewPayload && preset !== 'custom') syncSlidersFromPayload(viewPayload);
    renderCurrentView();
  }

  document.querySelectorAll('.sim-chip').forEach((chip) => {
    chip.addEventListener('click', () => setPreset(chip.dataset.preset));
  });

  $('sim-exit').addEventListener('click', () => setPreset('live'));

  for (const [id, key] of [
    ['sim-c5', 'c5'],
    ['sim-cw', 'cw'],
    ['sim-g5', 'g5'],
    ['sim-gw', 'gw'],
  ]) {
    $(id).addEventListener('input', (e) => {
      const val = Number(e.target.value);
      state.simCustom[key] = val;
      $(`${id}-val`).textContent = `${val}%`;
      state.simPreset = 'custom';
      document.querySelectorAll('.sim-chip').forEach((c) => c.classList.remove('active'));
      renderCurrentView();
    });
  }

  // 1-second clock & sync-countdown tick
  setInterval(() => {
    for (const key of state.clocks.keys()) renderClock(key);
    renderSyncStrip();
  }, 1000);

  refreshStatus(true);
})();
