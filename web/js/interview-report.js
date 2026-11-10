import { createComposer, composerSend, bindComposerInput } from './ui/composer.js';
import { claimActionKey } from './keyboard.js';
import { showWorkspaceAction } from './workspace-tools.js';
import { saveLearningNote } from './learning.js';
// The full interview report: a sheet over the workspace. Facts come from the server's
// count of the record; judgement from the interviewer's validated JSON. Anything
// missing is said plainly, never filled in.
import { el, replace } from './dom.js';
import { icon } from './ui/icon.js';
import { dialogHeader } from './ui/headers.js';
import { highlightPython } from './highlight.js';
import { formatClock } from './recorder.js';
import { ratingTone, relativeInterviewDate, reportDifficultyLabel } from './interview-format.js';
import { renderMarkdown } from './markdown.js';
import { readDraft, saveDraft, clearDraft } from './drafts.js';
import { installDrawerResizer } from './resize.js';

const PHASE_LABELS = { clarify: 'Clarify', approach: 'Approach', code: 'Code', test: 'Test', followup: 'Follow-up' };
const SIGNALS = ['No hire', 'Lean no', 'Lean hire', 'Hire', 'Strong hire'];
const RATING_STEPS = { Weak: 1, Mixed: 2, Solid: 3, Strong: 4 };
const MOMENT_LABELS = { insight: 'Insight', stuck: 'Stuck', hint: 'Hint', bug: 'Bug', fix: 'Fix', test: 'Test', verdict: 'Verdict' };
const minutes = ms => ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60000)} min`;
const stamp = ms => Number.isFinite(ms) ? formatClock(ms) : null;

function section(title, body, extra = '') {
  return el('section', { class: 'rp-section' + (extra ? ' ' + extra : '') }, [el('h3', { class: 'rp-h', text: title }), body]);
}
function stat(label, value, detail = '') {
  return el('div', { class: 'rp-stat' }, [
    el('span', { class: 'rp-stat-label', text: label }),
    el('strong', { class: 'rp-stat-value tnum', text: value }),
    detail ? el('span', { class: 'rp-stat-detail', text: detail }) : null,
  ]);
}

function signalScale(signal) {
  const index = SIGNALS.indexOf(signal);
  return el('div', { class: 'rp-scale', role: 'img', 'aria-label': signal ? `Hire signal: ${signal}` : 'No hire signal recorded' },
    SIGNALS.map((label, i) => el('span', { class: 'rp-scale-step' + (i === index ? ' is-on' : ''), dataset: { tone: ratingTone(label) } }, [
      el('i'), el('span', { text: label }),
    ])));
}

function meter(rating) {
  const steps = RATING_STEPS[rating] || 0;
  return el('span', { class: 'rp-meter', dataset: { tone: rating ? ratingTone(rating) : 'neutral' }, 'aria-hidden': 'true' },
    [1, 2, 3, 4].map(n => el('i', { class: n <= steps ? 'is-on' : '' })));
}

function timeline(facts, moments, jump, discipline) {
  const labels = discipline === 'lld' ? { clarify: 'Requirements', approach: 'Design', code: 'Implement', test: 'Verify', followup: 'Extend' } : PHASE_LABELS;
  const total = Math.max(facts.durationMs, 1);
  const pos = ms => `${Math.min(100, Math.max(0, (ms / total) * 100))}%`;
  const phases = facts.phases.filter(p => p.ms > 0);
  const marks = [
    ...facts.hints.map(h => ({ at: h.at, kind: 'hint', label: `Hint (${h.level})` })),
    ...facts.runs.map(r => ({ at: r.at, kind: r.passed ? 'run-pass' : 'run-fail', label: r.passed ? 'Run completed' : r.error ? 'Run errored' : `Run failed (${r.failed})` })),
    ...facts.verdicts.map(v => ({ at: v.at, kind: v.accepted ? 'accepted' : 'rejected', label: v.label })),
  ].filter(m => Number.isFinite(m.at));
  const track = el('div', { class: 'rp-track' }, phases.length
    ? phases.map(p => el('span', { class: 'rp-seg', dataset: { phase: p.phase }, style: `flex:${p.ms}` }))
    : [el('span', { class: 'rp-seg is-empty', style: 'flex:1' })]);
  const markLayer = el('div', { class: 'rp-marks' }, marks.map(m => el('button', {
    type: 'button', class: 'rp-mark', dataset: { kind: m.kind }, style: `left:${pos(m.at)}`,
    'aria-label': `${m.label} at ${formatClock(m.at)}`, onclick: () => jump(m.at),
  }, el('span', { class: 'rp-mark-tip', text: `${formatClock(m.at)} · ${m.label}` }))));
  const legend = el('div', { class: 'rp-legend' }, [
    ...phases.map(p => el('span', { class: 'rp-legend-item' }, [el('i', { dataset: { phase: p.phase } }), `${labels[p.phase] || p.phase} ${minutes(p.ms)}`])),
  ]);
  const momentList = moments.length ? el('ol', { class: 'rp-moments' }, moments.map(m => el('li', { dataset: { kind: m.kind } }, [
    m.at === null ? el('span', { class: 'rp-time is-empty', text: '—' })
      : el('button', { type: 'button', class: 'rp-time tnum', text: formatClock(m.at), onclick: () => jump(m.at) }),
    el('span', { class: 'rp-moment-kind', text: MOMENT_LABELS[m.kind] || m.kind }),
    el('span', { class: 'rp-moment-text', text: m.text }),
  ]))) : null;
  return el('div', { class: 'rp-timeline' }, [
    el('div', { class: 'rp-track-wrap' }, [markLayer, track,
      el('div', { class: 'rp-track-ends tnum' }, [el('span', { text: '0:00' }), el('span', { text: formatClock(facts.durationMs) })])]),
    legend, momentList,
  ]);
}

function dimensionCard(d, jump, onAsk) {
  const evidence = d.evidence.length ? el('ul', { class: 'rp-evidence' }, d.evidence.map(e => el('li', {}, [
    e.at === null ? null : el('button', { type: 'button', class: 'rp-time tnum', text: formatClock(e.at), onclick: () => jump(e.at) }),
    el('div', {}, [
      e.quote ? el('q', { class: 'rp-quote', text: e.quote }) : null,
      e.note ? el('p', { class: 'rp-note', text: (e.provenance === 'interpretation' ? 'Interviewer observation: ' : '') + e.note }) : null,
    ]),
  ]))) : el('p', { class: 'rp-note is-missing', text: 'No evidence recorded.' });
  return el('article', { class: 'rp-dim', dataset: { tone: d.rating ? ratingTone(d.rating) : 'neutral' } }, [
    el('header', {}, [el('h4', { text: d.name }), el('span', { class: 'rp-rating' }, [meter(d.rating), el('span', { text: d.rating || 'Not rated' })])]),
    d.summary ? el('p', { class: 'rp-dim-summary', text: d.summary }) : null,
    evidence,
    onAsk ? el('button', { type: 'button', class: 'btn btn--quiet btn--sm rp-dim-ask', text: `Ask about ${d.name.toLowerCase()}`, onclick: () => onAsk(dimensionQuestion(d)) }) : null,
  ]);
}

function codeSection(facts, code, discipline) {
  const lld = discipline === 'lld';
  if (!code && !facts.finalCode) return null;
  const same = !lld && code?.complexity && code?.optimal && code.complexity.replace(/\s/g, '').toLowerCase() === code.optimal.replace(/\s/g, '').toLowerCase();
  const final = facts.finalCode ? el('details', { class: 'rp-code' }, [
    el('summary', { text: 'Your final code' }),
    el('pre', { class: 'mono' }, el('code', {}, highlightPython(facts.finalCode))),
  ]) : null;
  return section('Your solution', el('div', {}, [
    code?.complexity || code?.optimal ? el('div', { class: 'rp-complexity' }, [
      el('div', {}, [el('span', { class: 'rp-stat-label', text: 'Yours' }), el('strong', { class: 'mono', text: code.complexity || 'Not assessed' })]),
      !lld ? el('div', {}, [el('span', { class: 'rp-stat-label', text: 'Best known' }), el('strong', { class: 'mono', text: code.optimal || 'Not assessed' })]) : null,
      same ? el('span', { class: 'ui-badge ui-badge--success', text: 'Optimal' }) : null,
    ]) : null,
    code?.notes?.length ? el('ul', { class: 'rp-list' }, code.notes.map(n => el('li', { text: n }))) : null,
    final,
  ]));
}

/** Build the report body. `jump(ms)` scrolls the transcript to that moment; `onAsk(question)` asks a follow-up. */
export function renderReport({ title, record, report, transcript, onAsk = null, debriefText = '' }) {
  const { facts } = report;
  // An older interview's debrief is prose with no structured judgement: show it as written.
  const j = report.judgement || { signal: record.hireSignal || null, headline: null, summary: null, dimensions: [], strengths: [], improvements: [], moments: [], code: null, practice: [] };
  const written = report.judgement ? null : section('Debrief', debriefText.trim()
    ? el('div', { class: 'rich rp-written' }, renderMarkdown(debriefText))
    : el('p', { class: 'rp-note is-missing', text: 'No debrief text was recorded.' }));
  const transcriptHost = el('div', { class: 'rp-transcript-body' });
  const transcriptBox = el('details', { class: 'rp-transcript' }, [
    el('summary', { text: `Conversation · ${facts.candidateTurns} ${facts.candidateTurns === 1 ? 'answer' : 'answers'}` }), transcriptHost]);
  if (transcript) transcriptHost.append(transcript);
  const jump = ms => {
    transcriptBox.open = true;
    const turns = [...transcriptHost.querySelectorAll('[data-elapsed]')];
    const target = turns.sort((a, b) => Math.abs(Number(a.dataset.elapsed) - ms) - Math.abs(Number(b.dataset.elapsed) - ms))[0];
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('rp-flash'); void target.offsetWidth; target.classList.add('rp-flash');
  };
  const runsFailed = facts.runs.filter(r => !r.passed).length;
  const verdict = facts.verdicts.at(-1);
  const difficulty = reportDifficultyLabel(record.reportDifficulty);
  const hero = el('header', { class: 'rp-hero', dataset: { tone: j.signal ? ratingTone(j.signal) : 'neutral' } }, [
    el('div', { class: 'rp-eyebrow' }, `Mock interview · ${title} · ${relativeInterviewDate(record.startedAt)}`),
    el('h2', { class: 'rp-signal', text: j.signal || 'No signal recorded' }),
    difficulty ? el('p', { class: 'rp-graded', text: `Graded at ${difficulty}` }) : null,
    signalScale(j.signal),
    el('p', { class: 'rp-note', text: 'Practice assessment · model judgments should be checked against the recorded evidence.' }),
    j.headline ? el('p', { class: 'rp-headline', text: j.headline }) : null,
    j.summary ? el('p', { class: 'rp-summary', text: j.summary }) : null,
  ]);
  const stats = el('div', { class: 'rp-stats' }, [
    stat('Time', minutes(facts.durationMs), `of ${minutes(facts.plannedMs)} · ${facts.mode === 'voice' ? 'Voice' : facts.mode === 'typed' ? 'Typed' : 'Input mode not recorded'}`),
    record.discipline === 'design' ? stat('Board', facts.finalBoard ? 'Recorded' : 'Empty', 'Semantic graph') : stat('Hints', String(facts.hints.length), facts.hints.length ? facts.hints.map(h => h.level).join(', ') : 'None taken'),
    record.discipline === 'design' ? null : stat('Runs', String(facts.runs.length), facts.runs.length ? (runsFailed ? `${runsFailed} failed` : record.discipline === 'lld' ? 'All exited normally' : 'All passed') : 'No runs'),
    record.discipline === 'lld' || record.discipline === 'design' ? null : stat('Submission', verdict ? (verdict.accepted ? 'Accepted' : verdict.label) : '—', verdict ? `at ${formatClock(verdict.at)}` : 'Not submitted'),
    stat(facts.mode === 'voice' ? 'Your word share' : 'Your written word share', facts.talkShare === null ? '—' : `${Math.round(facts.talkShare * 100)}%`, facts.talkShare === null ? 'Said nothing' : `${facts.candidateWords} words`),
  ]);
  const lists = (j.strengths.length || j.improvements.length) ? el('div', { class: 'rp-two' }, [
    section('What went well', j.strengths.length ? el('ul', { class: 'rp-list is-good' }, j.strengths.map(s => el('li', { text: s }))) : el('p', { class: 'rp-note is-missing', text: 'Nothing recorded.' })),
    section('What to improve', j.improvements.length ? el('ul', { class: 'rp-list is-fix' }, j.improvements.map(s => el('li', { text: s }))) : el('p', { class: 'rp-note is-missing', text: 'Nothing recorded.' })),
  ]) : null;
  const practice = j.practice.length ? section('Practise next', el('ol', { class: 'rp-practice' }, j.practice.map((p, i) => el('li', {}, [
    el('span', { class: 'rp-practice-n tnum', text: String(i + 1) }),
    el('div', {}, [el('strong', { text: p.title }), p.why ? el('p', { text: p.why }) : null]),
  ])))) : null;
  return el('div', { class: 'rp-body' }, [
    hero, stats,
    facts.phases.length || j.moments.length ? section('How it went', timeline(facts, j.moments, jump, record.discipline)) : section('Timeline', el('p', { class: 'rp-note', text: 'Phase durations were not recorded for this interview.' })),
    written,
    j.dimensions.length ? section('Scorecard', el('div', { class: 'rp-dims' }, j.dimensions.map(d => dimensionCard(d, jump, onAsk)))) : null,
    ...[['Hard technical errors', j.technicalErrors], ['Missing considerations', j.missingConsiderations], ['Self-caught vs interviewer-surfaced', j.discoveries]].filter(([, items]) => items?.length).map(([title, items]) => section(title, el('ul', { class: 'rp-list' }, items.map(text => el('li', { text }))))),
    j.moveUp ? section('What would move this up a level', el('p', { class: 'rp-summary', text: j.moveUp })) : null,
    lists,
    record.discipline === 'design' ? null : codeSection(facts, j.code, record.discipline),
    practice,
    transcriptBox,
  ]);
}

/** The question each scorecard area's Ask button asks. */
export function dimensionQuestion(d) {
  const rated = d.rating ? `${d.name} was rated ${d.rating}. ` : '';
  return rated + ({
    Testing: 'What test cases could I have asked about or run for this problem, and what would each one catch?',
    'Problem solving': 'How could I have reached the right approach sooner?',
    Coding: 'What should I change in my code, and why?',
    Communication: 'What should I have said out loud, and when?',
  }[d.name] || 'What would a strong answer have looked like here?');
}

/** Starting questions for an empty thread: the weakest scorecard areas first. */
export function suggestedQuestions(judgement, discipline = 'coding') {
  const order = { Weak: 0, Mixed: 1, Solid: 2, Strong: 3 };
  const weakest = (judgement?.dimensions || []).filter(d => d.rating === 'Weak' || d.rating === 'Mixed')
    .sort((a, b) => order[a.rating] - order[b.rating]).map(dimensionQuestion);
  const testing = judgement || discipline !== 'coding' ? [] : ['What test cases could I have asked about or run for this problem?'];
  return [...weakest, ...testing, discipline === 'coding' ? 'Walk me through the best solution and how I could have found it.' : 'Walk me through a strong design and explain its trade-offs.', 'Where did I lose the most time, and what should I have done instead?'].slice(0, 3);
}

/**
 * Follow-up questions about the finished interview. Each question is saved by the
 * server before it is answered, and an unsent question stays as a draft, so closing the
 * sheet loses nothing. `load()` returns the saved exchanges; `send(body, onEvent)` streams one.
 */
function createFollowups({ id, judgement, load, send, learningSlug = null, discipline = 'coding' }) {
  const draftKey = 'interview-review:' + id;
  const thread = el('div', { class: 'rp-ask-thread', role: 'log', 'aria-label': 'Questions about this interview', tabindex: '0' });
  const input = el('textarea', { class: 'coach-input rp-ask-input', rows: '2', 'aria-label': 'Ask about this interview', placeholder: 'Ask about your interview…' });
  const inputSize = bindComposerInput(input);
  const askButton = composerSend(el('button', { type: 'button', onclick: () => ask(input.value) }), 'Ask interviewer');
  const status = el('p', { class: 'rp-ask-status', role: 'status', hidden: true });
  const starters = el('div', { class: 'rp-ask-starters' }, suggestedQuestions(judgement, discipline).map(question =>
    el('button', { type: 'button', class: 'rp-ask-starter', text: question, onclick: () => ask(question) })));
  const root = el('aside', { class: 'rp-ask', 'aria-label': 'Ask about this interview' }, [
    el('div', { class: 'rp-ask-head' }, [el('strong', { text: 'Ask the interviewer' }), el('span', { class: 'dim', text: discipline === 'design' ? 'It has your transcript, board and this report.' : 'It has your transcript, code and this report.' })]),
    thread,
    createComposer({ className: 'rp-ask-compose', content: [input], notices: [status], trailing: [askButton] }),
  ]);
  let busy = false, gone = false;
  // Answers still arriving from before the sheet was closed, by request.
  const waiting = new Map();
  input.value = readDraft(draftKey)?.text || '';
  input.addEventListener('input', () => { saveDraft(draftKey, input.value); autosize(); paint(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey) {
      if (claimActionKey(event)) ask(input.value);
    }
  });
  function autosize() { inputSize.resize(); }
  const atBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 24;
  function paint() {
    const held = busy || waiting.size > 0;
    askButton.disabled = held || !input.value.trim();
    askButton.setAttribute('aria-label', held ? 'Answering' : 'Ask interviewer');
    starters.hidden = Boolean(thread.querySelector('.rp-ask-pair'));
  }
  function pair(question) {
    const body = el('div', { class: 'cmsg-body rich' });
    const node = el('div', { class: 'rp-ask-pair' }, [
      el('article', { class: 'cmsg you' }, [el('div', { class: 'cmsg-who dim', text: 'You' }), el('div', { class: 'cmsg-body' }, el('p', { class: 'user-text', text: question }))]),
      el('article', { class: 'cmsg reply' }, [el('div', { class: 'cmsg-who dim', text: 'Interviewer' }), body]),
    ]);
    thread.insertBefore(node, starters);
    return body;
  }
  function showAnswer(body, item) {
    for (const action of item.actions || []) showWorkspaceAction(thread, action, { replay: true });
    if (item.pending) { replace(body, el('div', { class: 'coach-thinking', 'aria-label': 'Answering' }, [el('i'), el('i'), el('i')])); return; }
    if (item.answer && !item.failed) {
      replace(body, renderMarkdown(item.answer));
      if (learningSlug) {
        const save = el('button', { class: 'btn btn--quiet btn--sm', text: 'Save to learning notes', onclick: async () => {
          save.disabled = true;
          try { await saveLearningNote(learningSlug, `From interview ${id} — model explanation\n\n${item.question}\n\n${item.answer}`); save.textContent = 'Saved to notes'; }
          catch (error) { save.textContent = error.message; save.disabled = false; }
        } }); body.append(save);
      }
      return;
    }
    replace(body, el('div', { class: 'state ui-inset ui-cluster' }, [
      el('p', { class: 'ui-cluster-content', text: item.error || (item.answer === null && !item.failed ? 'No answer was saved for this question.' : 'The answer did not finish.') }),
      el('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Ask again', onclick: () => run(item.question, item.requestId, body) }),
    ]));
  }
  async function run(question, requestId, body, typed = false) {
    if (busy || gone) return;
    let accepted = false;
    busy = true; status.hidden = true; paint();
    replace(body, el('div', { class: 'coach-thinking', 'aria-label': 'Answering' }, [el('i'), el('i'), el('i')]));
    let text = '';
    try {
      const result = await send({ question, requestId }, (name, payload) => {
        if (name === 'accepted') {
          accepted = true;
          // Saved by the server now, so the typed draft can go.
          if (typed && readDraft(draftKey)?.text.trim() === question) clearDraft(draftKey);
        }
        if (name === 'action' && !gone) showWorkspaceAction(thread, payload);
        if (name !== 'token' || gone) return;
        const follow = atBottom();
        text += payload.text || '';
        replace(body, renderMarkdown(text));
        if (follow) thread.scrollTop = thread.scrollHeight;
      });
      if (result?.duplicate) text = result.followup.answer;
      if (!gone) showAnswer(body, { question, requestId, answer: text });
    } catch (failure) {
      // Never received, so never saved: put a typed question back where it was written.
      if (typed && !accepted && !gone && !input.value.trim()) { input.value = question; saveDraft(draftKey, question); autosize(); }
      if (!gone) showAnswer(body, { question, requestId, answer: text || null, failed: true, error: failure.message });
    } finally { busy = false; if (!gone) paint(); }
  }
  function ask(raw) {
    const question = String(raw || '').trim();
    if (!question || busy || waiting.size) return;
    // The box empties now; the stored draft stays until the server has the question.
    const typed = input.value.trim() === question;
    if (typed) { input.value = ''; autosize(); }
    const body = pair(question);
    thread.scrollTop = thread.scrollHeight;
    run(question, crypto.randomUUID(), body, typed);
  }
  thread.append(starters);
  paint();
  // Check back until each answer still arriving is saved.
  async function settle() {
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (gone) return;
    let items;
    try { items = await load(); } catch { items = null; }
    if (gone) return;
    for (const item of items || []) {
      if (!waiting.has(item.requestId) || item.pending) continue;
      showAnswer(waiting.get(item.requestId), item);
      waiting.delete(item.requestId);
    }
    paint();
    if (waiting.size) settle();
  }
  load().then(items => {
    if (gone) return;
    for (const item of items || []) {
      const body = pair(item.question);
      showAnswer(body, item);
      if (item.pending) waiting.set(item.requestId, body);
    }
    paint();
    thread.scrollTop = thread.scrollHeight;
    if (waiting.size) settle();
  }).catch(failure => { status.textContent = `Earlier questions could not be loaded: ${failure.message}`; status.hidden = false; });
  return { root, ask, dispose: () => { inputSize.dispose(); gone = true; } };
}

let openSheet = null;
/**
 * Show the report as a sheet; Esc, the scrim or Close dismisses it. The transcript is
 * copied, never moved. With `followups`, the sheet carries a panel for asking about it.
 */
export function openReport({ title, record, report, transcript, followups = null, debriefText = '' }) {
  openSheet?.close();
  const dialog = el('dialog', { class: 'rp-sheet' + (followups ? ' has-ask' : ''), 'aria-label': 'Interview report' });
  const asking = followups && record.id ? createFollowups({ id: record.id, discipline: record.discipline, judgement: report.judgement, learningSlug: record.topicSlug || (record.discipline === 'lld' ? record.slug : null), ...followups }) : null;
  const close = () => dialog.close();
  const branchStatus = el('p', { class: 'rp-note ui-inset', role: 'status', hidden: true });
  const branch = ['lld', 'design'].includes(record.discipline) && record.id ? el('button', {
    type: 'button', class: 'btn btn--secondary btn--sm', text: 'Practise from this mock', onclick: async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        const { startPracticeFromMock } = await import('./practice.js');
        await startPracticeFromMock({ discipline: record.discipline, slug: record.topicSlug || record.slug, interviewId: record.id });
        close();
      } catch (error) { button.disabled = false; branchStatus.hidden = false; branchStatus.textContent = error.message; }
    },
  }) : null;
  dialog.append(
    dialogHeader({ title: 'Interview report', closeLabel: 'Close report', onClose: close, actions: [branch,
      el('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => window.print() }, [icon('print', 14), el('span', { text: 'Print' })]),
    ] }),
    branchStatus,
    el('div', { class: 'rp-main' }, [
      el('div', { class: 'rp-scroll' }, renderReport({ title, record, report, transcript: transcript?.cloneNode(true), onAsk: asking?.ask, debriefText })),
      asking?.root,
    ]),
  );
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('close', () => {
    asking?.dispose();
    document.body.classList.remove('has-report');
    dialog.remove(); if (openSheet === api) openSheet = null;
  });
  document.body.append(dialog);
  document.body.classList.add('has-report');
  dialog.showModal();
  // The question panel keeps the width you drag it to; the report keeps at least 440px.
  const removeResizer = asking ? installDrawerResizer(asking.root, {
    key: 'studio.report.ask.width.v1', label: 'Question panel width', initial: 380, minWidth: 300,
    maxWidth: () => dialog.getBoundingClientRect().width - 440,
    active: () => !window.matchMedia('(max-width: 1080px)').matches,
  }) : null;
  dialog.addEventListener('close', () => removeResizer?.());
  const api = { close, root: dialog };
  openSheet = api;
  return api;
}
