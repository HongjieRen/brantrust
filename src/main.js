'use strict';

const { spawn } = require('child_process');
const { readFileSync, existsSync, readdirSync, statSync } = require('fs');
const { join, resolve, extname } = require('path');

const { OUTPUT_DIR, DEFAULT_TIMEOUT_S, DEFAULT_JUDGE_MODEL, MAX_CONTEXT_CHARS, CONTEXT_FILE_MAX } = require('./config.js');
const { getActiveProviders } = require('./providers/index.js');
const { normalize } = require('./normalize.js');
const { runJudge } = require('./judge.js');
const { saveArtifacts } = require('./save.js');
const { persistRun } = require('./memory/index.js');

// ─── Arg Parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { skip: [], timeout: DEFAULT_TIMEOUT_S, 'judge-model': DEFAULT_JUDGE_MODEL };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip') { flags.skip.push(argv[++i]); continue; }
    if (a.startsWith('--no-')) { flags[a.slice(5)] = false; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      flags[key] = (!next || next.startsWith('--')) ? true : (i++, next);
    } else {
      positional.push(a);
    }
  }

  return { flags, positional };
}

// ─── Context Loading ──────────────────────────────────────────────────────────

function loadContextFile(filePath) {
  try {
    return readFileSync(resolve(filePath), 'utf8').slice(0, CONTEXT_FILE_MAX);
  } catch {
    process.stderr.write(`[warn] Cannot read context file: ${filePath}\n`);
    return null;
  }
}

function loadContextDir(dirPath, globPattern) {
  const resolved = resolve(dirPath);
  const exts = parseGlobToExtensions(globPattern || '*.md');

  let entries;
  try {
    entries = readdirSync(resolved, { recursive: true });
  } catch (e) {
    process.stderr.write(`[warn] Cannot read context-dir: ${e.message}\n`);
    return null;
  }

  const files = entries
    .map(f => join(resolved, f))
    .filter(f => { try { return statSync(f).isFile(); } catch { return false; } })
    .filter(f => !exts || exts.includes(extname(f).toLowerCase()));

  let total = 0;
  const parts = [];
  for (const fp of files) {
    if (total >= MAX_CONTEXT_CHARS) break;
    try {
      const rel = fp.slice(resolved.length + 1);
      const content = readFileSync(fp, 'utf8');
      const chunk = `### ${rel}\n${content.slice(0, MAX_CONTEXT_CHARS - total)}`;
      parts.push(chunk);
      total += chunk.length;
    } catch { /* skip unreadable files */ }
  }

  if (!parts.length) {
    process.stderr.write(`[warn] No files matched pattern "${globPattern || '*.md'}" in ${dirPath}\n`);
    return null;
  }

  process.stderr.write(`[braintrust] Loaded ${parts.length} file(s) from ${dirPath} (${total} chars, pattern: ${globPattern || '*.md'})\n`);
  return { parts, total };
}

function parseGlobToExtensions(glob) {
  const base = glob.split('/').pop();
  const m1 = base.match(/\*\.(\w+)$/);
  if (m1) return [`.${m1[1]}`];
  const m2 = base.match(/\*\.\{([^}]+)\}/);
  if (m2) return m2[1].split(',').map(e => `.${e.trim()}`);
  return null; // null = all files
}

// ─── --list mode ──────────────────────────────────────────────────────────────

function handleListMode() {
  if (!existsSync(OUTPUT_DIR)) { console.log('No runs yet.'); process.exit(0); }
  const runs = readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '.state')
    .map(d => d.name)
    .sort().reverse().slice(0, 20);
  if (!runs.length) { console.log('No runs yet.'); process.exit(0); }
  runs.forEach(r => {
    const summary = join(OUTPUT_DIR, r, 'summary.md');
    const report = join(OUTPUT_DIR, r, 'report.md');
    const target = existsSync(summary) ? summary : report;
    if (existsSync(target)) {
      const first = readFileSync(target, 'utf8').split('\n').find(l => l.startsWith('**问题'));
      console.log(`${r}  ${first || ''}`);
    }
  });
  process.exit(0);
}

