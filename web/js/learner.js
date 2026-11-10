import { el, replace } from './dom.js';
import { signalLabel, reportDifficultyLabel } from './interview-format.js';
export function createLearnerSummary(discipline) {
  let disposed = false;
  const summary = el('summary', { text: 'Your learning context' });
  const content = el('div', { class: 'ui-stack', hidden: true }, el('p', { class: 'dim', text: 'Reading saved practice…' }));
  const root = el('details', { class: 'ui-inset ui-stack learner-context' }, [summary, content]);
  root.addEventListener('toggle', () => { content.hidden = !root.open; });
  fetch('/api/learner').then(async response => { const result = await response.json(); if (!response.ok) throw Error(result.error?.message || 'Could not read learning history.'); return result.profile; }).then(profile => {
    if (disposed) return;
    const attempted = profile.attempted?.[discipline] || [];
    const practicedCount = new Set(attempted.map(x => typeof x === 'string' ? x : x.slug)).size;
    const assessments = (profile.assessments || []).filter(x => x.discipline === discipline);
    const rated = assessments.find(x => x.signal && x.targetLevel);
    const weaknesses = (profile.recurring?.weaknesses || []).filter(x => x.discipline === discipline).slice(0, 3);
    const strengths = (profile.recurring?.strengths || []).filter(x => x.discipline === discipline).slice(0, 3);
    const target = profile.preferences?.targetLevel?.[discipline] || profile.preferences?.targetLevel?.default || 'L4';
    replace(content, [
      el('p', { text: `Target: ${target}. This is your practice goal, not an assessment of your current ability.` }),
      el('p', { class: 'dim', text: `${practicedCount} practiced problem${practicedCount === 1 ? '' : 's'} in this track. ${assessments.length ? `${assessments.length} recent assessment${assessments.length === 1 ? ' informs' : 's inform'} the interviewer.` : 'No recorded assessments yet; the first mock will establish evidence.'}` }),
      rated ? el('p', { text: `Latest recorded model assessment: ${signalLabel(rated.signal, rated.reportDifficulty)}${rated.reportDifficulty === 'beginner' ? '' : ` against the ${reportDifficultyLabel(rated.reportDifficulty) || rated.targetLevel} bar`}.${rated.summary ? ' ' + rated.summary : ''}` }) : null,
      weaknesses.length ? el('p', { text: 'Recent areas to revisit: ' + weaknesses.map(x => x.name).join(', ') + '.' }) : null,
      strengths.length ? el('p', { text: 'Recent strengths: ' + strengths.map(x => x.name).join(', ') + '.' }) : null,
      el('p', { class: 'dim', text: 'New mocks use prior feedback and saved notes across problems. Each mock is graded on its own evidence.' }),
      ...(profile.warnings || []).map(text => el('p', { class: 'lld-notice', text })),
    ]);
  }).catch(error => { if (!disposed) replace(content, el('p', { role: 'status', text: error.message })); });
  return { root, dispose() { disposed = true; } };
}
