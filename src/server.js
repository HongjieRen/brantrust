#!/usr/bin/env node
'use strict';

/**
 * braintrust-lite MCP server
 *
 * Exposes a single `consult` tool via JSON-RPC 2.0 over stdio.
 * Claude Code registers this server and calls it as mcp__braintrust_lite__consult.
 *
 * Install:
 *   claude mcp add braintrust-lite -- node /path/to/src/server.js
 * Or via npm (published package, version-pinned):
 *   claude mcp add braintrust-lite -- npx -y braintrust-lite@~0.1
 */

const readline = require('readline');
const { spawn } = require('child_process');
const { join } = require('path');
const { version: PKG_VERSION } = require('../package.json');

const { getActiveProviders } = require('./providers/index.js');
const { normalize } = require('./normalize.js');
const { buildGeneratorSystem } = require('./prompts/index.js');
const { formatManifest } = require('./format.js');

const SERVER_INFO = { name: 'braintrust-lite', version: PKG_VERSION };

// ── Transport ─────────────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ── Process runner ────────────────────────────────────────────────────────────

function makeRunner(timeoutMs) {
  // timeoutMs === 0 means unlimited — use a very large number
  const effectiveMs = timeoutMs === 0 ? 7 * 24 * 60 * 60 * 1000 : timeoutMs;

  return function runProcess(cmd, args, opts = {}) {
    const ac = new AbortController();
    const proc = spawn(cmd, args, {
      signal: ac.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => ac.abort(), effectiveMs);

    return new Promise(res => {
      let resolved = false;
      const done = (code, error_type = null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        res({ stdout, stderr, code, error_type });
      };
      proc.on('close', code => done(code, code !== 0 ? 'nonzero' : null));
      proc.on('error', err => {
        if (err.name === 'AbortError') done('timeout', 'timeout');
        else if (err.code === 'ENOENT') done(-1, 'enoent');
        else done(-1, 'spawn_error');
      });
    });
  };
}

// ── Tool schema ───────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'consult',
    description: [
      'Consult Codex, Gemini, and Claude CLI in parallel on the same prompt.',
      'Returns anonymized Model A/B/C responses with a REVEAL block for blind Judge evaluation.',
      'Includes run manifest showing how many models succeeded (degraded mode if < 3).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The question or task to send to all models. Should be self-contained with all necessary context.',
        },
        timeout_sec: {
          type: 'number',
          description: 'Per-model timeout in seconds. Default: 90. Pass 0 for unlimited (use for deep research).',
        },
        skip: {
          type: 'array',
          items: { type: 'string', enum: ['claude', 'codex', 'gemini'] },
          description: 'Models to skip.',
        },
        only: {
          type: 'string',
          enum: ['claude', 'codex', 'gemini'],
          description: 'Call only one specific model instead of all three.',
        },
        blind: {
          type: 'boolean',
          description: 'Anonymize model names as A/B/C (default: true). Set false to see real names.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for CLI tools. Defaults to process cwd.',
        },
      },
      required: ['prompt'],
    },
  },
];

// ── consult handler ───────────────────────────────────────────────────────────

async function handleConsult(args) {
  const { prompt, timeout_sec = 90, skip = [], only, blind = true, cwd } = args;

  const timeoutMs = Number(timeout_sec) === 0 ? 0 : (Number(timeout_sec) || 90) * 1000;
  const runProcess = makeRunner(timeoutMs);
  const systemPrompt = buildGeneratorSystem('general');
  const fullPrompt = `${systemPrompt}\n\n${prompt}`;

  let activeProviders = getActiveProviders(skip);
  if (only) activeProviders = activeProviders.filter(p => p.name === only);

  const starts = {};
  activeProviders.forEach(p => { starts[p.name] = Date.now(); });

  const rawResults = await Promise.allSettled(
    activeProviders.map(p => runProcess(p.cmd, p.getArgs(fullPrompt), { cwd }))
  );

  const results = [];
  for (let i = 0; i < activeProviders.length; i++) {
    const p = activeProviders[i];
    const raw = rawResults[i].status === 'fulfilled'
      ? rawResults[i].value
      : { stdout: '', stderr: '', code: -1, error_type: 'rejected' };
    const ms = Date.now() - starts[p.name];
    const adapted = p.adapt(raw);
    results.push(normalize(p.name, raw, adapted, ms));
  }

  const total = activeProviders.length;
  const successful = results.filter(r => !r.error).length;
  const degraded = successful < total;

  // Shuffle for blind mode
  const labels = ['A', 'B', 'C'];
  const shuffled = [...results].sort(() => Math.random() - 0.5);
  const revealed = {};

  const modelBlocks = shuffled.map((r, i) => {
    const label = blind ? labels[i] : r.provider.toUpperCase();
    if (blind) revealed[labels[i]] = r.provider;
    const errorNote = r.error_type ? ` [${r.error_type}]` : (r.error ? ` [${r.error}]` : '');
    return `### Model ${label}${errorNote}\n\n${r.content || '[no output]'}`;
  });

  // Status line (mirrors the SKILL.md status bar format)
  const modelsLabel = degraded ? `⚠ ${successful}/${total} models` : `${total} models`;
  const statusLine = `[Consult | ${modelsLabel} | responses below]`;

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const manifest = formatManifest({ results, ts, judgeModel: null, runDir: null });

  const revealBlock = blind && Object.keys(revealed).length > 0
    ? `\n\n---\n\n**REVEAL** (read only after completing Judge evaluation):\n${Object.entries(revealed).map(([l, p]) => `Model ${l} = ${p}`).join(', ')}`
    : '';

  const output = [
    statusLine,
    '',
    modelBlocks.join('\n\n---\n\n'),
    revealBlock,
    '',
    manifest,
  ].join('\n');

  return { content: [{ type: 'text', text: output }] };
}

// ── JSON-RPC dispatcher ───────────────────────────────────────────────────────

function handleMessage(msg) {
  const { jsonrpc, id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: callArgs } = params || {};
    if (name !== 'consult') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      return;
    }
    handleConsult(callArgs || {})
      .then(result => send({ jsonrpc: '2.0', id, result }))
      .catch(err => send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } }));
    return;
  }

  if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
}

// ── Stdio loop ────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handleMessage(JSON.parse(trimmed));
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
});
