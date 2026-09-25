// Self-tests for the two pieces of code that handle untrusted input.
// Open web/tests.html in a browser; the headline turns green when everything passes.
// This lives in its own module file on purpose: the payloads below contain literal
// close-script text, which would truncate an inline <script> block.

import { sanitizeHtml, safeUrl, isBlankHtml } from './sanitize.js';
import { renderMarkdown } from './markdown.js';
import { shapeRunResult, renderRunResult, summaryLine, formatMs } from './run.js';
import { SseDecoder } from './api.js';
import {
  splitDiagramBlocks, sanitizeSvg, isSafeSvgValue, parseMermaid, parseLink,
  layoutFlowchart, drawFlowchart, renderDiagram, findBackEdges,
} from './illustrator.js';
import { shapeCoachOutcome, toolLine, renderCoachText } from './coach.js';
import {
  shapeSubmitResult, renderSubmitResult, submitLine, shapeFailure,
  formatPercentile, submissionUrlOf, submissionsUrlOf,
} from './submit.js';
import { shapeTranscription, describeMicError, formatTake, phraseDecision, SILENCE_MS, MIN_PHRASE_MS, MAX_PHRASE_MS } from './voice.js';

const out = document.getElementById('out');
let pass = 0, fail = 0;

const html = frag => { const d = document.createElement('div'); d.append(frag); return d.innerHTML; };
const plain = frag => { const d = document.createElement('div'); d.append(frag); return d.textContent; };
const san = s => html(sanitizeHtml(s));
const md = s => html(renderMarkdown(s));

function group(name) {
  const row = document.createElement('div');
  row.className = 'grouphead';
  row.textContent = name;
  out.append(row);
}

function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  const row = document.createElement('div');
  row.className = 't ' + (ok ? 'pass' : 'fail');
  const v = document.createElement('span'); v.className = 'v'; v.textContent = ok ? 'pass' : 'FAIL';
  const n = document.createElement('span'); n.className = 'n'; n.textContent = name;
  const d = document.createElement('span'); d.className = 'd'; d.textContent = detail;
  row.append(v, n, d);
  out.append(row);
}

const SCRIPT_OPEN = '<' + 'script>';
const SCRIPT_CLOSE = '<' + '/script>';
const scripted = inner => SCRIPT_OPEN + inner + SCRIPT_CLOSE;

/* ---------------- sanitizer: must not survive ---------------- */
group('Sanitizer — must not survive');
check('script element is dropped entirely',
  !/alert|script/i.test(san('<p>ok</p>' + scripted('alert(1)'))), san('<p>ok</p>' + scripted('alert(1)')));
check('iframe is dropped', !/iframe/i.test(san('<iframe src="https://evil.test"></iframe>')));
check('object and embed are dropped', !/object|embed/i.test(san('<object data="x"></object><embed src="y">')));
check('style element is dropped, contents too', !/display/i.test(san('<style>body{display:none}</style>')));
check('onerror attribute is stripped',
  !/onerror/i.test(san('<img src="https://x.test/a.png" onerror="alert(1)">')),
  san('<img src="https://x.test/a.png" onerror="alert(1)">'));
check('onclick attribute is stripped', !/onclick/i.test(san('<p onclick="alert(1)">hi</p>')));
check('ONLOAD in upper case is stripped', !/onload/i.test(san('<img SRC="https://x.test/a.png" ONLOAD="alert(1)">')));
check('javascript: href degrades to plain text',
  !/javascript/i.test(san('<a href="javascript:alert(1)">click</a>')) && san('<a href="javascript:alert(1)">click</a>').includes('click'),
  san('<a href="javascript:alert(1)">click</a>'));
check('javascript: split by a tab is refused', safeUrl('java\tscript:alert(1)') === null);
check('javascript: with a leading newline is refused', safeUrl('\n javascript:alert(1)') === null);
check('data: URL is refused', safeUrl('data:text/html,' + scripted('alert(1)')) === null);
check('protocol-relative //host is refused', safeUrl('//evil.test/x') === null);
check('http:// is refused — https only', safeUrl('http://x.test/a') === null);
check('style attribute is stripped', !/style=/.test(san('<p style="position:fixed">x</p>')));
check('class and id attributes are stripped', !/class=|id=/.test(san('<p class="a" id="b">x</p>')));
check('srcset on img is stripped', !/srcset/.test(san('<img src="https://x.test/a.png" srcset="https://y.test/b.png">')));
check('img with an http src is dropped', !san('<img src="http://x.test/a.png">').includes('img'), san('<img src="http://x.test/a.png">'));
check('form and input are dropped', !/form|input/i.test(san('<form><input name="pw"></form>')));
check('svg with onload is dropped whole', !/svg|onload/i.test(san('<svg onload="alert(1)"><circle /></svg>')));
check('HTML comments are dropped', !san('<!-- secret --><p>x</p>').includes('secret'));

/* ---------------- sanitizer: must survive ---------------- */
group('Sanitizer — must survive');
check('https:// URL is kept verbatim', safeUrl('https://leetcode.com/a') === 'https://leetcode.com/a');
check('paragraph, strong and em survive',
  san('<p>a <strong>b</strong> <em>c</em></p>') === '<p>a <strong>b</strong> <em>c</em></p>',
  san('<p>a <strong>b</strong> <em>c</em></p>'));
check('pre and code survive', san('<pre><code>x = 1</code></pre>') === '<pre><code>x = 1</code></pre>');
check('lists survive', san('<ul><li>a</li><li>b</li></ul>') === '<ul><li>a</li><li>b</li></ul>');
check('tables survive', /<table><tbody><tr><td>a<\/td><\/tr><\/tbody><\/table>/.test(san('<table><tr><td>a</td></tr></table>')),
  san('<table><tr><td>a</td></tr></table>'));
check('sup and sub survive', san('<p>10<sup>4</sup> and x<sub>i</sub></p>').includes('<sup>4</sup>'));
check('unknown wrapper is unwrapped, its text kept', plain(sanitizeHtml('<div class="x"><span>kept</span></div>')) === 'kept');
check('https link keeps href and gains rel/noopener',
  /href="https:\/\/leetcode.com\/"/.test(san('<a href="https://leetcode.com/">L</a>')) && /noopener/.test(san('<a href="https://leetcode.com/">L</a>')));
check('https img is kept, lazy and no-referrer',
  /<img src="https:\/\/x.test\/a.png"/.test(san('<img src="https://x.test/a.png" alt="d">')) && /loading="lazy"/.test(san('<img src="https://x.test/a.png" alt="d">')),
  san('<img src="https://x.test/a.png" alt="d">'));
check('400-deep nesting does not blow the stack', plain(sanitizeHtml('<div>'.repeat(400) + 'deep' + '</div>'.repeat(400))) === 'deep');
check('isBlankHtml is true for empty markup', isBlankHtml('<div><p>  </p></div>') === true);
check('isBlankHtml is false when there is text', isBlankHtml('<p>hi</p>') === false);
check('isBlankHtml is false when there is an image', isBlankHtml('<img src="https://x.test/a.png">') === false);

