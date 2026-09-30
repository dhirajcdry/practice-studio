// Original illustrative content. Never copied from a personal practice workspace.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DesignStore, newInterviewId } from '../../server/design/store.mjs';
import { newInterview, recordTurn } from '../../server/design/interview.mjs';
import { writeInterviewDoc } from '../../server/design/render.mjs';

export const SLUG = 'contains-duplicate';
export const STUB = 'class Solution:\n    def containsDuplicate(self, nums: List[int]) -> bool:\n        pass\n';
export const WRONG_CODE = `class Solution:
    def containsDuplicate(self, nums: List[int]) -> bool:
        seen = set()
        for num in nums:
            seen.add(num)
            if num in seen:
                return True
        return False
`;
export const CODE = `class Solution:
    def containsDuplicate(self, nums: List[int]) -> bool:
        seen = set()
        for num in nums:
            if num in seen:
                return True
            seen.add(num)
        return False
`;
export const EXPLANATION = 'The set holds the values from earlier positions. I check before adding this value. The examples pass; what should I defend in an interview?';
export const COACH = `**Both local cases pass. Now defend the order of those two lines.**

Before each iteration, \`seen\` contains exactly the values at earlier positions. A match means two different positions hold the same value.

Your first version added before checking, so every value matched itself. The all-distinct case caught it.

**Your next explanation:** why does reaching \`return False\` prove the whole input is distinct?

Then state the expected **O(n) time** and **O(n) space**.`;
export const DESIGN_PROMPT = 'Design a URL shortener with a fast redirect path.';
export const DESIGN_ANSWER = 'The redirect API checks Redis, then reads Postgres on a miss. The creation service stores the mapping in Postgres and populates the cache.';
export const DESIGN_QUESTION = 'You said the creation service populates Redis, but the board only connects it to Postgres. Where does that cache write happen, and what does the first redirect see if it fails?';

// Full Excalidraw element shapes; these are a deliberately incomplete candidate diagram.
function base(id, type, x, y, width, height) {
  return { id, type, x, y, width, height, angle: 0, strokeColor: '#1e1e1e',
    backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null,
    roundness: type === 'rectangle' ? { type: 3 } : null, seed: 1, version: 1,
    versionNonce: 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false };
}
function box(id, text, x, y) {
  return [base(id, 'rectangle', x, y, 210, 105), {
    ...base(`${id}-text`, 'text', x + 10, y + 28, 190, 50),
    text, originalText: text, fontSize: 20, fontFamily: 2, textAlign: 'center',
    verticalAlign: 'middle', containerId: id, autoResize: true, lineHeight: 1.25,
  }];
}
function arrow(id, from, to, x, y, dx, dy) {
  return { ...base(id, 'arrow', x, y, Math.abs(dx), Math.abs(dy)),
    points: [[0, 0], [dx, dy]], lastCommittedPoint: null, startArrowhead: null,
    endArrowhead: 'arrow', elbowed: false,
    startBinding: { elementId: from, focus: 0, gap: 8 },
    endBinding: { elementId: to, focus: 0, gap: 8 },
  };
}
export function board() {
  const elements = [
    ...box('client', 'Client\nGET /:code', 40, 120),
    ...box('redirect', 'Redirect API\nread path', 370, 120),
    ...box('cache', 'Redis\ncode → URL', 700, 120),
    ...box('db', 'Postgres\ncode → URL', 370, 420),
    ...box('create', 'Create link\nPOST /links', 700, 420),
    arrow('request', 'client', 'redirect', 258, 172, 104, 0),
    arrow('lookup', 'redirect', 'cache', 588, 172, 104, 0),
    arrow('fallback', 'redirect', 'db', 475, 233, 0, 179),
    arrow('persist', 'create', 'db', 692, 472, -104, 0),
    { ...base('miss-label', 'text', 492, 305, 145, 25), text: 'cache miss', originalText: 'cache miss',
      fontSize: 18, fontFamily: 2, textAlign: 'left', verticalAlign: 'top',
      containerId: null, autoResize: true, lineHeight: 1.25 },
  ];
  for (const element of elements.filter((e) => e.type === 'rectangle')) {
    element.boundElements = [{ id: `${element.id}-text`, type: 'text' },
      ...elements.filter((e) => e.type === 'arrow' &&
        [e.startBinding.elementId, e.endBinding.elementId].includes(element.id))
        .map((e) => ({ id: e.id, type: 'arrow' }))];
  }
  // Fit the demo board at the same viewport as the coding screenshot.
  for (const element of elements) {
    for (const key of ['x', 'y', 'width', 'height']) element[key] *= 0.75;
    if (element.points) element.points = element.points.map(point => point.map(value => value * 0.75));
    if (element.fontSize) element.fontSize *= 0.9;
  }
  return elements;
}

export async function seedDemo(root) {
  const cacheDir = path.join(root, 'cache', 'leetcode');
  await fsp.mkdir(cacheDir, { recursive: true });
  const question = {
    title: 'Contains Duplicate', titleSlug: SLUG, difficulty: 'Easy', isPaidOnly: false,
    content: '<p><strong>Illustrative demo fixture.</strong> Decide whether an integer list contains a repeated value.</p>'
      + '<pre><strong>Input:</strong> nums = [4,8,4]\n<strong>Output:</strong> true</pre>'
      + '<pre><strong>Input:</strong> nums = [4,8,12]\n<strong>Output:</strong> false</pre>',
    exampleTestcases: '[4,8,4]\n[4,8,12]',
    metaData: JSON.stringify({ name: 'containsDuplicate', params: [{ name: 'nums', type: 'integer[]' }], return: { type: 'boolean' } }),
    codeSnippets: [{ lang: 'Python3', langSlug: 'python3', code: STUB }], topicTags: [],
  };
  await fsp.writeFile(path.join(cacheDir, `${SLUG}.json`), JSON.stringify({
    slug: SLUG, complete: true, fetchedAt: '2026-09-30T12:00:00Z', question,
  }, null, 2));
  const store = new DesignStore({ root });
  const id = newInterviewId(new Date('2026-09-30T12:00:00Z'));
  const startedAt = Date.parse('2026-09-30T12:00:00Z');
  const state = newInterview({ prompt: DESIGN_PROMPT, level: 'L4', minutes: 45, startedAt });
  const turns = [
    { at: '2026-09-30T12:00:00Z', kind: 'opening', asked: DESIGN_PROMPT },
    { at: '2026-09-30T12:12:00Z', kind: 'turn', said: DESIGN_ANSWER, asked: DESIGN_QUESTION },
  ];
  for (const turn of turns) recordTurn(state, turn);
  Object.assign(state, { phase: 'design', spentMs: 12 * 60_000,
    pausedAt: startedAt + 12 * 60_000, claudeSessionId: 'illustrative-demo-thread' });
  await store.create(id, state);
  for (const turn of turns) await store.appendTurn(id, turn);
  await store.writeScene(id, 0, board());
  await writeInterviewDoc({ root, id });
  return { id };
}
