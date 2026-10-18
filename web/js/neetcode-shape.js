// Textual signature checks only: never execute a learner's buffer to inspect it.
// Mask strings and comments while preserving offsets for the single-name editor edit.
function maskedPython(code) {
  return code.replace(/("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*)/g,
    text => text.replace(/[^\n]/g, ' '));
}

export function solutionMethods(code) {
  const lines = maskedPython(code).split('\n');
  const methods = [];
  let inSolution = false, classIndent = 0, memberIndent = null, offset = 0;
  for (const line of lines) {
    const indent = line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    if (line.trim()) {
      if (inSolution && indent <= classIndent) inSolution = false;
      if (/^\s*class\s+Solution\s*(?:\([^)]*\))?\s*:/.test(line)) {
        methods.length = 0;
        inSolution = true; classIndent = indent; memberIndent = null;
      } else if (inSolution) {
        if (memberIndent === null) memberIndent = indent;
        const match = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/.exec(line);
        if (match && indent === memberIndent) {
          const start = offset + line.indexOf(match[2], match[1].length + (line.trimStart().startsWith('async') ? 9 : 4));
          methods.push({ name: match[2], start, end: start + match[2].length });
        }
      }
    }
    offset += line.length + 1;
  }
  return methods;
}

export function checkNeetCodeShape(code, expectedMethods) {
  const found = solutionMethods(code).map(m => m.name);
  const names = expectedMethods.map(m => typeof m === 'string' ? m : m.name);
  return { missing: names.filter(name => !found.includes(name)), found };
}

export function neetcodeMismatch(code, shape) {
  if (!shape) return null;
  const methods = shape.methods || [];
  const { missing, found } = checkNeetCodeShape(code, methods);
  if (missing.length) {
    const calls = methods.map(m => `${m.name}(${(m.params || []).map(p => typeof p === 'string' ? p : p.name).join(', ')})`).join(' and ');
    const legacyNames = { islandsAndTreasure: 'wallsAndGates', foreignDictionary: 'alienOrder' };
    const candidate = solutionMethods(code).find(m => m.name === legacyNames[missing[0]]);
    const rename = methods.length === 1 && missing.length === 1 && candidate && !shape.intervals
      ? { ...candidate, to: missing[0] } : null;
    return {
      message: `NeetCode judges this problem and calls ${calls}. ${found.length ? `Your code defines ${found.join(' and ')}.` : 'Your code needs these methods on class Solution.'}`,
      rename,
    };
  }
  // Follow only the input parameter and its direct loop aliases. Other pair lists
  // (for example a heap built by the learner) can legitimately use [0] and [1].
  if (shape.intervals && usesIntervalPairs(code, methods[0]?.name)) {
    return { message: 'NeetCode passes Interval objects with .start and .end, not [start, end] lists.', rename: null };
  }
  return null;
}

function usesIntervalPairs(code, methodName) {
  const masked = maskedPython(code);
  const method = solutionMethods(code).find(m => m.name === methodName);
  if (!method) return false;
  const signature = masked.slice(method.end).match(/^\s*\(\s*self\s*,\s*(\w+)([^)]*)\)/);
  if (!signature) return false;
  const param = signature[1];
  const has = pattern => new RegExp(pattern).test(masked);
  if (/^\s*:\s*(?:List|list)\s*\[\s*(?:List|list)\s*\[/.test(signature[2])) return true;
  if (has(`\\b${param}\\s*\\[[^\\]\\n]+\\]\\s*\\[\\s*[01]\\s*\\]`)) return true;
  if (has(`for\\s+\\w+\\s*,\\s*\\w+\\s+in\\s+${param}\\b`)) return true;
  const aliases = [...masked.matchAll(new RegExp(`for\\s+(\\w+)\\s+in\\s+${param}\\s*:`, 'g'))].map(m => m[1]);
  for (const alias of aliases) {
    if (has(`\\b${alias}\\s*\\[\\s*[01]\\s*\\]`)) return true;
  }
  return has(`(?:${param}\\.sort\\(|sorted\\(\\s*${param}\\s*,)[^\\n]*lambda\\s+(\\w+)\\s*:\\s*\\1\\s*\\[\\s*[01]\\s*\\]`);
}
