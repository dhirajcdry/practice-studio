// Runs inside a scratch browser with fake providers, never a learner workspace.
export async function checkMockTime(kind, detailUrl) {
  const wait = async predicate => {
    for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); }
    throw Error('Mock time control did not settle');
  };
  const check = (value, message) => { if (!value) throw Error(message); };
  const saved = async () => (await fetch(detailUrl)).json();
  const initial = await saved();
  const clock = document.querySelector(kind === 'design' ? '.dz-clock' : '.ci-clock');
  const button = () => document.querySelector('.mock-add-time');
  await wait(() => button() && !button().disabled);
  const originalFetch = window.fetch;
  let debriefRequests = 0;
  window.fetch = (...args) => { if (/\/api\/(design|interview)\/done$/.test(String(args[0]))) debriefRequests++; return originalFetch(...args); };
  try {
    // The server owns elapsed time, so the scratch server's own clock is walked past the
    // budget (STUDIO_TEST_CLOCK), a minute at a time with a heartbeat after each, so the
    // whole stretch counts as attended. The page learns the reading on returning.
    const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const beat = kind === 'design' ? ['/api/design/heartbeat', { interviewId: initial.id }] : ['/api/interview/heartbeat', { slug: initial.slug, interviewId: initial.id }];
    const remaining = (initial.minutes + 1) * 60000 - (initial.clock?.elapsedMs || 0);
    for (let moved = 0; moved < remaining; moved += 60000) {
      check((await originalFetch('/api/test/clock', json({ advanceMs: 60000 }))).ok, 'The scratch server has no test clock');
      check((await originalFetch(beat[0], json(beat[1]))).ok, 'Heartbeat failed');
    }
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(() => clock.textContent.startsWith('+'));
    check(!/^\+\d{3,}:/.test(clock.textContent), 'Overtime reads as a long minute count: ' + clock.textContent);
    await new Promise(r => setTimeout(r, 1200));
    check(debriefRequests === 0 && !(await saved()).debriefed, 'Deadline must not request a debrief');
  } finally { window.fetch = originalFetch; }
  let total = initial.minutes;
  for (const minutes of [15, 20, 7]) {
    await wait(() => !button().disabled);
    const headerBefore = button().closest('.ci-header,.ui-screen-header').getBoundingClientRect();
    button().click();
    const option = [...document.querySelectorAll('.ui-menu-item')].find(node => node.textContent.includes(minutes === 7 ? 'Custom' : `+${minutes} min`));
    check(option, 'Missing time option'); option.click();
    if (minutes === 7) {
      const input = document.querySelector('.mock-time-input'); input.value = '7'; input.form.requestSubmit();
    }
    const headerAfter = button().closest('.ci-header,.ui-screen-header').getBoundingClientRect();
    check(Math.abs(headerAfter.height - headerBefore.height) < 1, 'Time editor must not expand the header');
    total += minutes;
    await wait(async () => !button().disabled && (await saved()).minutes === total);
    check(debriefRequests === 0, 'Extending must not request a debrief');
    check(!document.querySelector('.mock-time-popover:popover-open'), 'Saved extension closes its popover');
    check(!button().closest('.mock-time-controls').textContent.includes('Added'), 'No permanent success text in header');
    const bounds = button().getBoundingClientRect();
    check(bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth, 'Time control must stay in the viewport');
  }
  return { original: initial.minutes, extended: total, overtimeKeptOpen: true };
}

/**
 * The attended-time rule end to end (server/mock-clock.mjs), in a scratch browser against
 * a scratch server with STUDIO_TEST_CLOCK: leave a running mock without pausing, let ten
 * minutes pass on the server, come back, and find it paused at the moment you left, never
 * in overtime; a heartbeat cannot restart it; Resume continues from the same reading; a
 * short absence keeps counting. With `sleep`, a wall-clock jump with no page events (a
 * laptop lid) is caught too.
 */
export async function checkMockAway(kind, { sleep: slept = false } = {}) {
  const design = kind === 'design';
  const pause = design ? '.dz-pause' : '.ci-pause';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (predicate, label) => {
    for (let i = 0; i < 300; i++) { if (await predicate()) return; await sleep(50); }
    throw Error(kind + ': ' + label + ' — clock ' + clock()?.textContent + ' ' + clock()?.dataset.clock + '; band ' + band()?.textContent);
  };
  const check = (value, message) => { if (!value) throw Error(kind + ': ' + message); };
  const clock = () => document.querySelector('.mock-add-time [data-clock]');
  const band = () => [...document.querySelectorAll('.mock-paused')].find(n => !n.hidden);
  // Remaining seconds, negative in overtime.
  const remaining = text => (text.startsWith('+') ? -1 : 1) * text.replace('+', '').split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
  const advance = async ms => check((await fetch('/api/test/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ advanceMs: ms }) })).ok, 'no test clock');
  const hide = hidden => {
    // Someone was here a moment ago (programmatic clicks are not pointer input).
    if (hidden) window.dispatchEvent(new Event('pointerdown'));
    if (hidden) { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); }
    else { delete document.hidden; delete document.visibilityState; }
    document.dispatchEvent(new Event('visibilitychange'));
  };
  await wait(() => ['running', 'over'].includes(clock()?.dataset.clock), 'a running mock');
  const result = {};
  // 1. A short absence keeps counting: hidden, a minute passes, back.
  let before = remaining(clock().textContent);
  hide(true); await sleep(300); await advance(60000); hide(false);
  await wait(() => remaining(clock().textContent) <= before - 55, 'a short absence still counts');
  check(clock().dataset.clock !== 'paused' && !band(), 'a short absence paused the mock');
  result.shortAbsence = before - remaining(clock().textContent);
  // 2. Gone for ten minutes without pausing: back to a paused mock at the moment of leaving.
  before = remaining(clock().textContent);
  hide(true); await sleep(300); await advance(10 * 60000); hide(false);
  await wait(() => band() && clock().dataset.clock === 'paused', 'paused while away');
  check(/^Paused while you were away · \d+(:\d\d)+ (left|over)/.test(band().textContent), 'band reads ' + band().textContent);
  const away = remaining(clock().textContent);
  check(Math.abs(away - before) <= 5, `the clock counted time away: ${before}s → ${away}s`);
  result.away = { before, after: away, band: band().textContent.replace('Resume', '').trim() };
  const frozen = clock().textContent; await sleep(1200);
  check(clock().textContent === frozen, 'a paused clock kept ticking');
  // A heartbeat (returning focus, input) never restarts it.
  window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pointerdown')); await sleep(600);
  check(clock().dataset.clock === 'paused', 'returning restarted the clock without Resume');
  // 3. Resume continues from the same reading.
  document.querySelector(pause).click();
  await wait(() => clock().dataset.clock !== 'paused' && !band(), 'Resume');
  check(Math.abs(remaining(clock().textContent) - away) <= 3, 'Resume moved the clock');
  if (slept) {
    // 4. The lid closes: no events at all, the wall clock jumps nine hours, the server too.
    before = remaining(clock().textContent);
    const realNow = Date.now;
    try {
      await advance(9 * 3600000);
      Date.now = () => realNow.call(Date) + 9 * 3600000;
      await wait(() => band() && clock().dataset.clock === 'paused', 'paused after sleep');
      check(Math.abs(remaining(clock().textContent) - before) <= 8, 'sleep counted as time');
    } finally { Date.now = realNow; }
    result.sleep = band().textContent.replace('Resume', '').trim();
    document.querySelector(pause).click();
    await wait(() => clock().dataset.clock !== 'paused' && !band(), 'Resume after sleep');
  }
  return result;
}