/* ---------------- markdown: escape by default ---------------- */
group('Markdown — escape by default');
check('raw script tag in markdown is escaped',
  md('before ' + scripted('alert(1)') + ' after').includes('&lt;script&gt;'),
  md('before ' + scripted('alert(1)') + ' after'));
check('raw img tag becomes literal text, never an element',
  !/<img/.test(md('<img src=x onerror=alert(1)>')) && md('<img src=x onerror=alert(1)>').includes('&lt;img'),
  md('<img src=x onerror=alert(1)>'));
check('markdown link with javascript: renders as text', !/href/.test(md('[click](javascript:alert(1))')), md('[click](javascript:alert(1))'));
check('markdown link with https gets an anchor', /<a href="https:\/\/neetcode.io\/"/.test(md('[n](https://neetcode.io/)')));
check('inline code content is escaped', md('`<b>x</b>`').includes('<code>&lt;b&gt;x&lt;/b&gt;</code>'), md('`<b>x</b>`'));
check('ampersand is escaped exactly once', md('a & b') === '<p>a &amp; b</p>', md('a & b'));
check('decorative anchor tag is deleted, its label kept',
  md('see <a href="https://x.test/" target="_blank">Two Sum II</a> next') === '<p>see Two Sum II next</p>',
  md('see <a href="https://x.test/" target="_blank">Two Sum II</a> next'));
check('anchor with javascript: is deleted too, not linked',
  !/href|javascript/i.test(md('see <a href="javascript:alert(1)">x</a>')), md('see <a href="javascript:alert(1)">x</a>'));
check('a line that is only <br> disappears', md('a\n\n<br>\n\nb') === '<p>a</p><p>b</p>', md('a\n\n<br>\n\nb'));
check('span with onclick is deleted, not rendered',
  !/onclick|span/i.test(md('<span onclick="alert(1)">text</span>')), md('<span onclick="alert(1)">text</span>'));
check('non-benign tags are still escaped as text',
  md('<iframe src="https://evil.test"></iframe>').includes('&lt;iframe'), md('<iframe src="https://evil.test"></iframe>'));
check('inline $math$ becomes a code span', md('cost $O(n^2)$ here').includes('<code>O(n^2)</code>'), md('cost $O(n^2)$ here'));

/* ---------------- markdown: structure ---------------- */
group('Markdown — structure');
check('heading renders one level down', md('## Intuition').startsWith('<h3>'), md('## Intuition'));
check('bold and italic', md('**b** and *i*') === '<p><strong>b</strong> and <em>i</em></p>', md('**b** and *i*'));
check('unordered list', md('- a\n- b') === '<ul><li>a</li><li>b</li></ul>', md('- a\n- b'));
check('ordered list', md('1. a\n2. b') === '<ol><li>a</li><li>b</li></ol>', md('1. a\n2. b'));
check('nested list', /<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/.test(md('- a\n  - b')), md('- a\n  - b'));
check('blockquote', md('> note') === '<blockquote><p>note</p></blockquote>');
check('horizontal rule', md('---') === '<hr>');
check('pipe table',
  /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr>/.test(md('| a | b |\n| --- | --- |\n| 1 | 2 |')),
  md('| a | b |\n| --- | --- |\n| 1 | 2 |'));
check('fenced python gets token spans', md('```python\ndef f():\n    return 1\n```').includes('tok-kw'));
check('fenced code keeps its newlines', plain(renderMarkdown('```\na\nb\n```')) === 'a\nb');
check('::tabs region keeps python and drops java', (() => {
  const r = plain(renderMarkdown('::tabs-start\n\n```python\nx=1\n```\n\n```java\nint x;\n```\n\n::tabs-end'));
  return r.includes('x=1') && !r.includes('int x');
})());
check('::tabs directives never render literally',
  !md('::tabs-start\n\n```python\nx=1\n```\n\n::tabs-end').includes('tabs-start'));
check('paragraphs split on blank lines', md('one\n\ntwo') === '<p>one</p><p>two</p>');
check('empty markdown renders nothing', md('') === '' && md('   ') === '');
check('an unterminated fence terminates anyway', plain(renderMarkdown('```python\nx = 1')) === 'x = 1');
check('a tilde line that is not a fence does not hang the parser', typeof md('~~~~ not a fence') === 'string');

/* ---------------- realistic payloads ---------------- */
group('Realistic payloads');
const leetcodeish = '<div><p>Given an array <code>nums</code>, return <em>indices</em>.</p>'
  + '<p><strong>Example 1:</strong></p><pre><strong>Input:</strong> nums = [2,7]\n<strong>Output:</strong> [0,1]</pre>'
  + '<p><strong>Constraints:</strong></p><ul><li><code>2 &lt;= n &lt;= 10<sup>4</sup></code></li></ul>'
  + '<img src="https://assets.leetcode.com/uploads/x.jpg" style="width:400px" onerror="alert(1)">'
  + scripted('window.__x=1');