// ─── Process Runner ───────────────────────────────────────────────────────────

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

// ─── Usage ────────────────────────────────────────────────────────────────────

function printUsageAndExit() {
  process.stderr.write('Usage: braintrust [options] "your question"\n');
  process.stderr.write('       cat file | braintrust "explain this"\n');
  process.stderr.write('\nOptions:\n');
  process.stderr.write('  --skip <model>      Skip a model (claude|codex|gemini), repeatable\n');
  process.stderr.write('  --no-judge          Show raw results only\n');
  process.stderr.write('  --judge-model       Judge model: claude|codex|gemini (default: claude)\n');
  process.stderr.write('  --timeout <sec>     Per-model timeout in seconds (default: 120)\n');
  process.stderr.write('  --dir <path>        Working directory for CLI tools\n');
  process.stderr.write('  --context-file <f>  Append file content as context (max 8000 chars)\n');
  process.stderr.write('  --context-dir <d>   Append all matching files from a directory as context\n');
  process.stderr.write('  --glob <pattern>    File pattern for --context-dir (default: *.md)\n');
  process.stderr.write('  --no-save           Do not save results to disk\n');
  process.stderr.write('  --json              Print full JSON result to stdout\n');
  process.stderr.write('  --list              List recent runs\n');
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(argv) {
  const { flags, positional } = parseArgs(argv);

  if (flags.list) { handleListMode(); return; }

  if (flags.strict) {
    console.log('[braintrust] --strict mode (two-stage Judge + swap-compare) is planned for v2.');
    process.exit(0);
  }

  // Build user prompt
  let userPrompt = positional.join(' ');

  // Read stdin if piped
  if (!process.stdin.isTTY) {
    const stdinData = readFileSync(0, 'utf8').trim();
    if (stdinData) userPrompt = userPrompt ? `${userPrompt}\n\n<context>\n${stdinData}\n</context>` : stdinData;
  }

  // Inject context file
  if (flags['context-file']) {
    const ctx = loadContextFile(flags['context-file']);
    if (ctx) userPrompt = `${userPrompt}\n\n<context-file>\n${ctx}\n</context-file>`;
  }

  // Inject context directory
  if (flags['context-dir']) {
    const result = loadContextDir(flags['context-dir'], flags.glob);
    if (result) {
      const block = result.parts.join('\n\n');
      userPrompt = `${userPrompt}\n\n<context-dir path="${flags['context-dir']}" files="${result.parts.length}" chars="${result.total}">\n${block}\n</context-dir>`;
    }
  }

  if (!userPrompt) { printUsageAndExit(); return; }

  const workDir = flags.dir ? resolve(flags.dir) : process.cwd();
  const timeoutMs = (parseInt(flags.timeout, 10) || DEFAULT_TIMEOUT_S) * 1000;
  const judgeModel = flags['judge-model'] || DEFAULT_JUDGE_MODEL;
  const noJudge = flags.judge === false;
  const noSave = flags.save === false;

  const runProcess = makeRunner(timeoutMs, workDir);
  const activeProviders = getActiveProviders(flags.skip);

  // Load generator system prompt (Phase 0: always 'general' variant)
  const { buildGeneratorSystem } = require('./prompts/index.js');
  const systemPrompt = buildGeneratorSystem('general');
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  const { formatManifest } = require('./format.js');
  process.stderr.write(`[braintrust] Running ${activeProviders.map(p => p.name).join(', ')} in parallel...\n`);

  const starts = {};
  activeProviders.forEach(p => { starts[p.name] = Date.now(); });

  const rawResults = await Promise.allSettled(
    activeProviders.map(p => runProcess(p.cmd, p.getArgs(fullPrompt)))
  );

  const raws = {};
  const results = [];
  for (let i = 0; i < activeProviders.length; i++) {
    const p = activeProviders[i];
    const raw = rawResults[i].status === 'fulfilled'
      ? rawResults[i].value
      : { stdout: '', stderr: '', code: -1 };
    raws[p.name] = raw;
    const ms = Date.now() - starts[p.name];
    const adapted = p.adapt(raw);
    const r = normalize(p.name, raw, adapted, ms);
    results.push(r);
    const status = r.error ? `⚠ ${r.error_type || r.error}` : `✓ ${(ms / 1000).toFixed(1)}s  parse_score=${r.parse_score.toFixed(2)}`;
    process.stderr.write(`[${p.name}: ${status}]\n`);
  }

  // Degraded mode warning
  const successCount = results.filter(r => !r.error).length;
  if (successCount < activeProviders.length) {
    process.stderr.write(`\n[braintrust] ⚠ DEGRADED: ${successCount}/${activeProviders.length} models succeeded\n`);
  }

  // Print raw results
  console.log('\n' + '═'.repeat(60));
  for (const r of results) {
    console.log(`\n## ${r.provider.toUpperCase()}${r.error ? ` (${r.error})` : ''}\n`);
    console.log(r.content || '[no output]');
  }

  // Run judge
  let judgeOutput = null;
  const validResults = results.filter(r => !r.error && r.content && r.content !== '[no output]');
  if (!noJudge && validResults.length >= 2) {
    judgeOutput = await runJudge(userPrompt, validResults, { judgeModel, runProcess });
    console.log('\n' + '═'.repeat(60));
    console.log('\n# 🧠 BRAINTRUST — 智囊团融合报告\n');
    console.log(judgeOutput);
  } else if (!noJudge && validResults.length < 2) {
    console.log('\n[braintrust] Not enough successful responses for Judge (need ≥ 2).');
  }

  // JSON output mode
  if (flags.json) {
    process.stdout.write('\n' + JSON.stringify({ prompt: userPrompt, results, judge: judgeOutput }, null, 2) + '\n');
  }

  // Save artifacts
  if (!noSave) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const runDir = join(OUTPUT_DIR, ts);
    saveArtifacts(runDir, userPrompt, raws, results, judgeOutput);
    process.stderr.write(`\n[saved → ${runDir}]\n`);

    // Print run manifest
    console.log('\n' + formatManifest({ results, ts, judgeModel: noJudge ? null : judgeModel, runDir }));

    // Persist to memory DB
    const parseScoreAvg = results.length
      ? results.reduce((sum, r) => sum + (r.parse_score || 0), 0) / results.length
      : null;
    persistRun({
      ts,
      question: userPrompt,
      variant: 'general',
      judgeModel: noJudge ? null : judgeModel,
      providers: activeProviders.map(p => p.name),
      judgeReport: judgeOutput,
      parseScoreAvg,
    });

    // Spawn async reflector (detached, main process exits immediately)
    // Verifier ≠ Executor: uses gpt-5.4-mini, different from default judge (claude)
    if (!flags['no-reflect'] && judgeOutput) {
      spawnReflector(ts);
    }
  }
}

/**
 * Spawn the reflector as a detached background process.
 * Main process does not wait for it — exits immediately.
 */
function spawnReflector(ts) {
  const { REFLECTOR_LOG } = require('./config.js');
  const fs = require('fs');
  const logFd = (() => {
    try { return fs.openSync(REFLECTOR_LOG, 'a'); } catch { return 'ignore'; }
  })();

  try {
    const child = spawn(process.execPath, [
      join(__dirname, 'reflector.js'), '--run', ts,
    ], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    process.stderr.write(`[reflector: spawned for ${ts}]\n`);
  } catch (err) {
    process.stderr.write(`[reflector: spawn failed — ${err.message}]\n`);
  } finally {
    if (typeof logFd === 'number') try { fs.closeSync(logFd); } catch { /* ignore */ }
  }
}

module.exports = { main };
