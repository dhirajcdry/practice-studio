import {el, replace} from './dom.js';
import {progressFor, summarizeProgress} from './catalog-progress.js';

// Composed ports and gutters keep paths out of the topic cards.
const POSITIONS = {
 'Arrays & Hashing':[140,100], 'Two Pointers':[400,100], 'Stack':[140,240],
 'Sliding Window':[660,52], 'Binary Search':[660,145], 'Linked List':[400,250],
 'Trees':[660,250], 'Tries':[930,250], 'Backtracking':[400,360],
 'Heap / Priority Queue':[660,360], 'Greedy':[930,360], 'Graphs':[140,460],
 '1-D Dynamic Programming':[400,460], 'Intervals':[930,460],
 'Advanced Graphs':[140,575], '2-D Dynamic Programming':[400,575],
 'Bit Manipulation':[660,575], 'Math & Geometry':[930,575],
};
const LINKS = [
 ['Arrays & Hashing','Two Pointers','M248 100H292'],
 ['Arrays & Hashing','Stack','M140 136V204'],
 ['Two Pointers','Sliding Window','M508 100C530 100 530 52 552 52'],
 ['Two Pointers','Binary Search','M508 100C530 100 530 145 552 145'],
 ['Two Pointers','Linked List','M400 136V214'],
 ['Binary Search','Trees','M660 181V214'],
 ['Trees','Tries','M768 250H822'],
 ['Trees','Heap / Priority Queue','M660 286V324'],
 ['Trees','Backtracking','M552 250H540Q530 250 530 260V350Q530 360 520 360H508'],
 ['Heap / Priority Queue','Greedy','M768 360H822'],
 ['Heap / Priority Queue','Intervals','M660 396V400Q660 410 670 410H780Q790 410 790 420V450Q790 460 800 460H822'],
 ['Backtracking','Graphs','M292 360C240 360 140 374 140 424'],
 ['Backtracking','1-D Dynamic Programming','M400 396V424'],
 ['Graphs','Advanced Graphs','M140 496V539'],
 ['1-D Dynamic Programming','2-D Dynamic Programming','M400 496V539'],
 ['1-D Dynamic Programming','Bit Manipulation','M508 460H650Q660 460 660 470V539'],
 ['Bit Manipulation','Math & Geometry','M768 575H822'],
 ['Linked List','Trees','M508 250H552',true],
 ['Graphs','2-D Dynamic Programming','M248 460H260Q270 460 270 470V565Q270 575 280 575H292',true],
];
function svg(tag,attrs={}) {const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);return node;}
function problemsFor(data,pattern,state) {const needle=state.query.trim().toLowerCase();return data.problems.filter(p=>p.pattern===pattern&&p.lists[state.list]&&(state.difficulty==='all'||p.difficulty===state.difficulty)&&(!needle||`${p.title} ${p.pattern} ${p.number}`.toLowerCase().includes(needle)));}
const statusIcon=status=>status==='accepted'?'✓':status==='local-pass'?'◐':status==='attempted'?'•':'○';

