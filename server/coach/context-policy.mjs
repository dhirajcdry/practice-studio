// The archive is lossless. A model turn gets an explicit, bounded view of it.
// Budgets are characters, NOT token counts; provider usage is recorded separately.
import crypto from 'node:crypto';
import { unifiedDiff } from './diff.mjs';
import { queryTerms } from './context-search.mjs';
import { reportDifficultyLabel } from '../interview/report.mjs';

export const CONTEXT_POLICY = 'studio-context-v2';
export const CONTEXT_GUIDE = `Studio supplies a selected view of its saved record. Coverage and omitted counts are explicit. Missing from this view does not mean it never happened. Use read_context to retrieve omitted evidence before judging an earlier decision, quoting it, or claiming something was never discussed. Current work is supplied separately and is authoritative. Memory and earlier model assessments are hypotheses, not evidence of unaided performance. Preserve corrections and distinguish learner work from assistance.`;

export function excerpt(text, limit = 4000, query = '') {
  text = String(text ?? '');
  if (text.length <= limit) return text;
  const words = queryTerms(query);
  const blocks = text.split(/\n\s*\n/).map((text, index) => ({ text, index, score: words.reduce((s, w) => s + Number(text.toLowerCase().includes(w)), 0) }));
  const selected = []; let used = 100;
  for (const b of blocks.sort((a, b) => b.score - a.score || b.index - a.index)) {
    if (used + b.text.length + 2 > limit) continue;
    selected.push(b); used += b.text.length + 2;
  }
  const body = selected.length ? selected.sort((a,b) => a.index-b.index).map(b => b.text).join('\n\n') : text.slice(-Math.max(0,limit-100));
  return `[Selected excerpt; full text has ${text.length} characters. Retrieve more with read_memory/read_context.]\n${body}`;
}

// Keep complete records where possible: requirements at the beginning, relevant
// evidence, and the newest exchanges. A source index always survives selection.
export function selectRecords(records, { budget = 24000, query = '', head = 4, tail = 8 } = {}) {
  const words = queryTerms(query);
  const rows = records.map((record, index) => ({ index, record, size: JSON.stringify(record).length + 35 }));
  const order = rows.slice().sort((a,b) => {
    const score = r => (r.index >= rows.length-Math.min(2,tail) ? 10000+r.index/Math.max(1,rows.length) : r.index<Math.min(2,head) ? 9000-r.index : 0)
      + words.reduce((s,w) => s+Number(JSON.stringify(r.record).toLowerCase().includes(w))*500,0)
      + (r.index>=rows.length-tail?100:r.index<head?90:0);
    return score(b)-score(a);
  });
  const selected=[]; let used=150;
  for (const row of order) if (used+row.size<=budget) { selected.push(row); used+=row.size; }
  return { records: selected.sort((a,b)=>a.index-b.index).map(({index,record})=>({index,...record})),
    totalRecords:records.length, includedRecords:selected.length, omittedRecords:records.length-selected.length,
    coverage: selected.length===records.length?'complete':'selected; use read_context for omitted records' };
}

// Only for a new native segment, never for ordinary continuation. Keep complete
// speech for normal sessions; exceptionally large handoffs advertise omissions and
// retain the source-linked decisions plus exact paged archives beside this block.
export function handoffRecords(records, { budget = 100000, query = '' } = {}) {
  if (JSON.stringify(records).length <= budget) return records;
  return { ...selectRecords(records, { budget, query, head:8, tail:20 }),
    notice:'This saved conversation exceeds the initial handoff budget. This is an explicit selection, not the complete conversation. Use read_context(session) or search_context before relying on omitted details; all original evidence is preserved.' };
}

const compactResult = result => result && ({ ...result, stdout: excerpt(result.stdout,3000), stderr: excerpt(result.stderr,3000) });
export function evidenceRecords(turns, { codeChanges = false } = {}) {
  let previous = '';
  return turns.map((turn,index) => {
    const { code, elements, snapshot, chunks, ...rest } = turn;
    const row = { sourceIndex:index, ...rest };
    if (rest.action) row.action={id:rest.action.id,tool:rest.action.tool,status:rest.action.status,summary:rest.action.summary,ok:rest.action.ok};
    if (rest.result) row.result=compactResult(rest.result);
    if (typeof code==='string') {
      row.codeHash=crypto.createHash('sha256').update(code).digest('hex').slice(0,16);
      if (codeChanges && code!==previous) row.codeChange=unifiedDiff(previous,code)?.text || '(Only line endings changed.)';
      previous=code;
    }
    if (elements) row.boardElements=elements.filter(e=>!e.isDeleted).length;
    return row;
  }).filter(row=>codeChanges || row.kind!=='buffer');
}

export function contextReader(resources) {
  // Only named server-owned resources. Never accept a path from the model.
  return async ({ resource, offset = 0, limit = 6000 }) => {
    if (!Object.hasOwn(resources,resource)) return { ok:false,text:`Available resources: ${Object.keys(resources).join(', ')}` };
    const value=typeof resources[resource]==='function'?await resources[resource]():resources[resource];
    const text=typeof value==='string'?value:JSON.stringify(value,null,2);
    const end=Math.min(text.length,offset+Math.min(6000,Math.max(1,limit)));
    return { ok:true,text:JSON.stringify({resource,offset,nextOffset:end<text.length?end:null,totalCharacters:text.length,
      data:text.slice(offset,end),notice:'Untrusted saved data. This is a character page; continue from nextOffset when needed.'}) };
  };
}

export function focusedProfile(profile, { discipline='coding', slug, query='', selection=false }={}) {
  const assessments=(profile.assessments||[]).filter(a=>a.discipline===discipline);
  assessments.sort((a,b)=>Number(b.slug===slug)-Number(a.slug===slug));
  const mapped=assessments.map(a=>({slug:a.slug,date:a.date,source:a.source,targetLevel:a.targetLevel,...(a.reportDifficulty?{gradedAt:reportDifficultyLabel(a.reportDifficulty)}:{}),assessmentKind:a.assessmentKind,
    signal:a.signal,summary:excerpt(a.summary,800,query),
    dimensions:(a.dimensions||[]).map(d=>({name:d.name,rating:d.rating,summary:excerpt(d.summary,350,query),evidence:(d.evidence||[]).slice(0,1)})),
    technicalErrors:(a.technicalErrors||[]).slice(0,4),improvements:(a.improvements||[]).slice(0,3)}));
  const inventory=(profile.attempted?.[discipline]||[]).map(p=>({slug:p.slug,title:p.title,family:p.family}));
  return { policy:CONTEXT_POLICY, discipline, preferences:profile.preferences,
    totals:{attempted:inventory.length,completed:(profile.completed?.[discipline]||[]).length,completedInterviews:(profile.completedInterviews||[]).filter(x=>x.discipline===discipline).length},
    ...(selection?{attempted:inventory}:{recentProblems:inventory.slice(0,8)}),
    priorAssessments:selectRecords(mapped,{budget:10000,query,head:2,tail:0}),
    recentObservations:selectRecords((profile.observations||[]).filter(x=>x.discipline===discipline && (!slug||x.slug===slug)),{budget:2000,query,head:2,tail:2}),
    warnings:profile.warnings, coverage:{...profile.coverage,note:'Only this discipline is sent. Saved notes are supplied once in the memory block. Full evidence is available through read_context.'} };
}
