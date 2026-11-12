import { createVoiceControl } from './voice.js';
import { createCoachModelPicker } from './coach-model.js';
import { conversationMessage, bindConversation, messageAction, thinkingRow, conversationText } from './ui/conversation.js';
import { practiseFromMock } from './ui/button.js';
import { createComposer, composerSend, bindComposerInput, mountComposerDictation } from './ui/composer.js';
import { claimActionKey } from './keyboard.js';
import { showWorkspaceAction } from './workspace-tools.js';
import { saveLearningNote } from './learning.js';
// The full interview report: a sheet over the workspace. Facts come from the server's
// count of the record; judgement from the interviewer's validated JSON. Anything
// missing is said plainly, never filled in.
import { el, replace } from './dom.js';
import { icon } from './ui/icon.js';
import { dialogHeader, paneHeader } from './ui/headers.js';
import { highlightPython } from './highlight.js';
import { formatClock } from './recorder.js';
import { ratingTone, relativeInterviewDate, reportDifficultyLabel } from './interview-format.js';
import { renderMarkdown } from './markdown.js';
import { appendDraft, readDraft, saveDraft, clearDraft } from './drafts.js';

const PHASE_LABELS = { clarify: 'Clarify', approach: 'Approach', code: 'Code', test: 'Test', followup: 'Follow-up' };
const SIGNALS = ['No hire', 'Lean no', 'Lean hire', 'Hire', 'Strong hire'];
const MOMENT_LABELS = { insight: 'Insight', stuck: 'Stuck', hint: 'Hint', bug: 'Bug', fix: 'Fix', test: 'Test', verdict: 'Verdict' };
const minutes = ms => ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60000)} min`;

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

/** Quotes are attached in dimension order, within an inclusive minute, once per quote. */
export function attachMomentQuotes(moments, dimensions) {
  const evidence = dimensions.flatMap(d => d.evidence || []).filter(e => e.quote && Number.isFinite(e.at));
  const used = new Set();
  return moments.map(moment => {
    const quote = Number.isFinite(moment.at) ? evidence.find(e => !used.has(e.quote) && Math.abs(e.at - moment.at) <= 60000) : null;
    if (quote) used.add(quote.quote);
    return { ...moment, evidence: quote || null };
  });
}

export function defaultDimensionIndex(dimensions) {
  const weak = dimensions.findIndex(d => d.rating === 'Weak');
  const mixed = dimensions.findIndex(d => d.rating === 'Mixed');
  return weak >= 0 ? weak : mixed >= 0 ? mixed : 0;
}

function timeLink(at, jump) {
  return Number.isFinite(at) ? el('button', { type: 'button', class: 'btn btn--quiet rp-time tnum', text: formatClock(at), onclick: () => jump(at) }) : null;
}

function timeline(facts, moments, jump, discipline) {
  const labels = discipline === 'lld' ? { clarify: 'Requirements', approach: 'Design', code: 'Implement', test: 'Verify', followup: 'Extend' } : PHASE_LABELS;
  const phases = facts.phases.filter(p => p.ms > 0);
  const track = el('div', { class: 'rp-track' }, phases.length
    ? phases.map(p => el('span', { class: 'rp-seg', dataset: { phase: p.phase }, style: `flex:${p.ms}` }))
    : [el('span', { class: 'rp-seg is-empty', style: 'flex:1' })]);
  const legend = el('div', { class: 'rp-legend' }, [
    ...phases.map(p => el('span', { class: 'rp-legend-item' }, [el('i', { dataset: { phase: p.phase } }), `${labels[p.phase] || p.phase} ${minutes(p.ms)}`])),
  ]);
  const momentList = moments.length ? el('ol', { class: 'rp-moments' }, moments.map(m => el('li', { dataset: { kind: m.kind } }, [
    m.at === null ? el('span', { class: 'rp-time is-empty', text: '—' })
      : el('button', { type: 'button', class: 'btn btn--quiet rp-time tnum', text: formatClock(m.at), onclick: () => jump(m.at) }),
    el('span', { class: 'rp-moment-kind', text: MOMENT_LABELS[m.kind] || m.kind }),
    el('div', { class: 'rp-moment-text' }, [el('span', { text: m.text }), m.evidence ? el('blockquote', { class: 'rp-moment-quote' }, el('q', { text: m.evidence.quote })) : null]),
  ]))) : null;
  return el('div', { class: 'rp-timeline' }, [
    el('div', { class: 'rp-track-wrap' }, [track,
      el('div', { class: 'rp-track-ends tnum' }, [el('span', { text: '0:00' }), el('span', { text: formatClock(facts.durationMs) })])]),
    legend, momentList,
  ]);
}

function dimensionCard(d, jump, onAsk) {
  const evidence = d.evidence?.length ? el('ul', { class: 'rp-evidence' }, d.evidence.map(e => el('li', {}, [
    e.quote ? el('blockquote', {}, [timeLink(e.at, jump), el('q', { class: 'rp-quote', text: e.quote })]) : timeLink(e.at, jump),
    e.note ? el('p', { class: 'rp-note', text: (e.provenance === 'interpretation' ? 'Interviewer observation: ' : '') + e.note }) : null,
  ]))) : el('p', { class: 'rp-note is-missing', text: 'No evidence recorded.' });
  return el('article', { class: 'rp-dim' }, [
    el('h4', { text: d.name }),
    d.summary ? el('p', { class: 'rp-dim-summary', text: d.summary }) : null,
    evidence,
    onAsk ? el('button', { type: 'button', class: 'btn btn--secondary rp-dim-ask', text: 'Ask about this', 'aria-label': `Ask about ${d.name.toLowerCase()}`, onclick: () => onAsk(dimensionQuestion(d)) }) : null,
  ]);
}

function boxScore(dimensions, jump, onAsk) {
  let selected = defaultDimensionIndex(dimensions);
  const detail = el('div', { class: 'rp-dim-detail', 'aria-live': 'polite' }, dimensionCard(dimensions[selected], jump, onAsk));
  const rows = dimensions.map((d, i) => el('button', {
    type: 'button', class: 'ui-action-row rp-dim-row', 'aria-pressed': String(i === selected),
    onclick: () => {
      selected = i;
      rows.forEach((row, n) => row.setAttribute('aria-pressed', String(n === selected)));
      replace(detail, dimensionCard(d, jump, onAsk));
    },
  }, [el('span', { text: d.name }), el('strong', { class: 'rp-rating', dataset: { tone: d.rating ? ratingTone(d.rating) : 'neutral' }, text: d.rating || 'Not rated' })]));
  return section('Box score', el('div', { class: 'rp-dims' }, [el('div', { class: 'rp-dim-rows', 'aria-label': 'Dimensions' }, rows), detail]));
}

function practiceSection(j, jump) {
  const items = (j.practice || []).slice(0, 3);
  const legacy = !items.some(p => p.fix) && j.improvements?.length;
  if (!items.length && !legacy) return null;
  return section('Fix these three', el('div', {}, [
    el('ol', { class: 'rp-practice' }, items.map((p, i) => el('li', {}, [
      el('div', { class: 'rp-practice-top' }, [el('span', { class: 'rp-practice-n tnum', text: String(i + 1) }), timeLink(p.at, jump)]),
      el('h4', { text: p.fix || p.title }),
      p.why ? el('p', { text: p.why }) : null,
      p.fix ? el('p', { class: 'rp-drill' }, [el('strong', { text: 'Drill' }), ` · ${p.title}`]) : null,
    ]))),
    legacy ? el('ul', { class: 'rp-list rp-legacy-improvements' }, j.improvements.map(text => el('li', { text }))) : null,
  ]));
}

function codeSection(facts, code, discipline) {
  const lld = discipline === 'lld';
  if (!code && !facts.finalCode) return null;
  const same = !lld && code?.complexity && code?.optimal && code.complexity.replace(/\s/g, '').toLowerCase() === code.optimal.replace(/\s/g, '').toLowerCase();
  const final = facts.finalCode ? el('details', { class: 'rp-code', open: true }, [
    el('summary', { text: 'Your final code' }),
    el('pre', { class: 'mono' }, el('code', {}, highlightPython(facts.finalCode))),
  ]) : null;
  const complexity = code?.complexity || code?.optimal ? el('div', { class: 'rp-complexity' }, [
    el('span', {}, [el('span', { class: 'rp-stat-label', text: 'Yours · ' }), el('strong', { class: 'mono', text: code.complexity || 'Not assessed' })]),
    !lld ? el('span', {}, [el('span', { class: 'rp-stat-label', text: 'Best known · ' }), el('strong', { class: 'mono', text: code.optimal || 'Not assessed' })]) : null,
    same ? el('span', { class: 'ui-badge ui-badge--success', text: 'Optimal' }) : null,
  ]) : null;
  return el('section', { class: 'rp-section rp-solution' }, [el('header', { class: 'rp-code-head' }, [el('h3', { class: 'rp-h', text: 'Your code' }), complexity]), el('div', {}, [
    code?.notes?.length ? el('ul', { class: 'rp-list' }, code.notes.map(n => el('li', { text: n }))) : null,
    final,
  ])]);
}

/** Build the report body. `jump(ms)` scrolls the transcript to that moment; `onAsk(question)` asks a follow-up. */
/** Mirrors regradeLine on the server, so the screen and interview.md say the same thing. */
export function regradedText(regraded) {
  const o = regraded.original;
  const when = value => value ? relativeInterviewDate(Date.parse(value)).replace(/^(Today|Yesterday)/, w => w.toLowerCase()) : 'on an unrecorded date';
  return `Re-graded ${when(regraded.at)} with the current report rules.${o ? ` The original report said ${o.signal || 'no signal'}${o.headline ? `: “${o.headline.replace(/\.$/, '')}”` : ''}. It is kept in the interview record.` : ''}`;
}

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
    target.scrollIntoView({ block: 'center', behavior: document.body.classList.contains('motion-off') || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    target.classList.remove('rp-flash'); void target.offsetWidth; target.classList.add('rp-flash');
  };
  const runsFailed = facts.runs.filter(r => !r.passed).length;
  const verdict = facts.verdicts.at(-1);
  const difficulty = reportDifficultyLabel(record.reportDifficulty);
  const mode = facts.mode === 'voice' ? 'Voice' : facts.mode === 'typed' ? 'Typed' : 'Input mode not recorded';
  const stats = el('div', { class: 'rp-stats' }, [
    stat('Time', formatClock(facts.durationMs), `of ${formatClock(facts.plannedMs)}`),
    record.discipline === 'design' ? stat('Board', facts.finalBoard ? 'Recorded' : 'Empty', 'Semantic graph') : stat('Hints', facts.hints.length ? `${facts.hints.length} ${facts.hints.length === 1 ? (facts.hints[0].level === 'nudge' ? 'nudge' : 'hint') : 'hints'}` : 'None taken'),
    record.discipline === 'design' ? null : stat('Runs', String(facts.runs.length), facts.runs.length ? (facts.runs.at(-1).passed ? (record.discipline === 'lld' ? 'Last exited normally' : 'Last passed') : `${runsFailed} failed`) : 'No runs'),
    record.discipline === 'lld' || record.discipline === 'design' ? null : stat('Submission', verdict ? (verdict.accepted ? 'Accepted' : verdict.label) : 'Not submitted', verdict ? `at ${formatClock(verdict.at)}` : ''),
  ]);
  const hero = el('header', { class: 'rp-hero', dataset: { tone: j.signal ? ratingTone(j.signal) : 'neutral' } }, [
    el('div', { class: 'rp-masthead' }, [
      el('span', { class: 'rp-eyebrow', text: `Mock interview · ${title}` }),
      el('div', { class: 'rp-meta' }, [el('span', { text: `${relativeInterviewDate(record.startedAt)} · ${mode}` }), difficulty ? el('span', { class: 'rp-graded', text: `Graded at ${difficulty}` }) : null]),
    ]),
    el('div', { class: 'rp-verdict' }, [el('div', { class: 'rp-verdict-copy' }, [
      el('h2', { class: 'rp-signal', text: j.signal || 'No signal recorded' }),
      signalScale(j.signal),
      j.headline ? el('p', { class: 'rp-headline', text: j.headline }) : null,
    ]), stats]),
    report.regraded ? el('p', { class: 'rp-regraded rp-note', text: regradedText(report.regraded) }) : null,
    el('p', { class: 'rp-assessment rp-note', text: 'Practice assessment · model judgments should be checked against the recorded evidence.' }),
  ]);
  return el('div', { class: 'rp-body' }, [
    hero,
    // Keep the existing Markdown heading verbatim, so exported and on-screen reports agree.
    j.moveUp ? section('What would move this up a level', el('p', { text: j.moveUp }), 'rp-move-up') : null,
    practiceSection(j, jump),
    written,
    j.dimensions.length ? boxScore(j.dimensions, jump, onAsk) : null,
    ...[['Hard technical errors', j.technicalErrors], ['Missing considerations', j.missingConsiderations], ['Self-caught vs interviewer-surfaced', j.discoveries]].filter(([, items]) => items?.length).map(([title, items]) => section(title, el('ul', { class: 'rp-list' }, items.map(text => el('li', { text }))))),
    section('Play by play', el('div', {}, [
      facts.phases.length || j.moments.length ? timeline(facts, attachMomentQuotes(j.moments, j.dimensions), jump, record.discipline) : el('p', { class: 'rp-note', text: 'Phase durations were not recorded for this interview.' }),
      transcriptBox,
    ])),
    record.discipline === 'design' ? null : codeSection(facts, j.code, record.discipline),
    section('What went well', j.strengths.length ? el('ul', { class: 'rp-list is-good' }, j.strengths.map(s => el('li', { text: s }))) : el('p', { class: 'rp-note is-missing', text: 'Nothing recorded.' })),
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
  const input = el('textarea', { class: 'coach-input rp-ask-input', rows: '2', 'aria-label': 'Ask about this interview', placeholder: 'Ask about your interview' });
  const inputSize = bindComposerInput(input);
  const askButton = composerSend(el('button', { type: 'button', onclick: () => ask(input.value) }), 'Ask interviewer');
  const status = el('p', { class: 'rp-ask-status', role: 'status', hidden: true });
  const starters = el('div', { class: 'rp-ask-starters' }, suggestedQuestions(judgement, discipline).map(question =>
    el('button', { type: 'button', class: 'ui-action-row ui-starter rp-ask-starter', onclick: () => ask(question) }, [icon('forward', 15), el('span', { text: question })])));
  const modelPicker = createCoachModelPicker({ compact: true });
  const root = el('aside', { class: 'rp-ask', 'aria-label': 'Ask about this interview' }, [
    Object.assign(paneHeader({ title: 'Ask the interviewer' }), { className: 'ui-pane-header rp-ask-head' }),
    thread,
    createComposer({ className: 'rp-ask-compose', content: [input], notices: [status], leading: [modelPicker.root], trailing: [askButton] }),
  ]);
  const dictation = createVoiceControl({ getSlug: () => '', logTakes: false, onTranscript: text => {
    if (gone) { appendDraft(draftKey, text); return; }
    input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + text;
    saveDraft(draftKey, input.value); autosize(); paint();
  } });
  mountComposerDictation(root.querySelector('.ui-composer'), dictation);
  const conversationView = bindConversation(thread, { composer: root.querySelector('.ui-composer') });
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
    const held = busy || waiting.size > 0; modelPicker.setBusy(held);
    askButton.disabled = held || !input.value.trim();
    askButton.setAttribute('aria-label', held ? 'Answering' : 'Ask interviewer');
    starters.hidden = Boolean(thread.querySelector('.rp-ask-pair'));
  }
  function pair(question) {
    const body = conversationText('', { className: 'cmsg-body' });
    const node = el('div', { class: 'rp-ask-pair ui-message-group' }, [
      conversationMessage({ speaker: 'You', user: true, text: question, className: 'cmsg you' }),
      conversationMessage({ speaker: 'Interviewer', body, className: 'cmsg reply' }),
    ]);
    thread.insertBefore(node, starters);
    return body;
  }
  function showAnswer(body, item) {
    for (const action of item.actions || []) showWorkspaceAction(thread, action, { replay: true });
    if (item.pending) { replace(body, thinkingRow()); return; }
    if (item.answer && !item.failed) {
      replace(body, renderMarkdown(item.answer));
      if (learningSlug) {
        const save = el('button', { class: 'btn btn--quiet', text: 'Save to learning notes', onclick: async () => {
          save.disabled = true;
          try { await saveLearningNote(learningSlug, `From interview ${id} — model explanation\n\n${item.question}\n\n${item.answer}`); save.textContent = 'Saved to notes'; }
          catch (error) { save.textContent = error.message; save.disabled = false; }
        } }); messageAction(save, 'report', 'Save to notes'); body.closest('.ui-message').querySelector('.ui-message-actions').append(save);
      }
      return;
    }
    replace(body, el('div', { class: 'state ui-inset ui-cluster' }, [
      el('p', { class: 'ui-cluster-content', text: item.error || (item.answer === null && !item.failed ? 'No answer was saved for this question.' : 'The answer did not finish.') }),
      el('button', { class: 'btn btn--secondary', type: 'button', text: 'Ask again', onclick: () => run(item.question, item.requestId, body) }),
    ]));
  }
  async function run(question, requestId, body, typed = false) {
    if (busy || gone) return;
    let accepted = false;
    busy = true; status.hidden = true; paint();
    replace(body, thinkingRow());
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
        body.dataset.streaming = 'true';
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
    } finally {
      body.dataset.streaming = 'false'; busy = false; if (!gone) paint(); }
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
  return { root, ask, dispose: () => { inputSize.dispose(); dictation.dispose({ finish: true }); modelPicker.dispose(); conversationView.dispose(); gone = true; } };
}

let openSheet = null;
// The question panel docks beside the report so both stay in view. Its width and whether
// it is shown are a per-browser convenience, so storage failing only means defaults.
const ASK_PANEL_KEY = 'report-ask-panel';
const ASK_MIN = 320, REPORT_MIN = 360, ASK_DEFAULT = 440;
const narrow = () => window.matchMedia('(max-width: 900px)').matches;
function readPanel() {
  try { const v = JSON.parse(localStorage.getItem(ASK_PANEL_KEY) || 'null'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function savePanel(value) { try { localStorage.setItem(ASK_PANEL_KEY, JSON.stringify(value)); } catch { /* defaults next time */ } }

/**
 * Show the report as a sheet; Esc, the scrim or Close dismisses it. The transcript is
 * copied, never moved. With `followups`, the sheet carries a docked, resizable panel
 * for asking about it.
 */
export function openReport({ title, record, report, transcript, followups = null, debriefText = '', onRegrade = null }) {
  openSheet?.close();
  const dialog = el('dialog', { class: 'rp-sheet' + (followups ? ' has-ask' : ''), 'aria-label': 'Interview report' });
  const asking = followups && record.id ? createFollowups({ id: record.id, discipline: record.discipline, judgement: report.judgement, learningSlug: record.topicSlug || (record.discipline === 'lld' ? record.slug : null), ...followups }) : null;
  const close = () => dialog.close();
  const main = el('div', { class: 'rp-main' });
  const stored = readPanel();
  let panelWidth = Number.isFinite(stored.width) ? stored.width : ASK_DEFAULT;
  // A phone opens on the report; a wide screen opens as last left, shown by default.
  let panelOpen = asking ? (narrow() ? false : stored.open !== false) : false;
  const maxWidth = () => Math.max(ASK_MIN, main.getBoundingClientRect().width - REPORT_MIN);
  const toggle = asking ? el('button', { type: 'button', class: 'btn btn--quiet rp-ask-toggle', 'aria-label': 'Ask the interviewer', onclick: () => setOpen(!panelOpen) }, [icon('sidebar', 14), el('span', {}, ['Ask', el('span', { class: 'rp-ask-toggle-long', text: ' the interviewer' })])]) : null;
  const widen = asking ? el('button', { type: 'button', class: 'btn btn--icon rp-ask-widen', 'aria-label': 'Widen panel', onclick: () => {
    const half = Math.round(main.getBoundingClientRect().width / 2);
    setWidth(panelWidth >= half - 8 ? ASK_DEFAULT : half, true);
  } }, icon('fit', 15)) : null;
  const handle = asking ? el('div', { class: 'rp-ask-resize', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Resize the question panel', 'aria-valuemin': String(ASK_MIN) }) : null;
  function setWidth(width, save = false) {
    panelWidth = Math.round(Math.min(maxWidth(), Math.max(ASK_MIN, width)));
    main.style.setProperty('--rp-ask-w', panelWidth + 'px');
    handle.setAttribute('aria-valuenow', String(panelWidth));
    handle.setAttribute('aria-valuemax', String(Math.round(maxWidth())));
    const half = Math.round(main.getBoundingClientRect().width / 2);
    widen.setAttribute('aria-label', panelWidth >= half - 8 ? 'Narrow panel' : 'Widen panel');
    if (save) savePanel({ open: panelOpen, width: panelWidth });
  }
  function setOpen(open, focus = true) {
    panelOpen = open;
    main.classList.toggle('is-asking', open);
    asking.root.hidden = !open; handle.hidden = !open;
    toggle.setAttribute('aria-pressed', String(open));
    if (!narrow()) savePanel({ open, width: panelWidth });
    if (open) { setWidth(panelWidth); if (focus) asking.root.querySelector('.rp-ask-input')?.focus({ preventScroll: true }); }
  }
  const body = renderReport({ title, record, report, transcript: transcript?.cloneNode(true), onAsk: asking ? question => { if (!panelOpen) setOpen(true); asking.ask(question); } : null, debriefText });
  if (asking) {
    asking.root.querySelector('.rp-ask-head .ui-pane-tools').append(el('div', { class: 'rp-ask-tools' }, [
      widen,
      el('button', { type: 'button', class: 'btn btn--icon icon-btn rp-ask-hide', 'aria-label': 'Hide the question panel', onclick: () => { setOpen(false); toggle.focus(); } }, icon('close', 14)),
    ]));
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      main.classList.add('is-resizing');
      const right = main.getBoundingClientRect().right;
      const move = e => setWidth(right - e.clientX);
      const up = () => { handle.removeEventListener('pointermove', move); main.classList.remove('is-resizing'); setWidth(panelWidth, true); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
    handle.addEventListener('dblclick', () => setWidth(ASK_DEFAULT, true));
    handle.addEventListener('keydown', event => {
      const step = event.shiftKey ? 96 : 32;
      if (event.key === 'ArrowLeft') setWidth(panelWidth + step, true);
      else if (event.key === 'ArrowRight') setWidth(panelWidth - step, true);
      else return;
      event.preventDefault();
    });
  }
  const branchStatus = el('p', { class: 'rp-note ui-inset', role: 'status', hidden: true });
  const branch = ['lld', 'design'].includes(record.discipline) && record.id ? practiseFromMock({ variant: 'primary',
    type: 'button', onClick: async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        const { startPracticeFromMock } = await import('./practice.js');
        await startPracticeFromMock({ discipline: record.discipline, slug: record.topicSlug || record.slug, interviewId: record.id });
        close();
      } catch (error) { button.disabled = false; branchStatus.hidden = false; branchStatus.textContent = error.message; }
    },
  }) : null;
  // Grades the same record again under the current rules. Confirmed with a second click, never a browser dialog.
  let confirming = false;
  const regrade = onRegrade && report.judgement && record.id ? el('button', {
    type: 'button', class: 'btn btn--quiet', text: 'Re-grade', title: 'Grade this interview again with the current report rules. The original report is kept in the record.',
    onclick: async event => {
      const button = event.currentTarget;
      if (!confirming) {
        confirming = true; button.textContent = 'Confirm re-grade';
        branchStatus.hidden = false; branchStatus.textContent = 'This writes a new report from the same record. The original stays in the interview record. Click again to confirm.';
        return;
      }
      button.disabled = true; button.textContent = 'Re-grading…';
      branchStatus.hidden = false; branchStatus.textContent = 'Re-grading from the saved record. This takes a minute or two.';
      try { await onRegrade(); close(); }
      catch (error) { confirming = false; button.disabled = false; button.textContent = 'Re-grade'; branchStatus.textContent = error.message; }
    },
  }) : null;
  main.append(el('div', { class: 'rp-scroll' }, body), handle, asking?.root);
  dialog.append(
    dialogHeader({ title: 'Interview report', closeLabel: 'Close report', onClose: close, actions: { primary: branch, secondary: [toggle], overflow: [regrade,
      el('button', { type: 'button', class: 'btn btn--quiet', onclick: () => window.print() }, [icon('print', 14), el('span', { text: 'Print' })]),
    ] } }),
    branchStatus,
    main,
  );
  // A window made smaller must not leave the report squeezed under its minimum.
  const resized = () => { if (panelOpen && !narrow()) setWidth(panelWidth); };
  window.addEventListener('resize', resized);
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('close', () => {
    asking?.dispose();
    window.removeEventListener('resize', resized);
    document.body.classList.remove('has-report');
    dialog.remove(); if (openSheet === api) openSheet = null;
  });
  document.body.append(dialog);
  document.body.classList.add('has-report');
  dialog.showModal();
  if (asking) setOpen(panelOpen, false);
  const api = { close, root: dialog };
  openSheet = api;
  return api;
}
