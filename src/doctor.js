#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
const { version: PKG_VERSION } = require('../package.json');

const GREEN = '\x1b[32m✓\x1b[0m';
const RED   = '\x1b[31m✗\x1b[0m';
const WARN  = '\x1b[33m!\x1b[0m';

function check(label, ok, detail) {
  const icon = ok === true ? GREEN : ok === 'warn' ? WARN : RED;
  const line = `  ${icon}  ${label.padEnd(28)} ${detail || ''}`;
  console.log(line);
  return ok === true;
}

function getVersion(cmd, args) {
  try {
    const result = spawnSync(cmd, args, { timeout: 5000, encoding: 'utf8' });
    if (result.status === 0) {
      return (result.stdout || result.stderr || '').split('\n')[0].trim().slice(0, 40);
    }
    return null;
  } catch {
    return null;
  }
}

function getSkillVersion(skillPath) {
  try {
    const content = readFileSync(skillPath, 'utf8');
    const m = content.match(/^version:\s*(.+)$/m);
    return m ? m[1].trim() : 'unknown';
  } catch {
    return null;
  }
}

function checkMcpServer() {
  // Probe MCP server: send initialize, expect a valid JSON-RPC response
  const serverPath = join(__dirname, 'server.js');
  if (!existsSync(serverPath)) return { ok: false, detail: 'src/server.js not found' };

  try {
    const msg = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'doctor', version: '0' } },
    });
    const result = spawnSync(process.execPath, [serverPath], {
      input: msg + '\n',
      timeout: 5000,
      encoding: 'utf8',
    });
    const line = (result.stdout || '').split('\n').find(l => l.trim().startsWith('{'));
    if (!line) return { ok: false, detail: 'no JSON response from server' };
    const resp = JSON.parse(line);
    if (resp.result && resp.result.serverInfo) {
      return { ok: true, detail: `v${resp.result.serverInfo.version}` };
    }
    return { ok: false, detail: 'unexpected response shape' };
  } catch (err) {
    return { ok: false, detail: err.message.slice(0, 60) };
  }
}

function main() {
  console.log(`\nbraintrust doctor  (package v${PKG_VERSION})\n`);

  let allOk = true;

  // ── CLI tools ──────────────────────────────────────────────────────────────
  console.log('CLI tools:');
  for (const [cmd, vArgs, installHint] of [
    ['claude', ['--version'],      'https://claude.ai/download'],
    ['codex',  ['--version'],      'npm i -g @openai/codex'],
    ['gemini', ['--version'],      'npm i -g @google/gemini-cli'],
  ]) {
    const ver = getVersion(cmd, vArgs);
    if (ver) {
      check(cmd, true, ver);
    } else {
      check(cmd, false, `not found — ${installHint}`);
      allOk = false;
    }
  }

  // ── MCP server ─────────────────────────────────────────────────────────────
  console.log('\nMCP server:');
  const mcp = checkMcpServer();
  if (!check('braintrust-lite server', mcp.ok, mcp.detail)) allOk = false;

  // ── Skill ──────────────────────────────────────────────────────────────────
  console.log('\nConsult skill:');
  const skillPath = join(process.env.HOME || '~', '.claude', 'skills', 'consult', 'SKILL.md');
  const skillVer = getSkillVersion(skillPath);
  if (skillVer) {
    check('SKILL.md installed', true, `v${skillVer}  at ${skillPath}`);
  } else {
    check('SKILL.md installed', false, `not found at ${skillPath}`);
    allOk = false;
  }

  const bakPath = skillPath + '.bak';
  check('SKILL.md.bak exists', existsSync(bakPath) ? 'warn' : 'warn',
    existsSync(bakPath) ? 'backup present' : 'no backup yet (created on first auto-update)');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log();
  if (allOk) {
    console.log('  \x1b[32mAll checks passed — braintrust is ready.\x1b[0m\n');
  } else {
    console.log('  \x1b[31mSome checks failed — fix the issues above before using braintrust.\x1b[0m\n');
    process.exit(1);
  }
}

main();
