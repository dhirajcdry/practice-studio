// Turning LeetCode's two very different text blobs into cases we can run.
//
//  * `exampleTestcases` is newline-delimited: one JSON value per parameter, per case.
//    Two-sum with 3 examples is 6 lines. Design problems are always 2 lines per case
//    (the operation names, then the argument lists).
//  * Expected *outputs* are not in the API at all — they only exist inside the description
//    HTML, as `<strong>Output:</strong> ...` inside the example <pre> blocks. We scrape
//    them. When a case has no expected value we say so rather than inventing one.

/** Read the first complete JSON value out of `text`, ignoring any prose after it. */
export function parseLeadingJson(text) {
  if (typeof text !== 'string') return { ok: false };
  const s = text.trim();
  if (s === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    /* fall through to the incremental scan */
  }
  // Longest-prefix scan. Cheap: example outputs are short.
  for (let end = s.length - 1; end > 0; end -= 1) {
    const slice = s.slice(0, end).trim();
    if (slice === '') break;
    const last = slice[slice.length - 1];
    if (!(']}"'.includes(last) || /[0-9a-zA-Z]/.test(last))) continue;
    try {
      return { ok: true, value: JSON.parse(slice) };
    } catch {
      /* keep shrinking */
    }
  }
  return { ok: false };
}

/** Every non-empty line of `exampleTestcases`, trimmed of the \r LeetCode sometimes sends. */
export function testcaseLines(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '');
}

/**
 * Group the lines into cases of `perCase` lines each.
 * @returns {{ok:true, cases:string[][]}|{ok:false, message:string}}
 */
export function groupLines(lines, perCase) {
  if (perCase <= 0) return { ok: false, message: 'This problem takes no arguments.' };
  if (lines.length === 0) {
    return { ok: false, message: 'This problem did not come with any example test cases.' };
  }
  if (lines.length % perCase !== 0) {
    return {
      ok: false,
      message:
        `The example test cases do not divide evenly into ${perCase} value(s) per case ` +
        `(${lines.length} lines), so the local runner cannot tell where one case ends.`,
    };
  }
  const cases = [];
  for (let i = 0; i < lines.length; i += perCase) cases.push(lines.slice(i, i + perCase));
  return { ok: true, cases };
}

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s) {
  return s
    .replace(/&#x?[0-9a-fA-F]+;|&[a-zA-Z]+;/g, (m) => {
      if (ENTITIES[m] !== undefined) return ENTITIES[m];
      const dec = /^&#(\d+);$/.exec(m);
      if (dec) return String.fromCodePoint(Number(dec[1]));
      const hex = /^&#x([0-9a-fA-F]+);$/.exec(m);
      if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
      return m;
    });
}

/**
 * Scrape `Output:` lines out of the description HTML, in document order.
 * This is text handling only — nothing here is executed or interpreted as markup.
 * @returns {string[]} raw expected values, one per example
 */
export function expectedOutputsFromHtml(html) {
  if (typeof html !== 'string' || html === '') return [];

  // Prefer the <pre> example blocks — at most one Output per block, in order. Prose
  // elsewhere in the statement can also contain the word "Output:", and picking that up
  // would shift every expected value by one, which shows up as a bogus failure.
  const blocks = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map((m) => m[1]);
  if (blocks.length > 0) {
    const perBlock = blocks.map((b) => scanOutputs(b)[0]).filter((v) => v !== undefined);
    if (perBlock.length > 0) return perBlock;
  }
  return scanOutputs(html);
}

function scanOutputs(html) {
  const out = [];
  // Design problems label the field `<strong>Output</strong>` with no colon and put the
  // value on the next line, so a bold "Output" counts as the label with or without one.
  // Bare text needs the colon: prose says "output" far too often.
  const re = /<(?:strong|b)>\s*Output\s*:?\s*<\/(?:strong|b)>\s*:?|Output:\s*<\/(?:strong|b)>|Output:/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const rest = html.slice(m.index + m[0].length);
    // The field runs to the next tag that starts a new field (Explanation, the next
    // example) or the end of the block.
    const end = rest.search(/<\/pre>|<strong|<b>/i);
    const field = decodeEntities(
      (end === -1 ? rest : rest.slice(0, end)).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''),
    );
    const value = fieldValue(field);
    if (value !== '') out.push(value);
  }
  return out;
}

/**
 * The value of one Output field. Usually the rest of its line. When that line is empty or
 * opens a bracket it does not close, the value is printed across lines —
 * `[\n[1,1,6],\n[1,2,5]\n]` — and runs to the bracket that closes it, joined back onto one
 * line. Anything else stays the single line it always was.
 */