const cleaned = san(leetcodeish);
check('realistic LeetCode HTML keeps its structure',
  /<pre>/.test(cleaned) && /<sup>4<\/sup>/.test(cleaned) && /<img src="https:\/\/assets.leetcode.com/.test(cleaned));
check('realistic LeetCode HTML loses scripts, handlers and styles',
  !/script|onerror|style=/i.test(cleaned), cleaned.slice(0, 50));
check('nothing was executed while sanitizing', window.__x === undefined);


/* ---------------- run results: the panel must not lie ---------------- */
group('Run results — honest states');

const oneCase = (over = {}) => ({ index: 0, input: '[2,7]\n9', expected: '[0,1]', actual: '[0,1]', stdout: '', passed: true, ms: 12, ...over });
const rendered = shaped => { const box = document.createElement('div'); renderRunResult(box, shaped); return box; };

const compile = shapeRunResult({
  ok: false, cases: [],
  error: { kind: 'compile', message: 'IndentationError: expected an indented block', traceback: '  File "solution.py", line 3' },
});
check('compile error is its own status', compile.status === 'compile', compile.status);
check('compile error keeps the message and the traceback',
  compile.message.includes('IndentationError') && compile.traceback.includes('line 3'));
check('compile error never renders a case list', rendered(compile).querySelector('.rr-case') === null);
check('compile error never renders a pass/fail summary', rendered(compile).querySelector('.rr-summary') === null);
check('a compile error that arrives WITH cases still shows none — nothing ran',
  shapeRunResult({ ok: false, cases: [oneCase()], error: { kind: 'compile', message: 'x' } }).cases.length === 0);

const unsupported = shapeRunResult({ ok: false, cases: [], error: { kind: 'unsupported', message: 'Design problems are not driven yet.' } });
check('unsupported is neither a pass nor a failure',
  unsupported.status === 'unsupported' && unsupported.tone !== 'err', unsupported.status);
check('unsupported keeps the server message', unsupported.message.includes('Design problems'));
check('unsupported renders no cases and no verdict',
  rendered(unsupported).querySelector('.rr-case') === null && rendered(unsupported).querySelector('.rr-summary') === null);
check('unsupported has an explanation even when the server sends none',
  shapeRunResult({ ok: false, cases: [], error: { kind: 'unsupported' } }).message.length > 20);
check('unsupported ignores any cases that came with it',
  shapeRunResult({ ok: false, cases: [oneCase()], error: { kind: 'unsupported', message: 'x' } }).cases.length === 0);

const runtime = shapeRunResult({
  ok: true,
  cases: [
    oneCase(),
    oneCase({ index: 1, passed: false, actual: '', error: { kind: 'runtime', message: 'IndexError: out of range', traceback: 'Traceback...' } }),
    oneCase({ index: 2 }),
  ],
  summary: { passed: 2, total: 3, totalMs: 30 },
});
check('a runtime error fails only its own case', runtime.cases[1].kind === 'runtime' && runtime.cases[0].kind === 'pass' && runtime.cases[2].kind === 'pass');
check('the other cases are still reported', runtime.cases.length === 3 && runtime.summary.passed === 2);
check('the failing case carries its traceback', runtime.cases[1].traceback === 'Traceback...');
check('overall status is a failure when one case raised', runtime.status === 'fail', runtime.status);
check('a runtime case renders a traceback block', rendered(runtime).querySelector('.rr-field.trace') !== null);

const timedOut = shapeRunResult({
  ok: true,
  cases: [oneCase(), oneCase({ index: 1, passed: false, error: { kind: 'timeout' } })],
  summary: { passed: 1, total: 2, totalMs: 5010 },
});
check('a timeout is labelled as a timeout, not a wrong answer', timedOut.cases[1].kind === 'timeout' && timedOut.cases[1].label === 'Timed out');
check('a timeout says which case hung', rendered(timedOut).textContent.includes('Case 2'));
check('a timeout with no message still explains itself', timedOut.cases[1].message.length > 20, timedOut.cases[1].message);

const anyOrder = shapeRunResult({
  ok: true,
  cases: [oneCase({ actual: '[1,0]', orderInsensitive: true })],
  summary: { passed: 1, total: 1, totalMs: 12 },
});
check('order-insensitive match is a pass, not a failure', anyOrder.status === 'pass' && anyOrder.cases[0].passed === true);
check('order-insensitive match carries a note', anyOrder.cases[0].note.toLowerCase().includes('order'));
check('order-insensitive run is flagged in the summary', anyOrder.orderInsensitive === true);

check('a case with an error is never a pass, whatever `passed` says',
  shapeRunResult({ ok: true, cases: [oneCase({ passed: true, error: { kind: 'runtime', message: 'boom' } })] }).cases[0].passed === false);
check('a case with no verdict is reported as unverified, not as a pass or a failure', (() => {
  const r = shapeRunResult({ ok: true, cases: [{ index: 0, input: 'a', expected: '1.0', actual: '0.9999' }] });
  return r.cases[0].kind === 'unknown' && r.status === 'unclear' && r.tone === 'warn';
})());

const allPass = shapeRunResult({ ok: true, cases: [oneCase(), oneCase({ index: 1 })], summary: { passed: 2, total: 2, totalMs: 24 } });
check('all passing gives a pass status and headline', allPass.status === 'pass' && allPass.headline === 'All 2 cases passed', allPass.headline);
check('passing cases start collapsed', rendered(allPass).querySelector('.rr-casebody').hidden === true);
check('failing cases start expanded', rendered(runtime).querySelectorAll('.rr-casebody')[1].hidden === false);
check('a mixed run counts honestly', shapeRunResult({ ok: true, cases: [oneCase(), oneCase({ index: 1, passed: false })] }).headline === '1 of 2 cases passed');

check('totalMs comes from the server when it sends one', allPass.summary.totalMs === 24);
check('totalMs is derived from the cases when it does not',
  shapeRunResult({ ok: true, cases: [oneCase({ ms: 5 }), oneCase({ index: 1, ms: 7 })] }).summary.totalMs === 12);
check('ok:true with no cases is called out, not shown as a pass',
  shapeRunResult({ ok: true, cases: [], summary: { passed: 0, total: 0, totalMs: 0 } }).status === 'empty');

check('a server without the run endpoint is a state of its own, not a failure', (() => {
  const r = shapeRunResult({ ok: false, kind: 'unavailable', message: 'no endpoint' });
  return r.status === 'blocked' && r.blockedKind === 'unavailable' && r.cases.length === 0;
})());
check('a 404 is treated as "not implemented here"', shapeRunResult({ ok: false, kind: 'missing' }).blockedKind === 'unavailable');
check('an unreachable server never produces a verdict',
  shapeRunResult({ ok: false, kind: 'offline' }).status === 'blocked' && rendered(shapeRunResult({ ok: false, kind: 'offline' })).querySelector('.rr-summary') === null);
check('a cancelled run says so and offers no retry button',
  rendered(shapeRunResult({ ok: false, kind: 'cancelled' })).querySelector('.act') === null);
check('a garbage response is still a rendered, honest state',
  shapeRunResult(null).status === 'blocked' && rendered(shapeRunResult(null)).textContent.length > 20);
check('an unknown transport kind falls back to a server error', shapeRunResult({ ok: false, kind: 'wat' }).blockedKind === 'server');

check('summaryLine reports counts for a real run', summaryLine(allPass) === '2/2 passed · 24 ms', summaryLine(allPass));
check('summaryLine for a blocked run repeats the headline', summaryLine(unsupported) === unsupported.headline);
check('formatMs is readable at every scale',
  formatMs(0.4) === '<1 ms' && formatMs(12) === '12 ms' && formatMs(12000) === '12.0 s' && formatMs(null) === '');


/* ---------------- SSE: the stream must survive being cut anywhere ---------------- */
group('Coach stream — SSE decoding');

const decodeAll = (...chunks) => {
  const decoder = new SseDecoder();
  const out = [];
  for (const chunk of chunks) out.push(...decoder.push(chunk));
  out.push(...decoder.flush());
  return out;
};

check('a whole event decodes', (() => {
  const [e] = decodeAll('event: token\ndata: {"text":"hi"}\n\n');
  return e.event === 'token' && e.data === '{"text":"hi"}';
})());
check('the opening comment frame is not an event', decodeAll(': open\n\n').length === 0);
check('an event split mid-field survives', (() => {
  const [e] = decodeAll('event: to', 'ken\ndata: {"te', 'xt":"hi"}\n\n');
  return e && e.event === 'token' && e.data === '{"text":"hi"}';
})());
check('an event split between its two terminating newlines survives', (() => {
  const [e] = decodeAll('event: done\ndata: {}\n', '\n');
  return e && e.event === 'done';
})());
check('a chunk carrying several events yields all of them, in order', (() => {
  const events = decodeAll('event: token\ndata: "a"\n\nevent: token\ndata: "b"\n\nevent: done\ndata: {}\n\n');
  return events.length === 3 && events[0].data === '"a"' && events[1].data === '"b"' && events[2].event === 'done';
})());
check('multi-line data is rejoined with newlines', (() => {
  const [e] = decodeAll('event: token\ndata: line one\ndata: line two\n\n');
  return e.data === 'line one\nline two';
})());
check('a blank data line inside a value is preserved',
  decodeAll('event: token\ndata: a\ndata: \ndata: b\n\n')[0].data === 'a\n\nb');
check('CRLF framing decodes the same as LF', (() => {
  const [e] = decodeAll('event: token\r\ndata: {"text":"hi"}\r\n\r\n');
  return e && e.event === 'token' && e.data === '{"text":"hi"}';
})());
check('a CRLF split across two chunks does not leave a stray carriage return', (() => {
  const [e] = decodeAll('event: token\r\ndata: hi\r', '\n\r\n');
  return e && e.data === 'hi';
})());
check('exactly one leading space is stripped from a value',
  decodeAll('event: token\ndata:  padded\n\n')[0].data === ' padded');
check('a field with no colon is tolerated', decodeAll('event: token\ndata\n\n')[0].data === '');
check('an incomplete trailing event is held, not emitted', (() => {
  const decoder = new SseDecoder();
  return decoder.push('event: token\ndata: {"text":"half"}').length === 0;
})());
check('flush surfaces a final event the server never terminated',
  decodeAll('event: error\ndata: {"message":"boom"}\n')[0].event === 'error');
check('flush on an empty buffer produces nothing', new SseDecoder().flush().length === 0);
check('a token arriving one character at a time still decodes once', (() => {
  const decoder = new SseDecoder();
  const wire = 'event: token\ndata: {"text":"drip"}\n\n';
  const seen = [];
  for (const ch of wire) seen.push(...decoder.push(ch));
  return seen.length === 1 && seen[0].data === '{"text":"drip"}';
})());

/* ---------------- coach error shaping ---------------- */
group('Coach — honest states');

check('a clean turn with text needs no notice', shapeCoachOutcome({ ok: true }, true) === null);
check('a clean turn with NO text is called out rather than left blank',
  shapeCoachOutcome({ ok: true }, false).head.includes('without saying anything'));
check('a missing binary keeps the server\'s own plain-English message', (() => {
  const s = shapeCoachOutcome({ ok: false, kind: 'coach', message: 'The coach is not available: the `claude` command was not found on this machine.' }, false);
  return s.body.includes('`claude` command was not found');
})());
check('every coach failure says the rest of Studio still works',
  shapeCoachOutcome({ ok: false, kind: 'coach', message: 'x' }, false).body.includes('editor, the runner'));
check('a server without the endpoint is a state, not an error',
  shapeCoachOutcome({ ok: false, kind: 'unavailable', message: 'no endpoint' }).tone === 'warn');
check('a cancelled turn is neither a warning nor an error, and offers no retry', (() => {
  const s = shapeCoachOutcome({ ok: false, kind: 'cancelled', message: 'You stopped it.' });
  return s.tone === '' && s.retry === false;
})());
check('a stream that died after some text says the answer was cut off',
  shapeCoachOutcome({ ok: false, kind: 'truncated', message: 'ended early' }, true).head.includes('cut off'));
check('an unknown failure kind still produces a real message',
  shapeCoachOutcome({ ok: false, kind: 'wat' }).body.length > 20);
check('a null result is still a rendered, honest state', shapeCoachOutcome(null).head.length > 0);
check('tool events become one quiet line', toolLine('Read', 'problems/two-sum/NOTES.md') === 'Read problems/two-sum/NOTES.md');
check('a write is reported as a write', toolLine('Write', 'NOTES.md') === 'Wrote NOTES.md');
check('an unknown tool keeps its own name', toolLine('Bash', 'ls') === 'Bash ls');
check('a tool with no summary does not render a dangling space', toolLine('Glob', '') === 'Looked for');

/* ---------------- the SVG sanitizer ---------------- */
group('Illustrator — SVG must be scrubbed');

const svgOf = source => {
  const result = sanitizeSvg(source);
  if (!result.ok) return '';
  const box = document.createElement('div');
  box.append(result.node);
  return box.innerHTML;
};
const wrap = inner => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`;

check('script inside an svg is dropped entirely',
  !/script|alert/i.test(svgOf(wrap(scripted('window.__svg=1') + '<rect width="4" height="4"/>'))),
  svgOf(wrap(scripted('x') + '<rect width="4" height="4"/>')));
check('nothing was executed while sanitizing an svg', window.__svg === undefined);
check('onload on the root svg element is stripped',
  !/onload/i.test(svgOf('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 10 10"><rect width="4" height="4"/></svg>')));
check('onclick on a child is stripped',
  !/onclick/i.test(svgOf(wrap('<rect width="4" height="4" onclick="alert(1)"/>'))));
check('ONMOUSEOVER in upper case is stripped',
  !/onmouseover/i.test(svgOf(wrap('<rect width="4" height="4" ONMOUSEOVER="alert(1)"/>'))));
check('foreignObject is dropped with its subtree',
  !/foreignobject|iframe/i.test(svgOf(wrap('<foreignObject><iframe src="https://evil.test"></iframe></foreignObject><rect width="4" height="4"/>'))));
check('an external <image> is dropped',
  !/image|evil/i.test(svgOf(wrap('<image href="https://evil.test/a.png" width="4" height="4"/><rect width="4" height="4"/>'))));
check('xlink:href is never carried over',
  !/href/i.test(svgOf(wrap('<text x="1" y="1" xlink:href="https://evil.test/">hi</text>'))));
check('a javascript: value is refused', isSafeSvgValue('javascript:alert(1)') === false);
check('javascript: split by a tab is refused', isSafeSvgValue('java\tscript:alert(1)') === false);
check('a remote url() is refused', isSafeSvgValue('url(https://evil.test/a.png)') === false);
check('a data: url() is refused', isSafeSvgValue("url('data:image/svg+xml,x')") === false);
check('a same-document url(#id) is kept — arrowheads still work', isSafeSvgValue('url(#arrow)') === true);
check('a fill referencing a remote gradient is dropped, the shape survives', (() => {
  const html = svgOf(wrap('<rect width="4" height="4" fill="url(https://evil.test/x#g)"/>'));
  return html.includes('<rect') && !html.includes('evil.test');
})(), svgOf(wrap('<rect width="4" height="4" fill="url(https://evil.test/x#g)"/>')));
check('a marker-end pointing at a local marker survives',
  svgOf(wrap('<defs><marker id="a"><path d="M0,0"/></marker></defs><line x1="0" y1="0" x2="4" y2="4" marker-end="url(#a)"/>')).includes('marker-end="url(#a)"'));
check('a style attribute carrying a remote url is dropped',
  !/evil/i.test(svgOf(wrap('<rect width="4" height="4" style="fill:url(https://evil.test/a)"/>'))));
check('an <animate> element is dropped',
  !/animate/i.test(svgOf(wrap('<rect width="4" height="4"><animate attributeName="x" to="9"/></rect>'))));
check('a <use> element is dropped', !/use/i.test(svgOf(wrap('<use href="#x"/><rect width="4" height="4"/>'))));
check('an <a> wrapper is dropped', !/<a /i.test(svgOf(wrap('<a href="https://evil.test/"><rect width="4" height="4"/></a>'))));
check('a <style> block is dropped', !/style|@import/i.test(svgOf(wrap('<style>@import url(https://evil.test/x.css)</style><rect width="4" height="4"/>'))));
check('plain geometry and text survive', (() => {
  const html = svgOf(wrap('<g><rect x="1" y="1" width="4" height="4" fill="#fff" stroke="#111"/><text x="2" y="3" font-size="4">n log n</text></g>'));
  return html.includes('<rect') && html.includes('<text') && html.includes('n log n');
})(), svgOf(wrap('<g><rect x="1" y="1" width="4" height="4"/><text x="2" y="3">n log n</text></g>')));
check('the viewBox survives so the drawing can scale', svgOf(wrap('<rect width="4" height="4"/>')).includes('viewBox="0 0 10 10"'));
check('a missing viewBox is synthesized from width and height', (() => {
  const html = svgOf('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="4" height="4"/></svg>');
  return html.includes('viewBox="0 0 400 200"');
})());
check('the drawing keeps an intrinsic width and drops its height, so CSS can scale it', (() => {
  const html = svgOf('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="4" height="4"/></svg>');
  return /<svg[^>]*width="400"/.test(html) && !/<svg[^>]*height=/.test(html);
})(), svgOf('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="4" height="4"/></svg>').slice(0, 60));
check('malformed XML is refused rather than half-drawn', sanitizeSvg('<svg><rect').ok === false);
check('a block that is not svg at all is refused', sanitizeSvg('<div>hello</div>').ok === false);
check('an svg with nothing left after scrubbing is refused',
  sanitizeSvg(wrap(scripted('alert(1)'))).ok === false);
check('a refused svg falls back to its source, never a blank pane', (() => {
  const node = renderDiagram('svg', '<svg><rect');
  return node.textContent.includes('<svg><rect') && node.querySelector('pre') !== null;
})());

/* ---------------- mermaid ---------------- */
group('Illustrator — the mermaid subset');

const chart = parseMermaid('flowchart TD\n  A[Start] --> B{Found it?}\n  B -->|yes| C[Return index]\n  B -- no --> D((Advance))\n  D --> A');
check('a flowchart parses', chart.ok === true, chart.ok ? '' : chart.reason);
check('nodes keep their labels and shapes', (() => {
  const byId = new Map(chart.nodes.map(n => [n.id, n]));
  return byId.get('A').label === 'Start' && byId.get('B').shape === 'diamond' && byId.get('D').shape === 'circle';
})());
check('a pipe edge label is read', chart.edges[1].label === 'yes');
check('an inline edge label is read', chart.edges[2].label === 'no');
check('every edge here is an arrow', chart.edges.every(e => e.arrow === true));
check('a dotted link is marked dashed', parseMermaid('graph LR\n A -.-> B').edges[0].dashed === true);
check('an open link carries no arrowhead', parseMermaid('graph LR\n A --- B').edges[0].arrow === false);
check('a thick link is still an edge', parseMermaid('graph LR\n A ==> B').edges[0].arrow === true);
check('parseLink reads the three link spellings', (() => {
  const a = parseLink('A --> B'), b = parseLink('A -->|yes| B'), c = parseLink('A -- no --> B');
  return a.right === 'B' && b.label === 'yes' && c.label === 'no';
})());
check('a chained link becomes one edge per hop', (() => {
  const c = parseMermaid('flowchart TD\n S[Start] --> A --> B -->|done| C');
  return c.ok && c.edges.map(e => e.from + e.to).join() === 'SA,AB,BC' && c.edges[2].label === 'done';
})());
check('a chain reuses nodes declared on earlier lines', (() => {
  const c = parseMermaid('flowchart TD\n S["l=0, r=11"]\n A["h[0]=0 > h[11]=1?"]\n S --> A --> S');
  return c.ok && c.nodes.length === 2 && c.edges.length === 2 && c.nodes[0].label === 'l=0, r=11';
})());
check('graph LR is accepted as well as flowchart', parseMermaid('graph LR\n A --> B').ok === true);
check('the direction is kept', parseMermaid('flowchart LR\n A --> B').direction === 'LR');
check('TB is normalised to TD', parseMermaid('flowchart TB\n A --> B').direction === 'TD');
check('a sequence diagram is refused by name, not mis-drawn', (() => {
  const r = parseMermaid('sequenceDiagram\n  A->>B: hi');
  return r.ok === false && /flowchart/.test(r.reason);
})(), parseMermaid('sequenceDiagram\n A->>B: hi').reason);
check('a subgraph is refused rather than drawn wrong',
  parseMermaid('flowchart TD\n subgraph one\n A --> B\n end').ok === false);
check('styling directives are refused', parseMermaid('flowchart TD\n A --> B\n style A fill:#f00').ok === false);
check('an empty block is refused', parseMermaid('').ok === false);
check('mermaid comments are ignored', parseMermaid('flowchart TD\n %% a note\n A --> B').ok === true);
check('a bare node declaration is allowed', (() => {
  const r = parseMermaid('flowchart TD\n A[Only me]');
  return r.ok === true && r.nodes.length === 1;
})());

const laid = layoutFlowchart(chart);
check('layout puts a child below its parent in TD', (() => {
  const byId = laid.byId;
  return byId.get('B').y > byId.get('A').y && byId.get('C').y > byId.get('B').y;
})());
check('layout gives the drawing real dimensions', laid.width > 100 && laid.height > 100);
check('a loop back to the top does not stack the diagram into a tower', (() => {
  const cyclic = layoutFlowchart(parseMermaid('flowchart TD\n A --> B\n B --> C\n C --> A'));
  const rows = new Set(cyclic.nodes.map(n => n.layer));
  return rows.size === 3 && isFinite(cyclic.height) && cyclic.height < 400;
})(), String(layoutFlowchart(parseMermaid('flowchart TD\n A --> B\n B --> C\n C --> A')).height));
check('the back edge is still drawn, it just does not set the layers', (() => {
  const model = parseMermaid('flowchart TD\n A --> B\n B --> A');
  const back = findBackEdges(model.nodes, model.edges);
  const box = document.createElement('div');
  box.append(drawFlowchart(layoutFlowchart(model), 'cyc'));
  return back.size === 1 && box.querySelectorAll('path[marker-end]').length === 2;
})());
check('LR lays out along x instead of y', (() => {
  const out = layoutFlowchart(parseMermaid('flowchart LR\n A --> B'));
  return out.byId.get('B').x > out.byId.get('A').x && out.byId.get('B').y === out.byId.get('A').y;
})());
check('the drawing is an svg with one text node per label', (() => {
  const node = drawFlowchart(laid, 'test');
  return node.tagName === 'svg' && node.querySelectorAll('text').length >= chart.nodes.length;
})());
check('the drawing contains no script and no foreign content', (() => {
  const box = document.createElement('div');
  box.append(drawFlowchart(laid, 'test2'));
  return !/script|foreignObject|href/i.test(box.innerHTML);
})());
check('an undrawable mermaid block falls back to its source', (() => {
  const node = renderDiagram('mermaid', 'sequenceDiagram\n  A->>B: hi');
  return node.querySelector('pre') !== null && node.textContent.includes('sequenceDiagram');
})());
check('the fallback says why it was not drawn',
  renderDiagram('mermaid', 'sequenceDiagram\n A->>B: x').textContent.includes('flowchart'));
check('a drawable mermaid block renders an svg',
  renderDiagram('mermaid', 'flowchart TD\n A[a] --> B[b]').querySelector('svg') !== null);

/* ---------------- markdown and diagrams, interleaved ---------------- */
group('Illustrator — prose and diagrams interleave');

const mixed = 'Before the picture.\n\n```mermaid\nflowchart TD\n  A[a] --> B[b]\n```\n\nAfter the picture.';
const parts = splitDiagramBlocks(mixed);
check('a message splits into prose, diagram, prose',
  parts.length === 3 && parts[0].type === 'markdown' && parts[1].type === 'diagram' && parts[2].type === 'markdown',
  parts.map(p => p.type).join(','));
check('the diagram segment carries only the fenced body',
  parts[1].code === 'flowchart TD\n  A[a] --> B[b]', JSON.stringify(parts[1].code));
check('a completed fence is marked complete', parts[1].complete === true);
check('an unterminated fence is marked incomplete — mid-stream, not broken', (() => {
  const p = splitDiagramBlocks('text\n\n```mermaid\nflowchart TD\n  A --> B');
  return p[1].type === 'diagram' && p[1].complete === false;
})());
check('an incomplete diagram renders a placeholder, never a blank pane',
  renderDiagram('mermaid', 'flowchart TD', { complete: false }).textContent.trim().length > 0);
