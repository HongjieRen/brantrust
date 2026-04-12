'use strict';

/**
 * Build a run manifest block for markdown output.
 *
 * @param {object} opts
 * @param {Array}  opts.results    - Normalized provider results
 * @param {string} opts.ts         - Timestamp string (ISO-like)
 * @param {string} [opts.judgeModel] - Judge model name, or null if no judge
 * @param {string} [opts.runDir]   - Saved run directory path, or null
 * @returns {string} Markdown manifest block (starts with ---)
 */
function formatManifest({ results, ts, judgeModel, runDir }) {
  const total = results.length;
  const successful = results.filter(r => !r.error).length;
  const degraded = successful < total;

  const providerLines = results.map(r => {
    if (r.error) {
      return `  - ${r.provider}: ${r.error_type || r.error}`;
    }
    return `  - ${r.provider}: ${(r.duration_ms / 1000).toFixed(1)}s  parse=${r.parse_score.toFixed(2)}`;
  }).join('\n');

  const parts = [
    '---',
    `**Run** \`${ts}\` · ${successful}/${total} models${degraded ? ' ⚠ degraded' : ''} · judge: ${judgeModel || 'none'}`,
    providerLines,
  ];

  if (runDir) {
    parts.push(`saved → \`${runDir}\``);
  }

  return parts.join('\n');
}

module.exports = { formatManifest };
