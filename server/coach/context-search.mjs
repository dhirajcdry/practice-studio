import crypto from 'node:crypto';

const GROUPS = [
  ['concurrency','concurrent','race','atomic','lock','thread','parallel','synchronization'],
  ['overlap','interval','booking','schedule','meeting','reservation'],
  ['ownership','owner','state','invariant','responsibility','transition'],
  ['complexity','big-o','bigo','runtime','space','performance'],
];
const STOP = new Set('a an and are as at be been but by can could did do does for from had has have how i if in into is it me my of on or our should so that the their them there these they this to was we were what when where which who why will with would you your'.split(' '));
const hash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0,24);
const words = value => [...new Set((String(value ?? '').toLowerCase().match(/[a-z0-9_]+(?:-[a-z0-9_]+)*/g)||[]).filter(t=>t.length>2 && !STOP.has(t)).map(t=>t.endsWith('s')&&t.length>4?t.slice(0,-1):t))];
export function queryTerms(query) {
  const terms=new Set(words(query));
  for(const group of GROUPS)if(group.some(t=>terms.has(t)))group.forEach(t=>terms.add(t));
  return [...terms];
}

// Rebuildable local inverted index. No embedding/model call, no network, no source mutation.
export function createEvidenceIndex({discipline,slug,profile={},records=[],notes=[]}={}) {
  const entries=[],postings=new Map(),byResource=new Map();
  function add(item,kind) {
    if(!item)return;
    const d=item.discipline || item.track || discipline;
    if(d!==discipline)return;
    const text=typeof item==='string'?item:typeof item.text==='string'?item.text:JSON.stringify(item);
    if(!text?.trim())return;
    const sourceId=String(item.sourceId || `${kind}:${hash(JSON.stringify([item.source,item.id,item.date,text]))}`);
    const entry={sourceId,actor:item.actor || null,kind,discipline:d,slug:item.slug || (kind==='memory'?null:slug),
      provenance:item.provenance || item.source || null,text,resource:`evidence:${hash(JSON.stringify([d,sourceId,text]))}`};
    if(byResource.has(entry.resource))return;
    const id=entries.length;entries.push(entry);byResource.set(entry.resource,entry);
    for(const term of words(`${text} ${entry.slug || ''}`)) {
      if(!postings.has(term))postings.set(term,new Set());postings.get(term).add(id);
    }
  }
  records.forEach(item=>add(item,item.kind || 'record'));
  (profile.assessments || []).forEach(item=>add({...item,provenance:{kind:'model assessment',source:item.source,date:item.date}},'assessment'));
  (profile.observations || []).forEach(item=>add({...item,provenance:{kind:'recorded event',source:item.source,date:item.date}},'observation'));
  notes.forEach(item=>add({...item,provenance:{kind:'saved memory; interpretation',scope:item.scope,source:item.source}},'memory'));
  return {
    search({query='',limit=5}={}) {
      const wanted=queryTerms(query),scores=new Map();
      for(const term of wanted)for(const id of postings.get(term)||[])scores.set(id,(scores.get(id)||0)+1+Math.log(1+entries.length/(postings.get(term).size||1)));
      const ranked=[...scores].map(([id,score])=>({entry:entries[id],score:score+(entries[id].slug===slug?.toString()?1:0),id})).sort((a,b)=>b.score-a.score || a.id-b.id);
      const result={query:String(query).slice(0,1000),total:ranked.length,results:[],notice:'Exact source excerpts. Assessments and memory are interpretations; retrieve supporting evidence before judging performance.'};
      for(const {entry,score} of ranked.slice(0,Math.min(8,Math.max(1,limit)))) {
        const lower=entry.text.toLowerCase(),positions=wanted.map(t=>lower.indexOf(t)).filter(n=>n>=0),start=Math.max(0,(positions.length?Math.min(...positions):0)-100);
        const hit={resource:entry.resource,sourceId:entry.sourceId,actor:entry.actor,kind:entry.kind,slug:entry.slug,provenance:entry.provenance,
          score:Math.round(score*100)/100,excerpt:entry.text.slice(start,start+500),excerptOffset:start,totalCharacters:entry.text.length};
        result.results.push(hit);
        if(JSON.stringify(result).length>5000){result.results.pop();break;}
      }
      return result;
    },
    read(resource){return byResource.get(resource)?.text ?? null;},
  };
}