export function renderRoadmap(data,state,handlers) {
 const root=el('div',{class:'view catalog roadmap'});
 root.append(el('div',{class:'roadmap-head'},[
  el('div',{},[el('h1',{text:'Study roadmap'}),el('p',{text:'Find your next pattern. Follow the connections.'})]),
  el('div',{class:'roadmap-switch'},[el('button',{type:'button',class:'roadmap-mode',text:'Explorer',onclick:()=>handlers.onCatalogMode('explorer')}),el('button',{type:'button',class:'roadmap-mode active','aria-current':'page',text:'Roadmap'})]),
 ]));
 const chips=el('div',{class:'roadmap-chips'},[
  ...[['neetcode250','NeetCode 250'],['neetcode150','NeetCode 150'],['blind75','Blind 75']].map(([id,label])=>el('button',{type:'button',class:'chip','aria-pressed':String(state.list===id),text:label,onclick:()=>handlers.onList(id)})),
  el('label',{class:'roadmap-level'},['Level ',el('select',{'aria-label':'Problem difficulty',onchange:e=>handlers.onDifficulty(e.target.value)},['all','Easy','Medium','Hard'].map(level=>el('option',{value:level,selected:state.difficulty===level,text:level==='all'?'All levels':level})))]),
 ]);root.append(chips);
 if(state.query)root.append(el('p',{class:'roadmap-query'},[`Matching “${state.query}”`,el('button',{type:'button',text:'Clear filters',onclick:handlers.onClear})]));
 const graph=el('section',{class:'roadmap-graph-col','aria-label':'Study roadmap graph'});
 const percentage=el('button',{class:'graph-btn graph-pct',type:'button',title:'Reset to 100%'});
 const minus=el('button',{class:'graph-btn',type:'button','aria-label':'Zoom out',text:'−'});
 const plus=el('button',{class:'graph-btn',type:'button','aria-label':'Zoom in',text:'+'});
 const fitButton=el('button',{class:'graph-btn fit',type:'button',text:'Fit'});
 graph.append(el('div',{class:'roadmap-toolbar'},[el('span',{class:'graph-caption',text:`${data.patterns.length} patterns`}),el('div',{class:'graph-actions'},[minus,percentage,plus,fitButton])]));
 const viewport=el('div',{class:'roadmap-viewport',tabindex:'0','aria-label':'Pan the roadmap; use zoom controls to change its size'});
 const canvas=el('div',{class:'roadmap-canvas'});
 canvas.append(el('span',{class:'map-start',text:'Start here',style:'left:32px;top:37px'}));
 const lines=svg('svg',{class:'roadmap-lines',viewBox:'0 0 1100 650','aria-hidden':'true'});
 LINKS.forEach(([from,to,d,secondary])=>lines.append(svg('path',{d,class:'roadmap-edge'+(secondary?' secondary':''),'data-from':from,'data-to':to})));
 canvas.append(lines);
 let selected=state.roadmapSelection||null;
 let scale=state.roadmapTransform?.scale||1,tx=state.roadmapTransform?.tx||0,ty=state.roadmapTransform?.ty||0;
 function apply(){canvas.style.transform=`translate(${tx}px,${ty}px) scale(${scale})`;percentage.textContent=`${Math.round(scale*100)}%`;state.roadmapTransform={scale,tx,ty};}
 const nodes=new Map();
 for(const pattern of data.patterns){
  const [x,y]=POSITIONS[pattern];const items=problemsFor(data,pattern,state);const summary=summarizeProgress(items,state.progress);
  const progress=state.progress&&(summary.accepted?`${summary.accepted} accepted`:summary.localPass?`${summary.localPass} passed locally`:summary.attempted?`${summary.attempted} in progress`:'');
  const node=el('button',{class:'roadmap-node',type:'button',style:`--x:${x}px;--y:${y}px`,'aria-label':`${pattern}, ${items.length} matching problems`,'aria-pressed':'false',onclick:()=>select(pattern,true),onfocus:()=>{
   const r=viewport.getBoundingClientRect();if((x-108)*scale+tx<0||(x+108)*scale+tx>r.width||(y-36)*scale+ty<0||(y+36)*scale+ty>r.height){tx=r.width/2-x*scale;ty=r.height/2-y*scale;apply();}
  }},[el('span',{class:'node-title',text:pattern}),el('span',{class:'node-meta',text:items.length?`${items.length} problems`:'0 matching problems'}),progress?el('span',{class:'node-progress'+(summary.accepted?' has-progress':''),text:progress}):null]);
  nodes.set(pattern,node);canvas.append(node);
 }
 viewport.append(canvas);graph.append(viewport);root.append(graph);
 const panel=el('aside',{class:'roadmap-detail',hidden:true,'aria-label':'Selected pattern'});const announcement=el('span',{class:'map-announcement',role:'status'});root.append(panel,announcement);
 function select(pattern,reveal=false){selected=pattern;state.roadmapSelection=pattern;if(pattern)state.pattern=pattern;
  nodes.forEach((node,name)=>{node.classList.toggle('selected',name===pattern);node.setAttribute('aria-pressed',String(name===pattern));});
  const ancestors=new Set();let next=pattern;for(let i=0;i<18&&next;i++){const link=LINKS.find(([from,to,,secondary])=>to===next&&!secondary);if(!link)break;ancestors.add(`${link[0]}|${link[1]}`);next=link[0];}
  lines.querySelectorAll('path').forEach(path=>{const direct=path.dataset.from===pattern||path.dataset.to===pattern;path.classList.toggle('connected',direct||ancestors.has(`${path.dataset.from}|${path.dataset.to}`));});
  panel.hidden=!pattern;if(!pattern)return;
  const items=problemsFor(data,pattern,state);const summary=summarizeProgress(items,state.progress);
  replace(panel,[el('div',{class:'detail-heading'},[el('span',{class:'detail-kicker',text:'Your next session'}),el('h2',{text:pattern}),el('p',{class:'detail-summary',text:state.progress?`${items.length} problems · ${summary.accepted} accepted · ${summary.localPass} passed locally`:`${items.length} problems · Saved progress ${state.progressState==='loading'?'loading…':'unavailable'}`}),el('button',{type:'button',class:'detail-close','aria-label':'Close pattern inspector',text:'×',onclick:()=>select(null)})]),
   el('div',{class:'detail-list'},items.length?items.map(p=>{const record=progressFor(p.slug,state.progress);return el('button',{class:'detail-problem',type:'button',onclick:()=>handlers.onOpen(p.slug)},[el('span',{class:'status status-'+record.status,title:record.label,'aria-label':record.label,text:statusIcon(record.status)}),el('span',{class:'detail-title',text:p.title}),el('span',{class:'detail-diff '+p.difficulty.toLowerCase(),text:p.difficulty}),el('span',{class:'open-arrow',text:'↗'})]);}):el('p',{text:'No problems match the current filters.'})),
  ]);
  if(reveal){announcement.textContent=`${pattern}: ${items.length} problems. Problem inspector opened below the map.`;requestAnimationFrame(()=>panel.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches||document.body.classList.contains('motion-off')?'auto':'smooth'}));}
 }
 select(selected);apply();
 function fit(){const r=viewport.getBoundingClientRect();scale=Math.min(r.width/1100,r.height/650);tx=(r.width-1100*scale)/2;ty=(r.height-650*scale)/2;apply();}
 function zoom(newScale){const r=viewport.getBoundingClientRect();const x=(r.width/2-tx)/scale,y=(r.height/2-ty)/scale;scale=Math.max(.2,Math.min(1.8,newScale));tx=r.width/2-x*scale;ty=r.height/2-y*scale;apply();}
 minus.onclick=()=>zoom(scale-.1);plus.onclick=()=>zoom(scale+.1);fitButton.onclick=fit;percentage.onclick=()=>zoom(1);
 const savedSize=state.roadmapViewport;const observer=new ResizeObserver(()=>{if(!root.isConnected){observer.disconnect();return;}const r=viewport.getBoundingClientRect();if(savedSize?.width===r.width&&savedSize?.height===r.height){apply();return;}scale=Math.max(.9,Math.min(1,(r.width-24)/1100));tx=Math.max(12,(r.width-1100*scale)/2);ty=0;state.roadmapViewport={width:r.width,height:r.height};apply();});observer.observe(viewport);
 let drag=null;viewport.addEventListener('pointerdown',event=>{if(event.target.closest('.roadmap-node'))return;drag={x:event.clientX,y:event.clientY,tx,ty};viewport.setPointerCapture(event.pointerId);});viewport.addEventListener('pointermove',event=>{if(!drag)return;tx=drag.tx+event.clientX-drag.x;ty=drag.ty+event.clientY-drag.y;apply();});viewport.addEventListener('pointerup',()=>{drag=null;});viewport.addEventListener('pointercancel',()=>{drag=null;});
 return root;
}
