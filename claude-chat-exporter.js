// ---------------------------------------------------------------------------
// Shared helpers (used by both the chat and Claude Code session exporters)
// ---------------------------------------------------------------------------

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

// Format ISO timestamp to readable format
function formatTimestamp(isoString) {
  if (!isoString) return null;
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

// Turn an arbitrary conversation title into a safe, lowercase filename stem
function sanitizeFilename(name) {
  const cleaned = (name || '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .substring(0, 100);
  return cleaned || 'claude_conversation';
}

// Decide which kind of Claude page we're on so we can route to the right
// exporter. Regular chats live at /chat/<uuid>; Claude Code web sessions live
// at /code/<session_...> and use a completely different DOM and API.
function detectPageType() {
  const path = window.location.pathname;
  const id = path.split('/').filter(Boolean).pop() || '';
  if (path.includes('/code/') || id.startsWith('session_')) return 'code';
  if (path.includes('/chat/')) return 'chat';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Chat exporter — claude.ai/chat/<id> conversations
//
// Uses Claude's own per-message copy buttons for perfect markdown fidelity.
// ---------------------------------------------------------------------------

function setupClaudeExporter() {
  const originalWriteText = navigator.clipboard.writeText;
  const capturedResponses = [];
  const humanMessages = [];
  let conversationData = null;
  let currentCapture = capturedResponses;
  let interceptorActive = true;

  // DOM Selectors - easily modifiable if Claude's UI changes
  const SELECTORS = {
    copyButton: 'button[data-testid="action-bar-copy"]',
    conversationTitle: '[data-testid="chat-title-button"] .truncate, button[data-testid="chat-title-button"] div.truncate',
    messageActionsGroup: '[role="group"][aria-label="Message actions"]',
    feedbackButton: 'button[aria-label="Give positive feedback"]'
  };

  const DELAYS = {
    copy: 100
  };

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Fetch conversation data from Claude API to get timestamps
  async function fetchConversationData() {
    try {
      const conversationId = window.location.pathname.split('/').pop();
      const orgId = document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1];

      if (!conversationId || !orgId) {
        console.warn('Could not get conversation/org ID');
        return null;
      }

      const url = `/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;

      const response = await fetch(url, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        console.warn(`API error: ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.warn('Failed to fetch conversation data:', error);
      return null;
    }
  }

  // Build a content → timestamp map for human messages from API response.
  // Matching by content avoids index misalignment caused by hidden/system
  // messages that the API returns but the UI does not display.
  function getMessageTimestamps(data) {
    const map = new Map();
    if (!data?.chat_messages) return map;

    for (const msg of data.chat_messages) {
      if (msg.sender === 'human') {
        const text = msg.content?.map(c => c.text ?? '').join('').trim();
        if (text) map.set(text, formatTimestamp(msg.created_at));
      }
    }

    return map;
  }

  function getConversationTitle() {
    // First try to get from API data
    if (conversationData?.name) {
      const title = conversationData.name.trim();
      if (title && title !== 'New conversation') {
        return sanitizeFilename(title);
      }
    }

    // Fallback to DOM
    const titleElement = document.querySelector(SELECTORS.conversationTitle);
    const title = titleElement?.textContent?.trim();

    if (!title || title === 'Claude' || title.includes('New conversation')) {
      return 'claude_conversation';
    }

    return sanitizeFilename(title);
  }

  // Intercept clipboard writes and route to the active capture target
  navigator.clipboard.writeText = function(text) {
    if (interceptorActive && text) {
      const type = currentCapture === humanMessages ? 'user' : 'claude';
      console.log(`📋 Captured ${type} message ${currentCapture.length + 1}`);
      currentCapture.push({ type, content: text });
      updateStatus();
    }
  };

  // Create status indicator
  const statusDiv = createStatusDiv();

  function updateStatus() {
    statusDiv.textContent = `Human: ${humanMessages.length} | Claude: ${capturedResponses.length}`;
  }

  // Returns copy buttons from action bars filtered by message type.
  // claudeOnly=true  → action bars WITH a feedback button (Claude responses)
  // claudeOnly=false → action bars WITHOUT a feedback button (human messages)
  function getCopyButtons(claudeOnly) {
    const actionGroups = document.querySelectorAll(SELECTORS.messageActionsGroup);
    const buttons = [];
    actionGroups.forEach(group => {
      const hasFeedback = !!group.querySelector(SELECTORS.feedbackButton);
      if (hasFeedback === claudeOnly) {
        const copyBtn = group.querySelector(SELECTORS.copyButton);
        if (copyBtn) buttons.push(copyBtn);
      }
    });
    return buttons;
  }

  async function triggerCopyButtons(buttons) {
    for (let i = 0; i < buttons.length; i++) {
      try {
        if (buttons[i].offsetParent !== null) {
          buttons[i].scrollIntoView({ behavior: 'instant', block: 'nearest' });
          buttons[i].click();
          console.log(`🖱️ Clicked copy button ${i + 1}/${buttons.length}`);
        }
      } catch (error) {
        console.warn(`Failed to click button ${i + 1}:`, error);
      }

      // Only delay between clicks, not after the last one
      if (i < buttons.length - 1) {
        await delay(DELAYS.copy);
      }
    }
  }

  function buildMarkdown(timestamps) {
    let markdown = "# Conversation with Claude\n\n";
    const maxLength = Math.max(humanMessages.length, capturedResponses.length);

    for (let i = 0; i < maxLength; i++) {
      if (i < humanMessages.length && humanMessages[i].content) {
        const ts = timestamps?.get(humanMessages[i].content?.trim());
        const header = ts ? `## Human (${ts}):` : `## Human:`;
        markdown += `${header}\n\n${humanMessages[i].content}\n\n---\n\n`;
      }
      if (i < capturedResponses.length) {
        markdown += `## Claude:\n\n${capturedResponses[i].content}\n\n---\n\n`;
      }
    }

    return markdown;
  }

  async function waitForClipboardOperations(targetArray, expectedCount) {
    const maxWaitTime = 2000;
    const checkInterval = 100;
    let elapsed = 0;

    while (elapsed < maxWaitTime) {
      if (targetArray.length >= expectedCount) {
        console.log(`✅ All ${expectedCount} responses captured in ${elapsed}ms`);
        return;
      }
      await delay(checkInterval);
      elapsed += checkInterval;
    }

    console.warn(`⚠️ Timeout: Only captured ${targetArray.length}/${expectedCount} responses`);
  }

  async function startExport() {
    try {
      // Fetch conversation data from API (for timestamps and title)
      statusDiv.textContent = 'Fetching conversation data...';
      conversationData = await fetchConversationData();
      const timestamps = getMessageTimestamps(conversationData);

      if (conversationData) {
        console.log(`📅 Got timestamps for ${timestamps.size} human messages`);
      }

      const humanButtons = getCopyButtons(false);
      const claudeButtons = getCopyButtons(true);

      if (humanButtons.length === 0 && claudeButtons.length === 0) {
        throw new Error('No copy buttons found!');
      }

      // Phase 1: Human messages
      statusDiv.textContent = 'Copying human messages...';
      currentCapture = humanMessages;
      await triggerCopyButtons(humanButtons);
      await waitForClipboardOperations(humanMessages, humanButtons.length);

      // Phase 2: Claude responses
      statusDiv.textContent = 'Copying Claude responses...';
      currentCapture = capturedResponses;
      await triggerCopyButtons(claudeButtons);
      await waitForClipboardOperations(capturedResponses, claudeButtons.length);

      completeExport(timestamps);

    } catch (error) {
      statusDiv.textContent = `Error: ${error.message}`;
      statusDiv.style.background = '#f44336';
      console.error('Export failed:', error);
    } finally {
      setTimeout(cleanup, 3000);
    }
  }

  function completeExport(timestamps) {
    interceptorActive = false;

    if (humanMessages.length === 0 && capturedResponses.length === 0) {
      statusDiv.textContent = 'No messages captured!';
      statusDiv.style.background = '#f44336';
      return;
    }

    const markdown = buildMarkdown(timestamps);
    const filename = `${getConversationTitle()}.md`;
    downloadMarkdown(markdown, filename);

    statusDiv.textContent = `✅ Downloaded: ${filename}`;
    statusDiv.style.background = '#4CAF50';

    console.log('🎉 Export complete!');
  }

  function cleanup() {
    navigator.clipboard.writeText = originalWriteText;
    if (document.body.contains(statusDiv)) {
      document.body.removeChild(statusDiv);
    }
  }

  // Initialize
  updateStatus();
  setTimeout(startExport, 1000);
}

// ---------------------------------------------------------------------------
// Claude Code session exporter — claude.ai/code/<session_...> sessions
//
// Code sessions don't expose the chat copy buttons and their transcript is
// virtualized (off-screen messages aren't in the DOM), so we read the full
// transcript straight from the session events API instead.
//
// Two outputs from one run (the second is optional, see OPTIONS):
//   1. the conversation transcript (human prompts + Claude replies + tools)
//   2. a bundle of the files the session touched (.md by default),
//      reconstructed from the transcript with provenance
// ---------------------------------------------------------------------------

function setupCodeSessionExporter() {
  // Toggle what ends up in the exports.
  const OPTIONS = {
    // --- transcript ---
    includeThinking: false,     // Claude's extended-thinking blocks
    includeToolCalls: true,     // compact one-line markers for each tool call
    includeToolResults: false,  // raw tool output (verbose; off by default)

    // --- file bundle (also download the contents of files the session
    //     touched, reconstructed from Write/Read/Edit events) ---
    exportFiles: true,          // set false to export only the transcript
    fileExtensions: ['.md'],    // which files to collect; [] / null = all files
    fileProvenance: true,       // per-file origin + change history by your turns
    localTime: false            // bundle timestamps: false = UTC, true = local
  };

  const statusDiv = createStatusDiv();
  const sessionId = window.location.pathname.split('/').filter(Boolean).pop();

  function getCookie(name) {
    const escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&');
    return document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`))?.[1];
  }

  // Best-effort lookup of an app-generated value the page persists in
  // localStorage (keys/values vary, so match by key hint then by value shape).
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

  // The /v1 API gateway routes/authorizes by these headers; a plain fetch
  // without them gets a 404. We mirror the web app: static client headers
  // plus the org id and telemetry ids the page already has.
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

  // Walk the paginated events endpoint until has_more is false.
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

  // A human turn is a user-role event whose content is plain text — tool
  // results are also delivered as user-role events, so exclude those.
  function isHumanMessage(ev) {
    if (ev?.type !== 'user') return false;
    const content = ev.message?.content;
    if (typeof content === 'string') return true;
    if (Array.isArray(content)) {
      const hasText = content.some(b => b?.type === 'text');
      const hasToolResult = content.some(b => b?.type === 'tool_result');
      return hasText && !hasToolResult;
    }
    return false;
  }

  function humanText(ev) {
    const content = ev.message?.content;
    if (typeof content === 'string') return content;
    return content.filter(b => b?.type === 'text').map(b => b.text).join('\n\n');
  }

  // Pick the most informative field from a tool's input for a one-line summary.
  function toolBrief(input) {
    const candidate = input?.command ?? input?.file_path ?? input?.pattern ??
      input?.query ?? input?.path ?? input?.skill ?? input?.description ??
      input?.title ?? input?.method;
    if (typeof candidate !== 'string') return '';
    const brief = candidate.replace(/\s+/g, ' ').trim();
    return brief.length > 100 ? `${brief.slice(0, 100)}…` : brief;
  }

  function toolResultText(block) {
    let content = block?.content;
    if (Array.isArray(content)) {
      content = content.map(c => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
    }
    content = String(content ?? '');
    return content.length > 1500 ? `${content.slice(0, 1500)}\n…(truncated)` : content;
  }

  function buildMarkdown(meta, events) {
    const sorted = [...events].sort(
      (a, b) => (a?.created_at || '').localeCompare(b?.created_at || '')
    );

    const title = meta?.title?.trim() || 'Claude Code session';
    const model = meta?.external_metadata?.model;

    let md = `# ${title}\n\n`;
    if (model) md += `_Model: ${model}_\n\n`;

    let wroteSection = false;  // have we emitted any turn yet?
    let inClaude = false;      // are we currently inside a Claude response?

    const ensureClaudeHeader = () => {
      if (!inClaude) {
        md += `## Claude:\n\n`;
        inClaude = true;
        wroteSection = true;
      }
    };

    for (const ev of sorted) {
      if (isHumanMessage(ev)) {
        if (wroteSection) md += `---\n\n`;
        const ts = formatTimestamp(ev.created_at);
        md += `## Human${ts ? ` (${ts})` : ''}:\n\n${humanText(ev).trim()}\n\n`;
        wroteSection = true;
        inClaude = false;
        continue;
      }

      if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (!block || typeof block !== 'object') continue;

          if (block.type === 'text' && block.text?.trim()) {
            ensureClaudeHeader();
            md += `${block.text.trim()}\n\n`;
          } else if (block.type === 'thinking' && OPTIONS.includeThinking && block.thinking?.trim()) {
            ensureClaudeHeader();
            const quoted = block.thinking.trim().split('\n').map(l => `> ${l}`).join('\n');
            md += `> 💭 _Thinking:_\n>\n${quoted}\n\n`;
          } else if (block.type === 'tool_use' && OPTIONS.includeToolCalls) {
            ensureClaudeHeader();
            const brief = toolBrief(block.input);
            md += `> 🔧 \`${block.name}\`${brief ? `: ${brief}` : ''}\n\n`;
          }
        }
        continue;
      }

      if (OPTIONS.includeToolResults && ev?.type === 'user' && Array.isArray(ev.message?.content)) {
        const results = ev.message.content.filter(b => b?.type === 'tool_result');
        for (const result of results) {
          ensureClaudeHeader();
          md += '```\n' + toolResultText(result) + '\n```\n\n';
        }
      }
    }

    if (wroteSection) md += `---\n`;
    return md;
  }

  // ---- File bundle helpers ---------------------------------------------
  // File contents live in the transcript as Write inputs (raw), Read results
  // ("cat -n" line-numbered), and Edit fragments. For each file we take the
  // latest full snapshot and replay the edits made after it.

  function matchesExt(path) {
    const ex = OPTIONS.fileExtensions;
    if (!ex || ex.length === 0) return true;
    const lower = path.toLowerCase();
    return ex.some(e => lower.endsWith(e.toLowerCase()));
  }

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

  // Harness-injected user-role messages that aren't things you typed.
  const INJECTED = /^\s*(<github-webhook-activity>|<task-notification>|<system-reminder>|<local-command|<command-(name|message|args|stdout|stderr)>|<bash-|<user-prompt-submit-hook>|Caveat:)/;
  function isGenuineTurn(ev) {
    return isHumanMessage(ev) && !INJECTED.test(humanText(ev));
  }

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

  function buildFileBundle(meta, data) {
    const { files, turns, turnAt } = data;
    const title = (meta?.title || 'Claude Code session').trim();
    const paths = Object.keys(files).sort((a, b) => {
      const rank = p => (p.startsWith('/home/') ? 0 : 1);
      return (rank(a) - rank(b)) || a.localeCompare(b);
    });

    let md = `# Files from session: ${title}\n`;
    md += `# Reconstructed from the Claude Code transcript${OPTIONS.fileProvenance ? ' with provenance' : ''}.\n`;
    md += `# Times are ${OPTIONS.localTime ? 'local' : 'UTC'}. "Turn N" = your N-th genuine message.\n`;
    md += `# Files: ${paths.length}  |  Your turns: ${turns.length}\n\n`;

    if (OPTIONS.fileProvenance) {
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

      if (OPTIONS.fileProvenance) {
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

  async function startExport() {
    try {
      if (!sessionId || !sessionId.startsWith('session_')) {
        throw new Error('Could not determine Claude Code session ID from URL.');
      }

      statusDiv.textContent = 'Fetching session…';
      const meta = await fetchSessionMeta();

      const events = await fetchAllEvents();
      if (events.length === 0) {
        throw new Error('No events returned for this session.');
      }
      console.log(`📜 Fetched ${events.length} events`);

      const stem = sanitizeFilename(meta?.title || sessionId);

      // 1) transcript
      statusDiv.textContent = 'Building transcript…';
      const transcriptName = `${stem}.md`;
      downloadMarkdown(buildMarkdown(meta, events), transcriptName);
      console.log(`📄 ${transcriptName}`);
      const downloaded = [transcriptName];

      // 2) file bundle (optional)
      if (OPTIONS.exportFiles) {
        statusDiv.textContent = 'Reconstructing files…';
        const data = collectFiles(events);
        const count = Object.keys(data.files).length;
        if (count > 0) {
          const suffix = OPTIONS.fileExtensions && OPTIONS.fileExtensions.length === 1
            ? `${OPTIONS.fileExtensions[0].replace(/^\./, '')}_files`
            : 'file_bundle';
          const bundleName = `${stem}__${suffix}.md`;
          await new Promise(r => setTimeout(r, 400)); // let the first download settle
          downloadMarkdown(buildFileBundle(meta, data), bundleName);
          console.log(`📦 ${bundleName} (${count} file(s))`);
          downloaded.push(bundleName);
        } else {
          const want = OPTIONS.fileExtensions?.length ? OPTIONS.fileExtensions.join(', ') : '(any)';
          console.log(`📦 No files matching ${want} — skipping bundle`);
        }
      }

      statusDiv.textContent = `✅ Downloaded: ${downloaded.join(' + ')}`;
      statusDiv.style.background = '#4CAF50';
      console.log('🎉 Export complete!');
    } catch (error) {
      statusDiv.textContent = `Error: ${error.message}`;
      statusDiv.style.background = '#f44336';
      console.error('Export failed:', error);
    } finally {
      setTimeout(() => {
        if (document.body.contains(statusDiv)) document.body.removeChild(statusDiv);
      }, 4000);
    }
  }

  startExport();
}

// ---------------------------------------------------------------------------
// Entry point — route to the right exporter for the current page
// ---------------------------------------------------------------------------

(function runClaudeExporter() {
  const pageType = detectPageType();
  if (pageType === 'code') {
    setupCodeSessionExporter();
  } else if (pageType === 'chat') {
    setupClaudeExporter();
  } else {
    console.warn(
      'Claude Exporter: open a claude.ai chat conversation (/chat/...) or a ' +
      'Claude Code session (/code/...), then run the script again.'
    );
  }
})();
