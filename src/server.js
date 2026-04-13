#!/usr/bin/env node
'use strict';

/**
 * MCP server for braintrust-lite.
 *
 * Exposes one tool: `consult`
 * Runs Claude CLI, Codex CLI, and Gemini CLI in parallel, returns their
 * responses as Model A / B / C (blind by default) for the calling agent to judge.
 *
 * Protocol: JSON-RPC 2.0 over stdio, line-delimited.
 */

const readline = require('readline');
const { spawn } = require('child_process');
const { resolve } = require('path');
const { version: PKG_VERSION } = require('../package.json');

const { DEFAULT_TIMEOUT_S } = require('./config.js');
const { getActiveProviders } = require('./providers/index.js');
const { normalize } = require('./normalize.js');
const { buildGeneratorSystem } = require('./prompts/index.js');

// ─── Process Runner ────────────────────────────────────────────────────────────

function makeRunner(timeoutMs, workDir) {
  return function runProcess(cmd, args, opts = {}) {
    const ac = new AbortController();
    const cwd = opts.cwd || workDir;
    const proc = spawn(cmd, args, { signal: ac.signal, stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => ac.abort(), timeoutMs);
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

// ─── MCP Response Helpers ──────────────────────────────────────────────────────

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

// ─── Tool Schema ───────────────────────────────────────────────────────────────

const CONSULT_TOOL = {
  name: 'consult',
  description:
    '并发调用 Claude CLI、Codex CLI、Gemini CLI，以 Model A/B/C 匿名形式返回三模型独立回答，' +
    '供主 Claude 担任 Judge 进行盲评合并。',
  inputSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: {
        type: 'string',
        description: '问题或任务描述（建议自包含，含必要上下文）',
      },
      skip: {
        type: 'array',
        items: { type: 'string', enum: ['claude', 'codex', 'gemini'] },
        description: '跳过指定模型（可多选）',
      },
      only: {
        type: 'string',
        enum: ['claude', 'codex', 'gemini'],
        description: '只调用一个模型',
      },
      timeout_sec: {
        type: 'number',
        description: '每个模型超时秒数（0 = 不限时等待；默认 90）',
        default: 90,
      },
      blind: {
        type: 'boolean',
        description: '匿名化模型名称为 A/B/C，防止位置偏置（默认 true）',
        default: true,
      },
      show_raw: {
        type: 'boolean',
        description: '直接返回三模型原始回答，不经过 Judge 融合（默认 false）。适合想自己阅读原文的场景。',
        default: false,
      },
      cwd: {
        type: 'string',
        description: '子进程工作目录（默认：当前进程 cwd）',
      },
    },
  },
};

// ─── Blind Label Assignment ────────────────────────────────────────────────────

/**
 * Assign Model A/B/C labels in a stable but non-alphabetical order
 * (sorted by a cheap hash of the provider name to reduce position bias).
 *
 * @param {Array} results - Normalized provider results
 * @returns {Array<{label: string, result: object}>}
 */
function assignBlindLabels(results) {
  const hash = s => [...s].reduce((acc, c) => ((acc * 31) + c.charCodeAt(0)) | 0, 0);
  const sorted = [...results].sort((a, b) => hash(a.provider) - hash(b.provider));
  return sorted.map((r, i) => ({ label: String.fromCharCode(65 + i), result: r }));
}

// ─── Consult Handler ──────────────────────────────────────────────────────────

async function handleConsult(args) {
  const {
    prompt,
    skip = [],
    only,
    timeout_sec = DEFAULT_TIMEOUT_S,
    blind = true,
    show_raw = false,
    cwd,
  } = args;

  if (!prompt || !prompt.trim()) {
    throw new Error('prompt is required and must not be empty');
  }

  // No-timeout sentinel: use 10 min cap so the process eventually ends
  const timeoutMs = timeout_sec === 0 ? 10 * 60 * 1000 : timeout_sec * 1000;
  const workDir = cwd ? resolve(cwd) : process.cwd();
  const runProcess = makeRunner(timeoutMs, workDir);

  // Resolve active providers
  const skipList = only
    ? ['claude', 'codex', 'gemini'].filter(n => n !== only)
    : [...skip];
  const activeProviders = getActiveProviders(skipList);

  if (activeProviders.length === 0) {
    throw new Error('No providers selected — check skip/only parameters.');
  }

  // Build generator prompt
  const systemPrompt = buildGeneratorSystem('general');
  const fullPrompt = `${systemPrompt}\n\n${prompt}`;

  // Run all providers in parallel
  const startTimes = Object.fromEntries(activeProviders.map(p => [p.name, Date.now()]));
  const settled = await Promise.allSettled(
    activeProviders.map(p => runProcess(p.cmd, p.getArgs(fullPrompt)))
  );

  // Normalize results
  const results = activeProviders.map((p, i) => {
    const raw = settled[i].status === 'fulfilled'
      ? settled[i].value
      : { stdout: '', stderr: '', code: -1, error_type: 'spawn_error' };
    const ms = Date.now() - startTimes[p.name];
    return normalize(p.name, raw, p.adapt(raw), ms);
  });

  const successCount = results.filter(r => !r.error).length;

  // show_raw mode: reveal model names, skip blind labeling, skip REVEAL footer
  if (show_raw) {
    const parts = [];
    for (const r of results) {
      const timing = r.error
        ? ` ⚠ ${r.error_type || r.error}`
        : ` (${(r.duration_ms / 1000).toFixed(1)}s)`;
      parts.push(`## ${r.provider.toUpperCase()}${timing}\n\n${r.content || '[no output]'}`);
    }
    if (successCount < activeProviders.length) {
      parts.push(`> ⚠ **DEGRADED**: Only ${successCount}/${activeProviders.length} models responded.`);
    }
    return { content: [{ type: 'text', text: parts.join('\n\n---\n\n') }] };
  }

  // Build labeled pairs (blind mode for Judge workflow)
  const labeled = blind
    ? assignBlindLabels(results)
    : results.map(r => ({ label: r.provider, result: r }));

  // Compose text output
  const parts = [];

  for (const { label, result: r } of labeled) {
    const header = blind ? `Model ${label}` : r.provider;
    const timing = r.error
      ? ` ⚠ ${r.error_type || r.error}`
      : ` (${(r.duration_ms / 1000).toFixed(1)}s, parse_score=${r.parse_score.toFixed(2)})`;
    parts.push(`## ${header}${timing}\n\n${r.content || '[no output]'}`);
  }

  if (successCount < activeProviders.length) {
    parts.push(
      `> ⚠ **DEGRADED**: Only ${successCount}/${activeProviders.length} models responded successfully.`
    );
  }

  if (blind) {
    const mapping = labeled.map(({ label, result: r }) => `Model ${label} = ${r.provider}`).join(' · ');
    parts.push(`---\n**REVEAL** (read after judging): ${mapping}`);
  }

  const text = parts.join('\n\n---\n\n');

  return {
    content: [{ type: 'text', text }],
  };
}

// ─── Request Dispatcher ────────────────────────────────────────────────────────

async function dispatch(req) {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'braintrust-lite', version: PKG_VERSION },
      });
      return;

    case 'notifications/initialized':
      return; // no-op, no response needed

    case 'tools/list':
      respond(id, { tools: [CONSULT_TOOL] });
      return;

    case 'tools/call': {
      const toolName = params && params.name;
      if (toolName !== 'consult') {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
        return;
      }
      try {
        const result = await handleConsult(params.arguments || {});
        respond(id, result);
      } catch (err) {
        respondError(id, -32603, err.message);
      }
      return;
    }

    default:
      // Only send error for requests (have an id), not notifications
      if (id !== undefined && id !== null) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try { req = JSON.parse(trimmed); } catch { return; }
    dispatch(req).catch(err => process.stderr.write(`[server error] ${err.message}\n`));
  });

  rl.on('close', () => process.exit(0));
}

main();
