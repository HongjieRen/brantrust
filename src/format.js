'use strict';

/**
 * Format a CLI run manifest summary for terminal output.
 *
 * @param {{ results: Array, ts: string, judgeModel: string|null, runDir: string }} opts
 * @returns {string}
 */
function formatManifest({ results, ts, judgeModel, runDir }) {
  const lines = [
    '## Run Manifest',
    '',
    `Timestamp : ${ts}`,
    `Judge     : ${judgeModel || 'none (--no-judge)'}`,
    `Saved to  : ${runDir}`,
    '',
    'Providers:',
  ];

  for (const r of results) {
    const status = r.error
      ? `✗  ${(r.error_type || r.error).padEnd(12)}`
      : `✓  ${(r.duration_ms / 1000).toFixed(1)}s  parse_score=${r.parse_score.toFixed(2)}`;
    lines.push(`  ${r.provider.padEnd(10)} ${status}`);
  }

  return lines.join('\n');
}

module.exports = { formatManifest };
