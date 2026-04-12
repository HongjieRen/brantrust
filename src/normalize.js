'use strict';

// Known section tags in both Chinese and English variants
const KNOWN_TAGS = [
  '核心结论', '详细方案', '关键假设', '风险与不确定性',
  'Key Claims', 'Details', 'Assumptions', 'Risks',
];

// Build a regex that matches any known tag, with optional markdown decoration
// e.g. [核心结论], **[核心结论]**, **核心结论**, ## 核心结论, ### Key Claims
const TAG_PATTERN = (() => {
  const escaped = KNOWN_TAGS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(
    `(?:\\*{1,2})?\\[?(${escaped.join('|')})\\]?(?:\\*{1,2})?`,
    'g'
  );
})();

/**
 * Find all tag positions in text, returning [{tag, start}] sorted by start.
 */
function findTagPositions(text) {
  const positions = [];
  const re = new RegExp(TAG_PATTERN.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    // Only record first occurrence of each tag
    const tag = m[1];
    if (!positions.find(p => p.tag === tag)) {
      positions.push({ tag, start: m.index, end: m.index + m[0].length });
    }
  }
  return positions.sort((a, b) => a.start - b.start);
}

/**
 * Clean a single line: strip markdown noise without losing content.
 */
function cleanLine(line) {
  return line
    .replace(/^[-─—]{3,}\s*$/, '')         // pure separator lines → empty
    .replace(/^#+\s+/, '')                  // markdown headings prefix
    .replace(/^\*{1,2}(.*?)\*{1,2}$/, '$1') // **bold** wrappers
    .replace(/^[-*•]\s+/, '')               // list bullets
    .trim();
}

/**
 * Return true if a line looks like structured content (list item, numbered,
 * contains a colon, or starts with a bracket). Used to detect when trailing
 * conversational prose begins after a blank gap in the last section.
 */
function isStructuredLine(line) {
  return /^[-*•\d]/.test(line) ||  // list/numbered
    line.includes(':') || line.includes('：') || // has colon
    /^[[\(（【]/.test(line);         // starts with bracket
}

/**
 * Extract lines from a named section of the text.
 * Handles:
 * - Chinese tags: [核心结论], **核心结论**, **[核心结论]**
 * - English tags: [Key Claims], **Key Claims**
 * - Markdown headings: ## 核心结论
 * - Separator noise: --- lines removed
 * - Bold list items: **item** stripped to plain text
 * - Trailing conversational prose (codex): stops at blank + non-structured line
 *
 * @param {string} text
 * @param {string} tag - One of KNOWN_TAGS
 * @returns {string[]} Non-empty lines in that section
 */
function extractSection(text, tag) {
  const positions = findTagPositions(text);
  const entry = positions.find(p => p.tag === tag);
  if (!entry) return [];

  // Section runs from after the tag header to the start of the next known tag
  const nextEntry = positions.find(p => p.start > entry.start);
  const sectionText = nextEntry
    ? text.slice(entry.end, nextEntry.start)
    : text.slice(entry.end);

  const isLastSection = !nextEntry;
  const result = [];
  let seenContent = false;
  let afterBlankGap = false;

  for (const raw of sectionText.split('\n')) {
    const line = cleanLine(raw);

    if (!line) {
      if (seenContent) afterBlankGap = true;
      continue;
    }

    // For the last section: stop when we encounter prose after a blank gap.
    // This prevents codex trailing dialogue ("如果你需要更多帮助") from leaking in.
    if (isLastSection && afterBlankGap && !isStructuredLine(line)) {
      break;
    }

    result.push(line);
    seenContent = true;
    afterBlankGap = false;
  }

  return result;
}

/**
 * Compute a parse quality score for a normalized result.
 * Each known output section (key_claims, assumptions, risks) worth 0.25.
 * Full content present worth 0.25. Fallback mode penalizes -0.2.
 * Result clipped to [0, 1].
 *
 * @param {object} r - normalized result object
 * @returns {number} score in [0, 1]
 */
function parseScore(r) {
  let score = 0;
  if (r.key_claims && r.key_claims.length > 0) score += 0.25;
  if (r.assumptions && r.assumptions.length > 0) score += 0.25;
  if (r.risks && r.risks.length > 0) score += 0.25;
  if (r.content && r.content.length > 50) score += 0.25;
  if (r.parse_mode === 'fallback') score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

/**
 * Normalize raw provider output into a structured result.
 */
function normalize(provider, raw, adapted, durationMs) {
  const { content, model, parse_mode } = adapted;
  const r = {
    provider,
    model,
    content,
    key_claims: extractSection(content, '核心结论'),
    detailed: extractSection(content, '详细方案'),
    assumptions: extractSection(content, '关键假设'),
    risks: extractSection(content, '风险与不确定性'),
    duration_ms: durationMs,
    parse_mode,
    error_type: raw.error_type || null,
    error: raw.error_type === 'enoent' ? 'not installed'
      : raw.error_type === 'timeout' ? 'timeout'
      : raw.error_type === 'nonzero' ? `exit ${raw.code}`
      : raw.error_type ? raw.error_type
      : null,
    judge_score: null,
    lessons: [],
  };
  r.parse_score = parseScore(r);
  return r;
}

/**
 * Build a token-efficient summary of a normalized result for the judge prompt.
 */
function summarize(r) {
  const claims = r.key_claims.length ? r.key_claims.slice(0, 5).join('\n') : r.content.slice(0, 600);
  const risks = r.risks.slice(0, 3).join('\n');
  const assumptions = r.assumptions.slice(0, 3).join('\n');
  return [
    `【核心结论】\n${claims}`,
    risks ? `【风险】\n${risks}` : '',
    assumptions ? `【假设】\n${assumptions}` : '',
  ].filter(Boolean).join('\n\n');
}

module.exports = { extractSection, normalize, summarize, parseScore, KNOWN_TAGS };