check('a python fence is left for the markdown renderer', (() => {
  const p = splitDiagramBlocks('a\n\n```python\nx = 1\n```\n\nb');
  return p.length === 1 && p[0].type === 'markdown' && p[0].text.includes('x = 1');
})());
check('an svg fence is picked up too', splitDiagramBlocks('```svg\n<svg></svg>\n```')[0].lang === 'svg');
check('two diagrams in one message both survive', (() => {
  const p = splitDiagramBlocks('```mermaid\nflowchart TD\nA-->B\n```\nmid\n```svg\n<svg/>\n```');
  return p.filter(s => s.type === 'diagram').length === 2 && p[1].type === 'markdown';
})());
check('plain prose produces one segment', splitDiagramBlocks('just words').length === 1);
check('empty text produces no segments', splitDiagramBlocks('').length === 0);

const painted = renderCoachText(document.createElement('div'), mixed);
check('a rendered coach message keeps the prose on both sides of the drawing',
  painted.textContent.includes('Before the picture') && painted.textContent.includes('After the picture'));
check('a rendered coach message draws the diagram between them', painted.querySelector('svg') !== null);
check('a coach message escapes raw HTML exactly like an article does',
  renderCoachText(document.createElement('div'), 'hi ' + scripted('alert(1)')).innerHTML.includes('&lt;script&gt;'));
