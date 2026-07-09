/**
 * Proxy: OpenAI /v1/chat/completions → CommandCode /alpha/generate
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const PORT = process.env.PCMC_PORT || 3456;
const HOST = 'api.commandcode.ai';
const PATH = '/alpha/generate';
const CC_VERSION = process.env.PCMC_VERSION || '0.41.1';
const DEBUG = process.env.PCMC_DEBUG === '1'; // set PCMC_DEBUG=1 to enable

const logFile = fs.createWriteStream(path.join(__dirname, 'proxy.log'), { flags: 'a' });
function log(...a) { const l = `[${new Date().toISOString()}] ${a.join(' ')}`; process.stdout.write(l + '\n'); logFile.write(l + '\n'); }
function logErr(...a) { const l = `[${new Date().toISOString()}] ERROR ${a.join(' ')}`; process.stderr.write(l + '\n'); logFile.write(l + '\n'); }

log(`=== proxy started (debug: ${DEBUG ? 'ON' : 'OFF'}) ===`);

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 10, timeout: 300000 });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };

function sse(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

const STATIC_CONFIG = {
  workingDir: '', date: new Date().toISOString().slice(0, 10), environment: 'windows',
  structure: [], isGitRepo: false, currentBranch: '', mainBranch: 'main', gitStatus: '', recentCommits: [],
};

// ── OpenAI → CommandCode body ────────────────────────────────────────────────

function transform(oaiBody) {
  const model = oaiBody.model || 'deepseek/deepseek-v4-pro';
  let systemText = '';
  const messages = [];

  const toolNameMap = {};
  for (const m of oaiBody.messages || []) {
    if (m.role === 'assistant' && m.tool_calls)
      for (const tc of m.tool_calls) if (tc.id && tc.function?.name) toolNameMap[tc.id] = tc.function.name;
  }

  for (const m of oaiBody.messages || []) {
    if (m.role === 'system') { systemText += (systemText ? '\n\n' : '') + (typeof m.content === 'string' ? m.content : String(m.content)); continue; }
    if (m.role === 'tool') {
      const c = typeof m.content === 'string' ? { type: 'text', value: m.content } : (m.content || { type: 'text', value: String(m.content) });
      messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: m.tool_call_id, toolName: toolNameMap[m.tool_call_id] || 'unknown', output: c }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) {
        if (typeof m.content === 'string') parts.push({ type: 'text', text: m.content });
        else if (Array.isArray(m.content)) for (const p of m.content) if (p.type === 'text') parts.push({ type: 'text', text: p.text });
      }
      if (m.tool_calls) for (const tc of m.tool_calls) if (tc.type === 'function' && tc.function) parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: tc.function.arguments });
      messages.push({ role: 'assistant', content: parts });
      continue;
    }
    if (typeof m.content === 'string') messages.push({ role: m.role, content: [{ type: 'text', text: m.content }] });
    else if (Array.isArray(m.content)) {
      const parts = [];
      for (const p of m.content) { if (p.type === 'text') parts.push({ type: 'text', text: p.text }); else if (p.type === 'image_url') parts.push({ type: 'image', url: p.image_url?.url }); }
      messages.push({ role: m.role, content: parts });
    } else messages.push({ role: m.role, content: [{ type: 'text', text: String(m.content) }] });
  }

  const tools = (oaiBody.tools || []).map(t => ({
    name: t.function?.name || t.name, description: t.function?.description || t.description || '',
    input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
  }));

  return JSON.stringify({
    config: { ...STATIC_CONFIG, date: new Date().toISOString().slice(0, 10) },
    memory: '', taste: null, skills: null, permissionMode: 'standard',
    params: { model, system: systemText || undefined, messages, tools: tools.length > 0 ? tools : undefined, max_tokens: oaiBody.max_tokens || 32000, stream: oaiBody.stream !== false },
  });
}

// ── response handler ─────────────────────────────────────────────────────────

function handleUpstreamResponse(proxyRes, res, model, isStream) {
  if (proxyRes.statusCode >= 400) {
    res.writeHead(proxyRes.statusCode, { ...CORS, 'Content-Type': 'application/json' });
    proxyRes.pipe(res);
    return;
  }

  const genId = 'chatcmpl-' + Date.now();
  const dump = DEBUG
    ? (fs.mkdirSync(path.join(__dirname, 'dump'), { recursive: true }),
       fs.createWriteStream(path.join(__dirname, 'dump', `dump-${genId}.txt`)))
    : null;
  if (dump) log(`[debug] dumping to dump/dump-${genId}.txt`);

  if (!isStream) {
    // Non-streaming: collect all events → single JSON
    let buf = '', fullText = '', fullReasoning = '';
    const toolCalls = []; let toolPart = null;


    proxyRes.on('data', chunk => {
      if (dump) dump.write(chunk);
      buf += chunk.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        let evt; try { evt = JSON.parse(t); } catch { continue; }
        switch (evt.type) {
          case 'text-delta': fullText += evt.text || ''; break;
          case 'reasoning-delta': fullReasoning += evt.text || ''; break;
          case 'tool-input-start': toolPart = { id: evt.id, type: 'function', function: { name: evt.toolName, arguments: '' } }; toolCalls.push(toolPart); break;
          case 'tool-input-delta': if (evt.delta && toolPart) toolPart.function.arguments += evt.delta; break;
          case 'tool-input-end': case 'tool-call': toolPart = null; break;
        }
      }
    });

    proxyRes.on('end', () => {
      if (buf.trim()) {
        try { const evt = JSON.parse(buf.trim()); if (evt.type === 'text-delta') fullText += evt.text || ''; else if (evt.type === 'reasoning-delta') fullReasoning += evt.text || ''; } catch {}
      }
      const text = fullText || fullReasoning;
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) { msg.tool_calls = toolCalls; msg.content = text || null; }
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: genId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: msg, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
      log(`[done] text=${text.length} tools=${toolCalls.length}`);
    });

  } else {
    // Streaming: CommandCode NDJSON → OpenAI SSE chunks
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    let buf = '', toolCalls = [], toolIdx = 0, roleSent = false, tChars = 0, rChars = 0;

    const write = (chunk) => res.write(sse(chunk));
    const base = () => ({ id: genId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model });
    const ensureRole = () => { if (!roleSent) { roleSent = true; write({ ...base(), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }); } };

    proxyRes.on('data', chunk => {
      if (dump) dump.write(chunk);
      buf += chunk.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        let evt; try { evt = JSON.parse(t); } catch { continue; }
        switch (evt.type) {
          case 'text-start': toolCalls = []; toolIdx = 0; roleSent = true; write({ ...base(), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }); break;
          case 'text-delta': if (evt.text) { tChars += evt.text.length; write({ ...base(), choices: [{ index: 0, delta: { content: evt.text }, finish_reason: null }] }); } break;
          case 'reasoning-delta': if (evt.text) { rChars += evt.text.length; ensureRole(); write({ ...base(), choices: [{ index: 0, delta: { content: evt.text }, finish_reason: null }] }); } break;
          case 'tool-input-start':
            ensureRole(); toolIdx = toolCalls.length; toolCalls.push({ id: evt.id, name: evt.toolName });
            write({ ...base(), choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, id: evt.id, type: 'function', function: { name: evt.toolName, arguments: '' } }] }, finish_reason: null }] });
            break;
          case 'tool-input-delta':
            if (evt.delta && toolCalls[toolIdx]) write({ ...base(), choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, function: { arguments: evt.delta } }] }, finish_reason: null }] });
            break;
          // skip: start, start-step, text-end, reasoning-start/end, tool-input-end, tool-call, finish-step, finish, provider-metadata, error
        }
      }
    });

    proxyRes.on('end', () => {
      const reason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
      write({ id: genId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
      res.write('data: [DONE]\n\n'); res.end();
      log(`[done] text=${tChars} reasoning=${rChars} tools=${toolCalls.length} reason=${reason}`);
    });
  }

  proxyRes.on('error', () => { if (dump) dump.end(); if (!res.writableEnded) res.end(); });
}

// ── main ─────────────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Max-Age': '86400' }); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, CORS); res.end(JSON.stringify({ status: 'ok' })); return; }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) { res.writeHead(404, CORS); res.end(JSON.stringify({ error: 'POST /v1/chat/completions' })); return; }

  const auth = req.headers['authorization'] || '';
  let body = '';
  req.on('data', c => { body += c; if (body.length > 10 * 1024 * 1024) { req.destroy(); res.writeHead(413, CORS); res.end('{}'); } });
  req.on('end', () => {
    let oai; try { oai = JSON.parse(body); } catch { res.writeHead(400, CORS); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    const model = oai.model || '-', isStream = oai.stream === true;
    log(`[req] ${model} stream=${isStream}`);

    let upstream;
    try { upstream = transform(oai); } catch (e) { res.writeHead(500, CORS); res.end(JSON.stringify({ error: 'Transform error' })); return; }

    const pr = https.request({
      hostname: HOST, path: PATH, method: 'POST', agent, timeout: 300000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(upstream), 'Authorization': auth, 'x-command-code-version': CC_VERSION },
    }, proxyRes => {
      log(`[upstream] ${proxyRes.statusCode}`);
      handleUpstreamResponse(proxyRes, res, model, isStream);
    });
    pr.setTimeout(300000, () => { logErr('[upstream] timeout'); pr.destroy(); if (!res.headersSent) { res.writeHead(504, CORS); res.end('{}'); } });
    pr.on('error', e => { logErr(`[upstream] ${e.message}`); if (!res.headersSent) { res.writeHead(502, CORS); res.end(JSON.stringify({ error: e.message })); } });
    pr.write(upstream); pr.end();
  });
}

// ── start: kill existing process on PORT ──────────────────────────────────────

try {
  const netstat = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
  const match = netstat.trim().match(/(\d+)\s*$/m);
  if (match) {
    const pid = match[1];
    log(`killing existing process on port ${PORT} (PID ${pid})`);
    execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
  }
} catch {} // no process = nothing to kill

const server = http.createServer(handleRequest);
server.timeout = 300000; server.keepAliveTimeout = 120000;
server.listen(PORT, () => log(`listening on http://localhost:${PORT}`));
server.on('error', e => { if (e.code === 'EADDRINUSE') { logErr(`Port ${PORT} still in use after kill attempt`); process.exit(1); } throw e; });
process.on('SIGINT', () => {
  log('shutting down...');
  // kill any remaining process on this port (cleanup stale listeners)
  try {
    const netstat = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: 'utf8', timeout: 3000 });
    const match = netstat.trim().match(/(\d+)\s*$/m);
    if (match) {
      const pid = match[1];
      log(`killing leftover process on port ${PORT} (PID ${pid})`);
      execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 });
    }
  } catch {}
  server.close(() => logFile.end(() => process.exit(0)));
});
