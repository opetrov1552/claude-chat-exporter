// Claude Code — File Bundle Exporter
//
// Collects the contents of files that appear in a Claude Code web session
// (claude.ai/code/session_...) straight from the session events API, and
// downloads them as a single markdown bundle with provenance: when each file
// was created/changed and in response to which of your messages.
//
// How it works: file contents live in the transcript as Write inputs (raw),
// Read results ("cat -n" line-numbered), and Edit fragments. For each file we
// take the latest full snapshot (Write/Read) and replay the edits made after
// it, then annotate the result with its change history.
//
// Usage: open a Claude Code session at claude.ai/code/..., open the browser
// console, paste this whole file, press Enter. A markdown bundle downloads.
//
// This is a SEPARATE tool from claude-chat-exporter.js (the transcript
// exporter); use that one to export the conversation itself.

function setupCodeFilesExporter() {
  // ---- What to collect / how to present it ------------------------------
  const OPTIONS = {
    extensions: ['.md'],     // only collect files ending in these; [] / null = all files
    includeProvenance: true, // per-file origin + change history grouped by your turns
    localTime: false         // false = UTC timestamps, true = your browser's local time
  };

  // ---- Small standalone helpers ----------------------------------------
  function createStatusDiv() {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed; top: 10px; right: 10px; z-index: 10000;
      background: #2196F3; color: white; padding: 10px 15px;
      border-radius: 5px; font-family: monospace; font-size: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3); max-width: 320px;
    `;
    document.body.appendChild(el);
    return el;
  }

  function downloadMarkdown(content, filename) {
    const blob = new Blob([content], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  function sanitizeFilename(name) {
    const cleaned = (name || '')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .substring(0, 80);
    return cleaned || 'claude_code_session';
  }

  const statusDiv = createStatusDiv();
  const sessionId = window.location.pathname.split('/').filter(Boolean).pop();

  // ---- Session API access ----------------------------------------------
  // The /v1 gateway routes/authorizes by the anthropic-* client headers the
  // web app sends; a plain fetch without them returns 404. Mirror them.
  function getCookie(name) {
    const escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&');
    return document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`))?.[1];
  }

  function findStored(keyHints, valuePattern) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        let value = localStorage.getItem(key) || '';
        try { const parsed = JSON.parse(value); if (typeof parsed === 'string') value = parsed; } catch (_) {}
        if (keyHints.some(h => key.toLowerCase().includes(h))) return value;
        if (valuePattern) { const m = value.match(valuePattern); if (m) return m[0]; }
      }
    } catch (_) {}
    return null;
  }

  function buildApiHeaders() {
    const headers = {
      'Accept': '*/*',
      'Content-Type': 'application/json',
      'anthropic-client-platform': 'web_claude_ai',
      'anthropic-version': '2023-06-01',
      'anthropic-client-version': '1.0.0'
    };
    const org = getCookie('lastActiveOrg');
    if (org) headers['x-organization-uuid'] = decodeURIComponent(org);
    const anonId = findStored(['anonymous-id', 'anonymousid'], /claudeai\.v1\.[0-9a-f-]{36}/i);
    if (anonId) headers['anthropic-anonymous-id'] = anonId;
    const deviceId = findStored(['device-id', 'deviceid', 'device_id'], null);
    if (deviceId) headers['anthropic-device-id'] = deviceId;
    return headers;
  }

  const API_HEADERS = buildApiHeaders();

  async function apiGet(path) {
    const response = await fetch(`${window.location.origin}${path}`, {
      credentials: 'include',
      headers: API_HEADERS
    });
    if (!response.ok) {
      const hint = response.status === 404
        ? ' — the session API rejected the request; open the Code session while logged in and retry'
        : '';
      throw new Error(`API ${response.status} for ${path}${hint}`);
    }
    return response.json();
  }

  async function fetchSessionMeta() {
    try {
      return await apiGet(`/v1/sessions/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      console.warn('Could not fetch session metadata:', error);
      return null;
    }
  }

  async function fetchAllEvents() {
    const events = [];
    let afterId = null;
    for (let page = 0; page < 500; page++) {
      const query = `limit=500${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
      const data = await apiGet(`/v1/sessions/${encodeURIComponent(sessionId)}/events?${query}`);
      const batch = Array.isArray(data?.data) ? data.data : [];
      events.push(...batch);
      statusDiv.textContent = `Fetching events… ${events.length}`;
      if (!data?.has_more || !data?.last_id || batch.length === 0) break;
      afterId = data.last_id;
    }
    return events;
  }

  // ---- Transcript parsing ----------------------------------------------
  function matchesExt(path) {
    const ex = OPTIONS.extensions;
    if (!ex || ex.length === 0) return true;
    const lower = path.toLowerCase();
    return ex.some(e => lower.endsWith(e.toLowerCase()));
  }

  // Read results come back "cat -n" style ("<n>\t<line>"); strip that prefix.
  function stripLineNumbers(text) {
    return String(text).split('\n').map(l => l.replace(/^\s*\d+\t/, '')).join('\n');
  }

  function oneLine(s, n = 72) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    if (OPTIONS.localTime) {
      return d.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  function shortTime(iso) {
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return OPTIONS.localTime ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  function humanText(ev) {
    const c = ev.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(b => b?.type === 'text').map(b => b.text).join(' ');
    return '';
  }

  function isUserText(ev) {
    if (ev?.type !== 'user') return false;
    const c = ev.message?.content;
    if (typeof c === 'string') return true;
    if (Array.isArray(c)) return c.some(b => b?.type === 'text') && !c.some(b => b?.type === 'tool_result');
    return false;
  }

  // Harness-injected user-role messages that aren't things you typed.
  const INJECTED = /^\s*(<github-webhook-activity>|<task-notification>|<system-reminder>|<local-command|<command-(name|message|args|stdout|stderr)>|<bash-|<user-prompt-submit-hook>|Caveat:)/;
  function isGenuineTurn(ev) {
    return isUserText(ev) && !INJECTED.test(humanText(ev));
  }

  // Walk the transcript, gather per-file snapshots/edits, reconstruct content.
  function collectFiles(events) {
    const sorted = [...events].sort((a, b) => (a?.created_at || '').localeCompare(b?.created_at || ''));

    // tool_use id -> result text (results arrive as user-role tool_result blocks)
    const results = new Map();
    for (const ev of sorted) {
      if (ev?.type !== 'user' || !Array.isArray(ev.message?.content)) continue;
      for (const blk of ev.message.content) {
        if (blk?.type !== 'tool_result') continue;
        let c = blk.content;
        if (Array.isArray(c)) c = c.map(x => (typeof x === 'string' ? x : x?.text ?? '')).join('\n');
        results.set(blk.tool_use_id, String(c ?? ''));
      }
    }

    // your genuine messages, for provenance attribution
    const turns = [];
    for (const ev of sorted) if (isGenuineTurn(ev)) turns.push({ ts: ev.created_at, preview: oneLine(humanText(ev)) });
    const turnAt = ts => {
      let idx = -1;
      for (let i = 0; i < turns.length; i++) { if (turns[i].ts <= ts) idx = i; else break; }
      return idx;
    };

    const files = {}; // path -> { ops, hist }
    const ensure = p => (files[p] ||= { ops: [], hist: [] });

    for (const ev of sorted) {
      if (ev?.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
      for (const blk of ev.message.content) {
        if (blk?.type !== 'tool_use') continue;
        const input = blk.input || {};
        const path = input.file_path;
        if (!path || !matchesExt(path)) continue;
        const f = ensure(path);

        if (blk.name === 'Write') {
          f.ops.push({ kind: 'snapshot', text: String(input.content ?? '') });
          f.hist.push({ ts: ev.created_at, op: 'Write' });
        } else if (blk.name === 'Read') {
          const r = results.get(blk.id);
          if (r != null) f.ops.push({ kind: 'snapshot', text: stripLineNumbers(r) });
          f.hist.push({ ts: ev.created_at, op: 'Read' });
        } else if (blk.name === 'Edit') {
          f.ops.push({ kind: 'edit', edits: [{ oldStr: input.old_string ?? '', newStr: input.new_string ?? '', all: !!input.replace_all }] });
          f.hist.push({ ts: ev.created_at, op: 'Edit' });
        } else if (blk.name === 'MultiEdit' && Array.isArray(input.edits)) {
          f.ops.push({ kind: 'edit', edits: input.edits.map(e => ({ oldStr: e.old_string ?? '', newStr: e.new_string ?? '', all: !!e.replace_all })) });
          f.hist.push({ ts: ev.created_at, op: 'Edit' });
        }
      }
    }

    // reconstruct: latest snapshot + replay later edits
    for (const path of Object.keys(files)) {
      const ops = files[path].ops;
      let baseIdx = -1;
      for (let i = ops.length - 1; i >= 0; i--) { if (ops[i].kind === 'snapshot') { baseIdx = i; break; } }
      if (baseIdx < 0) { files[path].status = 'no-base'; files[path].content = null; continue; }

      let content = ops[baseIdx].text;
      let conflicts = 0;
      for (let i = baseIdx + 1; i < ops.length; i++) {
        const o = ops[i];
        if (o.kind === 'snapshot') { content = o.text; continue; }
        for (const e of o.edits) {
          if (e.oldStr === '') continue;
          if (content.includes(e.oldStr)) {
            content = e.all ? content.split(e.oldStr).join(e.newStr) : content.replace(e.oldStr, e.newStr);
          } else {
            conflicts++;
          }
        }
      }
      files[path].status = conflicts > 0 ? `partial (${conflicts} edit(s) not applied)` : 'ok';
      files[path].content = content;
    }

    return { files, turns, turnAt };
  }

  function buildBundle(meta, data) {
    const { files, turns, turnAt } = data;
    const title = (meta?.title || 'Claude Code session').trim();
    const paths = Object.keys(files).sort((a, b) => {
      const rank = p => (p.startsWith('/home/') ? 0 : 1);
      return (rank(a) - rank(b)) || a.localeCompare(b);
    });

    let md = `# Files from session: ${title}\n`;
    md += `# Reconstructed from the Claude Code transcript${OPTIONS.includeProvenance ? ' with provenance' : ''}.\n`;
    md += `# Times are ${OPTIONS.localTime ? 'local' : 'UTC'}. "Turn N" = your N-th genuine message.\n`;
    md += `# Files: ${paths.length}  |  Your turns: ${turns.length}\n\n`;

    if (OPTIONS.includeProvenance) {
      md += `## Your messages (turns)\n`;
      turns.forEach((t, i) => { md += `- Turn ${i + 1} — ${fmtTime(t.ts)} — ${t.preview}\n`; });
      md += `\n`;
    }

    md += `## Files\n`;
    for (const p of paths) md += `- ${p}${files[p].status === 'ok' ? '' : `  [${files[p].status}]`}\n`;
    md += `\n`;

    const SEP = '='.repeat(72);
    for (const p of paths) {
      const f = files[p];
      md += `\n${SEP}\nFILE: ${p}${f.status === 'ok' ? '' : `   [${f.status}]`}\n${SEP}\n`;

      if (OPTIONS.includeProvenance) {
        const writes = f.hist.filter(x => x.op === 'Write').length;
        const edits = f.hist.filter(x => x.op === 'Edit').length;
        const reads = f.hist.filter(x => x.op === 'Read').length;
        const changes = f.hist.filter(x => x.op !== 'Read');
        const firstRead = f.hist.find(x => x.op === 'Read');
        const origin = changes.length && (!firstRead || changes[0].ts <= firstRead.ts)
          ? 'created during session'
          : (firstRead ? 'pre-existing (first read in session)' : 'unknown');

        md += `Origin     : ${origin}\n`;
        md += `Operations : ${writes} Write, ${edits} Edit, ${reads} Read\n`;

        if (changes.length) {
          const groups = [];
          for (const c of changes) {
            const ti = turnAt(c.ts);
            const g = groups[groups.length - 1];
            if (g && g.ti === ti) { g.end = c.ts; g.kinds[c.op] = (g.kinds[c.op] || 0) + 1; }
            else groups.push({ ti, start: c.ts, end: c.ts, kinds: { [c.op]: 1 } });
          }
          md += `Changed in :\n`;
          for (const g of groups) {
            const span = shortTime(g.start) === shortTime(g.end) ? fmtTime(g.start) : `${fmtTime(g.start)}–${shortTime(g.end)}`;
            const kinds = Object.entries(g.kinds).map(([k, v]) => `${v}× ${k}`).join(', ');
            const label = g.ti >= 0 ? `Turn ${g.ti + 1}: ${turns[g.ti].preview}` : '(before your first message / automation)';
            md += `  • ${span}  [${kinds}]  ${label}\n`;
          }
        }
      }

      md += `\n----- content -----\n\n`;
      md += f.content == null
        ? `(content not available — only edited via fragments, never read or written in full)\n`
        : `${f.content.replace(/\s+$/, '')}\n`;
    }

    return md;
  }

  async function run() {
    try {
      if (!sessionId || !sessionId.startsWith('session_')) {
        throw new Error('Open this on a claude.ai/code/session_... page.');
      }

      statusDiv.textContent = 'Fetching session…';
      const meta = await fetchSessionMeta();

      const events = await fetchAllEvents();
      if (events.length === 0) throw new Error('No events returned for this session.');

      statusDiv.textContent = 'Reconstructing files…';
      const data = collectFiles(events);
      const count = Object.keys(data.files).length;
      if (count === 0) {
        const want = OPTIONS.extensions?.length ? OPTIONS.extensions.join(', ') : '(any)';
        throw new Error(`No files matching ${want} found in this session.`);
      }

      const md = buildBundle(meta, data);
      const stem = sanitizeFilename(meta?.title || sessionId);
      const suffix = OPTIONS.extensions && OPTIONS.extensions.length === 1
        ? `${OPTIONS.extensions[0].replace(/^\./, '')}_files`
        : 'file_bundle';
      const filename = `${stem}__${suffix}.md`;
      downloadMarkdown(md, filename);

      statusDiv.textContent = `✅ ${count} file(s) → ${filename}`;
      statusDiv.style.background = '#4CAF50';
      console.log(`🎉 Collected ${count} file(s)`);
    } catch (error) {
      statusDiv.textContent = `Error: ${error.message}`;
      statusDiv.style.background = '#f44336';
      console.error('File export failed:', error);
    } finally {
      setTimeout(() => { if (document.body.contains(statusDiv)) document.body.removeChild(statusDiv); }, 5000);
    }
  }

  run();
}

// Run the file-bundle exporter
setupCodeFilesExporter();