check('a javascript: link in a coach message never becomes an anchor',
  !/href/.test(renderCoachText(document.createElement('div'), '[x](javascript:alert(1))').innerHTML));
check('an svg block in a coach message is sanitized on the way in', (() => {
  const node = renderCoachText(document.createElement('div'), '```svg\n' + wrap(scripted('alert(1)') + '<rect width="4" height="4"/>') + '\n```');
  return !/script/i.test(node.innerHTML) && node.querySelector('svg') !== null;
})());

/* ---------------- voice ---------------- */
group('Voice — a silent take is a failure');

check('an empty transcript is never a success', (() => {
  const s = shapeTranscription({ ok: false, kind: 'empty_transcript', message: 'The recording came back with no words in it.' });
  return s.ok === false && s.head === 'Nothing was heard';
})());
check('a no-audio take is its own honest state',
  shapeTranscription({ ok: false, kind: 'no_audio', message: 'no audio track' }).head === 'No audio in that take');
check('a real transcript is a success carrying the text',
  shapeTranscription({ ok: true, text: 'I would use a hash map' }).body === 'I would use a hash map');
check('a server without /api/asr is a warning, not an error',
  shapeTranscription({ ok: false, kind: 'unavailable', message: 'no endpoint' }).tone === 'warn');
check('a too-short take explains what to do instead',
  shapeTranscription({ ok: false, kind: 'too_short', message: 'Hold the button down while you speak' }).body.includes('Hold the button'));
