import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function classifyFamily(name) {
  const s = String(name || '').toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(s)) return 'claude';
  if (/gemini|neon|carbon|argon|hydrogen|orchestrator/.test(s)) return 'gemini';
  return 'other';
}

function resolveDataDir() {
  if (process.env.PLUGIN_DATA) return process.env.PLUGIN_DATA;
  return join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'aigirl-quota');
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    const timer = setTimeout(() => resolve(raw), 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(raw); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(raw); });
    process.stdin.resume();
  });
}

async function main() {
  try {
    const raw = (await readStdin()).trim();
    if (!raw) {
      process.stdout.write('{}');
      return;
    }
    const payload = JSON.parse(raw);
    const conversationId = String(payload.conversationId || '').trim();
    const modelName = String(payload.modelName || '').trim();
    const hookEventName = String(payload.hookEventName || '').trim();

    if (!conversationId) {
      process.stdout.write('{}');
      return;
    }

    const dataDir = resolveDataDir();
    mkdirSync(dataDir, { recursive: true });
    const filePath = join(dataDir, 'live_model.json');

    let state = { byConversation: {}, latest: null };
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        state.byConversation = parsed.byConversation && typeof parsed.byConversation === 'object' ? parsed.byConversation : {};
        state.latest = parsed.latest || null;
      }
    } catch {
      // Fresh state file
    }

    const now = Date.now();
    const isoNow = new Date(now).toISOString();
    const family = classifyFamily(modelName);
    const existing = state.byConversation[conversationId] || { recentModels: [] };
    const cutoff = now - 30 * 60 * 1000;

    let recent = Array.isArray(existing.recentModels)
      ? existing.recentModels.filter((r) => r && typeof r.ts === 'number' && r.ts >= cutoff)
      : [];

    if (modelName) {
      const last = recent[recent.length - 1];
      if (!last || last.model !== modelName || now - last.ts > 5000) {
        recent.push({ model: modelName, family, ts: now });
      } else {
        last.ts = now;
      }
      if (recent.length > 12) recent = recent.slice(-12);
    }

    state.byConversation[conversationId] = {
      lastModel: modelName || existing.lastModel || '',
      lastFamily: modelName ? family : (existing.lastFamily || 'other'),
      lastEvent: hookEventName || existing.lastEvent || '',
      transcriptPath: payload.transcriptPath || existing.transcriptPath || '',
      updatedAt: isoNow,
      updatedMs: now,
      recentModels: recent,
    };

    // Prune stale conversations beyond 50 entries
    const entries = Object.entries(state.byConversation);
    if (entries.length > 50) {
      entries.sort((a, b) => (b[1]?.updatedMs || 0) - (a[1]?.updatedMs || 0));
      state.byConversation = Object.fromEntries(entries.slice(0, 50));
    }

    if (modelName) {
      state.latest = {
        conversationId,
        model: modelName,
        family,
        hookEventName,
        updatedAt: isoNow,
        updatedMs: now,
      };
    }

    const serialized = JSON.stringify(state, null, 2);
    const tmpPath = join(dataDir, `live_model.${process.pid}.tmp`);
    try {
      writeFileSync(tmpPath, serialized, 'utf8');
      renameSync(tmpPath, filePath);
    } catch {
      writeFileSync(filePath, serialized, 'utf8');
    }
  } catch {
    // Never fail or block an agent hook
  }
  process.stdout.write('{}');
}

main();