function fieldValue(field) {
  const text = field.replace(/^[ \t]+/, '');
  const nl = text.indexOf('\n');
  const line = (nl === -1 ? text : text.slice(0, nl)).trim();
  if (line !== '' && closingIndex(line) !== -1) return line;
  const body = text.trimStart();
  if (!/^[[{]/.test(body)) return line;
  const close = closingIndex(body);
  if (close === -1) return line;
  return body
    .slice(0, close + 1)
    .split('\n')
    .map((l) => l.trim())
    .join('');
}

/**
 * Where the bracket opening `s` closes, or -1 if it never does. A `s` that does not open
 * with a bracket counts as closed at once (0), so a scalar line is "complete".
 */
function closingIndex(s) {
  if (!/^[[{]/.test(s)) return 0;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The expected answer for a "first N of the array" problem.
 *
 * remove-element and friends print their answer as prose, not JSON:
 *
 *     Output: 2, nums = [2,2,_,_]
 *
 * The number is how many entries count and the underscores are the ones that do not. Read
 * plainly, `parseLeadingJson` takes the leading `2` and then reports a failure against an
 * array — a wrong verdict on correct code. This reads what the line actually says.
 *
 * @returns {{ok:true, value:any[]}|{ok:false}}
 */
export function parsePrefixExpected(raw) {
  if (typeof raw !== 'string') return { ok: false };
  const m = /^\s*(-?\d+)\s*,[^=]*=\s*(\[[\s\S]*)$/.exec(raw);
  if (!m) return { ok: false };
  const kept = Number(m[1]);
  if (!Number.isInteger(kept) || kept < 0) return { ok: false };
  const parsed = parseLeadingJson(m[2].replace(/(?<=[[,\s])_(?=[,\]\s])/g, 'null'));
  if (!parsed.ok || !Array.isArray(parsed.value)) return { ok: false };
  return { ok: true, value: parsed.value.slice(0, kept) };
}

/**
 * Build the runnable case list.
 *
 * @param {object} opts
 * @param {'function'|'design'} opts.kind
 * @param {number} opts.perCase  values per case (param count, or 2 for design)
 * @param {string} opts.testcases  newline-delimited input blob
 * @param {string|null} opts.descriptionHtml  scraped for expected outputs
 * @param {Array<string|null>} [opts.expectedOverrides]  per-case expected, by index —
 *   what YOU said the answer is. Takes priority over anything scraped, because a case
 *   you typed has no entry in LeetCode's description to scrape and must not silently
 *   inherit the expected output of the example that happens to share its index.
 * @returns {{ok:true, cases:Array}|{ok:false, message:string}}
 */
export function buildCases({
  perCase,
  testcases,
  descriptionHtml,
  expectedOverrides = null,
  prefixExpected = false,
}) {
  const lines = testcaseLines(testcases);
  const grouped = groupLines(lines, perCase);
  if (!grouped.ok) return grouped;

  const expectedRaw = expectedOutputsFromHtml(descriptionHtml ?? '');

  const cases = grouped.cases.map((group, index) => {
    const values = [];
    for (const line of group) {
      const parsed = parseLeadingJson(line);
      if (!parsed.ok) {
        return {
          index,
          input: group.join('\n'),
          parseError: `This test case could not be read as JSON: ${line}`,
        };
      }
      values.push(parsed.value);
    }
    const override = Array.isArray(expectedOverrides) && index < expectedOverrides.length
      ? expectedOverrides[index]
      : undefined;
    const rawExpected = override !== undefined
      ? (typeof override === 'string' && override.trim() !== '' ? override.trim() : null)
      : (index < expectedRaw.length ? expectedRaw[index] : null);
    let expectedParsed = { ok: false };
    if (rawExpected !== null && prefixExpected) {
      // The answer here is an array. A bare leading number off `2, nums = ...` is the
      // COUNT, not the answer — accepting it would fail correct code, so a line we cannot
      // read as an array is treated as no expected value at all.
      expectedParsed = parsePrefixExpected(rawExpected);
      if (!expectedParsed.ok) {
        const loose = parseLeadingJson(rawExpected);
        expectedParsed = loose.ok && Array.isArray(loose.value) ? loose : { ok: false };
      }
    } else if (rawExpected !== null) {
      expectedParsed = parseLeadingJson(rawExpected);
    }
    return {
      index,
      input: group.join('\n'),
      values,
      // Show the value actually compared. For a prefix problem LeetCode's printed line is
      // "2, nums = [2,2,_,_]", and displaying that beside an actual of [2,2] reads as a
      // mismatch on a passing case.
      expected:
        prefixExpected && expectedParsed.ok ? JSON.stringify(expectedParsed.value) : rawExpected,
      expectedValue: expectedParsed.ok ? expectedParsed.value : undefined,
      hasExpected: expectedParsed.ok,
    };
  });

  return { ok: true, cases };
}