check('an unknown transcription failure still renders honestly',
  shapeTranscription({ ok: false, kind: 'wat' }).ok === false && shapeTranscription(null).body.length > 10);
check('a denied microphone says so plainly and says nothing was recorded', (() => {
  const d = describeMicError({ name: 'NotAllowedError' });
  return d.head === 'Microphone blocked' && /Nothing was recorded/.test(d.body);
})());
check('a missing microphone is a different message', describeMicError({ name: 'NotFoundError' }).head === 'No microphone found');

// --- live dictation: where a phrase gets cut. All of the logic, none of the audio.
check('mid-sentence, still talking — no cut',
  phraseDecision({ age: 3000, sinceLoud: 80, hadSpeech: true }) === 'wait');
check('a pause after real speech ends the phrase',
  phraseDecision({ age: MIN_PHRASE_MS + 1, sinceLoud: SILENCE_MS + 1, hadSpeech: true }) === 'cut');
check('a pause too soon does NOT cut — a clipped word is worse than a slow one',
  phraseDecision({ age: MIN_PHRASE_MS - 1, sinceLoud: SILENCE_MS + 500, hadSpeech: true }) === 'wait');
check('ordinary hesitation is not a pause',
  phraseDecision({ age: 5000, sinceLoud: SILENCE_MS - 100, hadSpeech: true }) === 'wait');
check('a monologue with no pauses still lands, in pieces',
  phraseDecision({ age: MAX_PHRASE_MS + 1, sinceLoud: 0, hadSpeech: true }) === 'cut');
check('silence is never transcribed, however long the microphone is open',
  phraseDecision({ age: 60_000, sinceLoud: 60_000, hadSpeech: false }) === 'drop');
check('an open microphone that has heard nothing yet just waits',
  phraseDecision({ age: 400, sinceLoud: 400, hadSpeech: false }) === 'wait');
check('a microphone held by another app is a different message again',
  describeMicError({ name: 'NotReadableError' }).head === 'Microphone is busy');
check('an unknown mic failure keeps the browser\'s own words',
  describeMicError({ name: 'WeirdError', message: 'weird' }).body.includes('weird'));
