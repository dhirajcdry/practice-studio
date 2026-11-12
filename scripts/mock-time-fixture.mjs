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
  const originalNow = Date.now, originalFetch = window.fetch;
  let debriefRequests = 0;
  window.fetch = (...args) => { if (/\/api\/(design|interview)\/done$/.test(String(args[0]))) debriefRequests++; return originalFetch(...args); };
  try {
    Date.now = () => originalNow() + (initial.minutes + 1) * 60000;
    await wait(() => clock.textContent.startsWith('+'));
    await new Promise(r => setTimeout(r, 1200));
    check(debriefRequests === 0 && !(await saved()).debriefed, 'Deadline must not request a debrief');
  } finally { Date.now = originalNow; window.fetch = originalFetch; }
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