check('the take clock reads as minutes and seconds',
  formatTake(0) === '0:00' && formatTake(9000) === '0:09' && formatTake(75000) === '1:15' && formatTake(null) === '0:00');


/* ---------------- submit: a verdict is never softened ---------------- */
group('Submit — the judge must be quoted, not paraphrased');

// The verified 2026-07-25 submission, exactly as it came back.
const ACCEPTED = {
  ok: true, accepted: true, verdict: 'Accepted', statusCode: 10,
  passed: 64, total: 64, runtime: '3 ms', memory: '20.4 MB',
  runtimePercentile: 53.86, memoryPercentile: 58.13,
  submissionId: 2081220750, submissionUrl: 'https://leetcode.com/submissions/detail/2081220750/',
  failure: null,
};
const subShaped = (over = {}, slug = 'two-sum') => shapeSubmitResult({ ...ACCEPTED, ...over }, slug);
const subRendered = (shaped, handlers = { onResubmit: () => {} }) => {
  const box = document.createElement('div');
  renderSubmitResult(box, shaped, handlers);
  return box;
};

const accepted = subShaped();
check('an accepted verdict is its own status', accepted.status === 'accepted' && accepted.tone === 'ok', accepted.status);
check('accepted reports N of N tests', accepted.passed === 64 && accepted.total === 64);
check('accepted renders the counts, runtime, memory and both percentiles', (() => {
  const t = subRendered(accepted).textContent;
  return t.includes('64 of 64 tests passed') && t.includes('3 ms') && t.includes('20.4 MB')
    && t.includes('53.86th percentile') && t.includes('58.13th percentile');
})(), subRendered(accepted).textContent.replace(/\s+/g, ' ').slice(0, 90));
check('accepted links out to the real submission',
  subRendered(accepted).querySelector('a.sub-link').getAttribute('href') === 'https://leetcode.com/submissions/detail/2081220750/');
check('a submission link is derived from the id when the server sends no url',
  submissionUrlOf({ submissionId: 2081220750 }) === 'https://leetcode.com/submissions/detail/2081220750/');
check('a submission url pointing anywhere but leetcode is refused',
  submissionUrlOf({ submissionUrl: 'https://evil.test/x' }) === '');
check('the fallback link is the problem\'s own submissions page',
  submissionsUrlOf('two-sum') === 'https://leetcode.com/problems/two-sum/submissions/');
check('accepted with nothing attached shows no "judge\'s words" section',
  subRendered(accepted).querySelector('.sub-judge') === null);
check('summaryLine for a submission reads as a verdict, not as cases',
  submitLine(accepted) === 'Accepted · 64/64 · 3 ms', submitLine(accepted));

check('acceptance is status code 10 — a claim of accepted with any other code is NOT shown as one', (() => {
  const s = subShaped({ statusCode: 11, verdict: 'Wrong Answer' });
  return s.status === 'rejected' && s.tone === 'err' && s.message.includes('10');
})(), subShaped({ statusCode: 11, verdict: 'Wrong Answer' }).status);
check('accepted with an incomplete count says the two disagree rather than reading as a sweep', (() => {
  const s = subShaped({ passed: 60 });
  return s.status === 'accepted' && s.message.includes('60 of 64');
})());

const wrong = shapeSubmitResult({
  ok: true, accepted: false, verdict: 'Wrong Answer', statusCode: 11, passed: 41, total: 64,
  runtime: '', memory: '', runtimePercentile: null, memoryPercentile: null,
  submissionId: 2081220751,
  failure: { lastTestcase: '[3,2,4]\n6', expected: '[1,2]', actual: '[0,2]', stdout: 'scanning\n' },
}, 'two-sum');
check('a rejected verdict keeps the judge\'s own status string as the headline',
  wrong.headline === 'Wrong Answer' && wrong.status === 'rejected', wrong.headline);
check('a rejected verdict is never toned as anything but a failure', wrong.tone === 'err');
check('a wrong answer shows the last executed input, expected and actual', (() => {
  const t = subRendered(wrong).textContent;
  return t.includes('[3,2,4]') && t.includes('[1,2]') && t.includes('[0,2]');
})());
check('the failing output is the one marked bad, not the expected one',
  subRendered(wrong).querySelector('.sub-detail.bad .mono').textContent === 'Your output');
check('a wrong answer still reports how many hidden tests passed',
  subRendered(wrong).textContent.includes('41 of 64 tests passed'));
check('printed output is carried through as well', subRendered(wrong).textContent.includes('scanning'));

check('a compile error is shown in full, in the judge\'s words', (() => {
  const s = shapeSubmitResult({ ok: true, accepted: false, verdict: 'Compile Error', statusCode: 20, passed: 0, total: 64,
    failure: { fullCompileError: 'Line 7: IndentationError: expected an indented block' } }, 'two-sum');
  return s.headline === 'Compile Error' && subRendered(s).textContent.includes('IndentationError');
})());
check('a runtime error is shown in full too', (() => {
  const s = shapeSubmitResult({ ok: true, accepted: false, verdict: 'Runtime Error', statusCode: 15,
    failure: { fullRuntimeError: 'IndexError: list index out of range' } }, 'two-sum');
  return subRendered(s).textContent.includes('IndexError');
})());
check('a time limit verdict is a time limit verdict, not a wrong answer',
  shapeSubmitResult({ ok: true, accepted: false, verdict: 'Time Limit Exceeded', statusCode: 14 }).headline === 'Time Limit Exceeded');
check('snake_case field names from the judge are read, not dropped',
  shapeFailure({ last_testcase: '[1]', expected_output: '1', code_output: '2' }).details.length === 3);
check('the long form of an error wins over the truncated one',
  shapeFailure({ compileError: 'short', fullCompileError: 'the whole thing' }).details[0].value === 'the whole thing');
check('an array of output lines is joined rather than stringified as an object',
  shapeFailure({ code_output: ['1', '2'] }).details[0].value === '1\n2');
check('a field the judge did not send never gets an empty box',
  shapeFailure({ expected: '1' }).details.length === 1);
check('a verdict with nothing attached says so instead of showing empty boxes', (() => {
  const s = shapeSubmitResult({ ok: true, accepted: false, verdict: 'Wrong Answer', statusCode: 11, passed: 41, total: 64, failure: null });
  return s.details.length === 0 && subRendered(s).textContent.includes('nothing more to show');
})());
check('a response with no verdict string still refuses to imply success',
  shapeSubmitResult({ ok: true, accepted: false, statusCode: 11 }).headline === 'Not accepted');

check('an expired session is a state of its own', (() => {
  const s = shapeSubmitResult({ ok: false, kind: 'session_expired', message: 'The cookie died.' }, 'two-sum');
  return s.status === 'blocked' && s.blockedKind === 'session_expired' && s.tone === 'err';
})());
check('an expired session offers NO retry button — retrying cannot help',
  subRendered(shapeSubmitResult({ ok: false, kind: 'session_expired' }, 'two-sum')).querySelector('.act') === null);
check('an expired session says the session expired and must be pasted again', (() => {
  const t = subRendered(shapeSubmitResult({ ok: false, kind: 'session_expired' }, 'two-sum')).textContent;
  return /expired/i.test(t) && /paste/i.test(t);
})());
check('"never connected" and "session died" are two states, not one', (() => {
  const none = shapeSubmitResult({ ok: false, kind: 'no_session' }, 'two-sum');
  const dead = shapeSubmitResult({ ok: false, kind: 'session_expired' }, 'two-sum');
  return none.blockedKind === 'no_session' && none.headline !== dead.headline;
})());
check('neither credential state offers a retry button', (() => {
  const h = { onResubmit: () => {} };
  return subRendered(shapeSubmitResult({ ok: false, kind: 'no_session' }, 'two-sum'), h).querySelector('.act') === null
    && subRendered(shapeSubmitResult({ ok: false, kind: 'session_expired' }, 'two-sum'), h).querySelector('.act') === null;
})());
check('both credential states say what to paste and that Run is unaffected', (() => {
  const t = subRendered(shapeSubmitResult({ ok: false, kind: 'no_session' }, 'two-sum')).textContent;
  return t.includes('LEETCODE_SESSION') && /Local Run/.test(t);
})());
check('the server\'s own words win over the built-in wording for a known code',
  shapeSubmitResult({ ok: false, kind: 'no_session', message: 'Nothing is in the keychain yet.' }).message === 'Nothing is in the keychain yet.');
check('an error code nobody here knows still shows the server\'s message verbatim', (() => {
  const s = shapeSubmitResult({ ok: false, kind: 'server', code: 'WAT_NEW_CODE', message: 'The judge said something new.' });
  return s.message === 'The judge said something new.' && subRendered(s).textContent.includes('The judge said something new.');
})());
check('a judge timeout is not a verdict and still links to the submission it gave up on', (() => {
  const s = shapeSubmitResult({ ok: false, kind: 'judge_timeout', message: 'Still judging.',
    submissionId: 2081220750, submissionUrl: 'https://leetcode.com/submissions/detail/2081220750/' }, 'two-sum');
  const box = subRendered(s);
  return box.querySelector('.sub-verdict') === null
    && box.querySelector('a.sub-link').getAttribute('href') === 'https://leetcode.com/submissions/detail/2081220750/';
})());
check('a judge timeout offers no retry — the first submission is still live',
  subRendered(shapeSubmitResult({ ok: false, kind: 'judge_timeout' }, 'two-sum')).querySelector('.act') === null);
check('a submission already in flight is not dressed up as a failure', (() => {
  const s = shapeSubmitResult({ ok: false, kind: 'in_flight' }, 'two-sum');
  return s.tone === '' && s.retry === false && /nothing was duplicated/i.test(s.message);
})());
check('a rate limit never offers a retry button either',
  subRendered(shapeSubmitResult({ ok: false, kind: 'rate_limited' }, 'two-sum')).querySelector('.act') === null);
check('a rate limit says nothing was judged and nothing will be resent', (() => {
  const t = subRendered(shapeSubmitResult({ ok: false, kind: 'rate_limited' }, 'two-sum')).textContent;
  return /nothing was judged/i.test(t) && /never resend/i.test(t);
})());
check('the "what to do next" survives the server sending its own message', (() => {
  const s = shapeSubmitResult({ ok: false, kind: 'rate_limited', message: 'LeetCode answered 429.' }, 'two-sum');
  const t = subRendered(s).textContent;
  return t.includes('LeetCode answered 429.') && /never resends/i.test(t);
})());
check('an unreachable judge may be submitted again, deliberately, by hand', (() => {
  const s = shapeSubmitResult({ ok: false, kind: 'judge_unreachable', message: 'Cloudflare challenged it.' }, 'two-sum');
  return s.retry === true && subRendered(s).querySelector('.act').textContent === 'Submit again';
})());
check('an unreachable judge tells you to check LeetCode before sending another',
  subRendered(shapeSubmitResult({ ok: false, kind: 'judge_unreachable' }, 'two-sum')).textContent.includes('Check your submissions'));
check('a server with no submit endpoint yet is a state, not a failure of your code', (() => {
  const s = shapeSubmitResult({ ok: false, kind: 'unavailable', message: 'no endpoint' }, 'two-sum');
  return s.status === 'blocked' && s.tone === 'warn' && s.retry === false;
})());
check('giving up waiting is never presented as a verdict', (() => {
  const box = subRendered(shapeSubmitResult({ ok: false, kind: 'timeout' }, 'two-sum'));
  return box.querySelector('.sub-verdict') === null && /not a verdict/i.test(box.textContent);
})());
check('stopping the wait says the submission itself is still live on LeetCode',
  subRendered(shapeSubmitResult({ ok: false, kind: 'cancelled' }, 'two-sum')).textContent.includes('You stopped watching'));
check('every unknowable outcome links to the submissions page to check by hand',
  subRendered(shapeSubmitResult({ ok: false, kind: 'timeout' }, 'two-sum')).querySelector('a.sub-link').getAttribute('href')
    === 'https://leetcode.com/problems/two-sum/submissions/');
check('no server means nothing was submitted',
  shapeSubmitResult({ ok: false, kind: 'offline' }).blockedKind === 'offline');
check('an unknown transport kind falls back to a server error',
  shapeSubmitResult({ ok: false, kind: 'wat' }).blockedKind === 'server');
check('a garbage response is still a rendered, honest state',
  shapeSubmitResult(null).status === 'blocked' && subRendered(shapeSubmitResult(null)).textContent.length > 20);
const ALL_BLOCKED = ['no_session', 'session_expired', 'rate_limited', 'judge_unreachable', 'judge_timeout',
  'in_flight', 'unavailable', 'offline', 'timeout', 'cancelled', 'server'];
check('no blocked state ever renders a verdict headline',
  ALL_BLOCKED.every(kind => subRendered(shapeSubmitResult({ ok: false, kind }, 'two-sum')).querySelector('.sub-verdict') === null));
check('every blocked state carries a real message, not a code',
  ALL_BLOCKED.every(kind => shapeSubmitResult({ ok: false, kind }).message.length > 40));
check('submitLine for a blocked submission repeats the headline',
  submitLine(shapeSubmitResult({ ok: false, kind: 'rate_limited' })) === 'LeetCode is rate limiting submissions');
check('formatPercentile keeps the judge\'s own precision and refuses nonsense',
  formatPercentile(53.86) === '53.86th percentile' && formatPercentile(100) === '100th percentile'
    && formatPercentile(null) === '' && formatPercentile(-1) === '' && formatPercentile(101) === '');


const headline = document.getElementById('headline');
headline.textContent = fail === 0 ? `All ${pass} tests pass` : `${fail} of ${pass + fail} tests FAILED`;
headline.style.color = fail === 0 ? 'var(--easy)' : 'var(--hard)';
document.title = fail === 0 ? `PASS ${pass}` : `FAIL ${fail}`;
