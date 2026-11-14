import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceLoop, presenceOf, watchPresence} from '../../web/js/voice-loop.js';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
 let state='idle',busy=false,error=false,starts=0,warmed=0,deny=false;
 const capture={start:async()=>{starts++;state=deny?'idle':'recording';},stop:()=>{if(state==='recording')state='working';},isBusy:()=>state!=='idle',hasTranscriptionError:()=>error};
 const speaker={speaking:false,prepare:async()=>{warmed++;}};
 const loop=createVoiceLoop({capture,speaker,canListen:()=>!busy});
 return {loop,speaker,set busy(v){busy=v;loop.sync();},set error(v){error=v;},set deny(v){deny=v;},get starts(){return starts},get warmed(){return warmed},get state(){return state},settle(){state='idle';loop.sync();}};
}
test('voice joins once and keeps the same microphone throughout playback',async()=>{
 const h=fixture();h.loop.start();await tick();assert.equal(h.state,'recording');assert.equal(h.warmed,1);
 h.speaker.speaking=true;h.loop.sync();await tick();assert.equal(h.state,'recording');assert.equal(h.starts,1);
 h.speaker.speaking=false;h.loop.sync();await tick();assert.equal(h.starts,1);assert.equal(h.state,'recording');
 h.busy=true;await tick();assert.equal(h.state,'working');h.settle();await tick();assert.equal(h.starts,1);
 h.speaker.speaking=true;h.busy=false;await tick();assert.equal(h.starts,2);assert.equal(h.state,'recording');
 h.loop.dispose();
});
test('explicit pause and disposal prevent automatic reopening',async()=>{
 const h=fixture();h.loop.start();await tick();h.loop.pause();h.settle();await tick();assert.equal(h.starts,1);assert.equal(h.loop.enabled,false);
 h.loop.start();await tick();assert.equal(h.starts,2);h.loop.dispose();h.settle();await tick();assert.equal(h.starts,2);
});
test('permission failure and untranscribed audio never cause retry loops',async()=>{
 const h=fixture();h.deny=true;h.loop.start();await tick();assert.equal(h.loop.enabled,false);h.loop.sync();await tick();assert.equal(h.starts,1);
 h.deny=false;h.error=true;h.loop.start();await tick();assert.equal(h.starts,1);
 h.error=false;h.loop.sync();await tick();assert.equal(h.starts,2);h.loop.dispose();
});
test('microphone is released if permission resolves after leaving voice mode',async()=>{
 let release,state='idle',stops=0;
 const capture={start:async()=>{state='opening';await new Promise(r=>release=r);state='recording';},stop:()=>{stops++;state='idle'},isBusy:()=>state!=='idle',hasTranscriptionError:()=>false};
 const loop=createVoiceLoop({capture,speaker:{speaking:false}});loop.start();await tick();loop.pause();release();await tick();assert.equal(state,'idle');assert.ok(stops>=2);loop.dispose();
});

// Presence: the one rule (page visible AND window focused) every voice surface shares.
function page({ hidden = false, focused = true } = {}) {
 const win = new EventTarget(), doc = new EventTarget();
 Object.assign(doc, { get hidden() { return hidden; }, get visibilityState() { return hidden ? 'hidden' : 'visible'; }, hasFocus: () => focused });
 return { win, doc, blur() { focused = false; win.dispatchEvent(new Event('blur')); }, focus() { focused = true; win.dispatchEvent(new Event('focus')); },
  hide() { hidden = true; focused = false; doc.dispatchEvent(new Event('visibilitychange')); win.dispatchEvent(new Event('blur')); },
  show() { hidden = false; focused = true; doc.dispatchEvent(new Event('visibilitychange')); win.dispatchEvent(new Event('focus')); },
  frameBlur() { win.dispatchEvent(new Event('blur')); } };
}
const later=()=>new Promise(r=>setTimeout(r,5));
test('presence is visible AND focused, never either alone', () => {
 assert.equal(presenceOf(page().doc).present, true);
 assert.deepEqual(presenceOf(page({ focused: false }).doc), { present: false, reason: 'blurred' });
 assert.deepEqual(presenceOf(page({ hidden: true }).doc), { present: false, reason: 'hidden' });
});
test('watchPresence reports leaving at once and returning after focus settles', async () => {
 const p = page(), seen = [];
 const w = watchPresence(v => seen.push(v), p);
 p.blur(); assert.deepEqual(seen, [false], 'blur releases synchronously');
 p.focus(); await later(); assert.deepEqual(seen, [false, true]);
 p.hide(); await later(); p.show(); await later(); assert.deepEqual(seen, [false, true, false, true]);
 // Focus moving into a frame of this page fires blur but the page keeps focus.
 p.frameBlur(); await later(); assert.deepEqual(seen, [false, true, false, true]);
 p.win.dispatchEvent(new Event('pagehide')); assert.equal(seen.at(-1), false, 'unloading counts as away');
 p.win.dispatchEvent(new Event('pageshow')); assert.equal(seen.at(-1), true);
 w.dispose(); p.blur(); await later(); assert.equal(seen.length, 6, 'disposed watchers stay quiet');
});
// A capture that follows voice.js: defers start while away, resumes through onReturn.
function awayCapture(p) {
 let state = 'idle', held = false, starts = 0, live = 0, onReturn = () => {};
 const capture = {
  start: async () => { if (!presenceOf(p.doc).present) { held = true; return; } held = false; starts++; live++; state = 'recording'; },
  stop: () => { held = false; if (state === 'recording') { live--; state = 'idle'; } },
  isBusy: () => state !== 'idle', hasTranscriptionError: () => false, awaitingReturn: () => held,
 };
 const presence = watchPresence(present => {
  if (!present && state === 'recording') { capture.stop(); held = true; }
  else if (present && held) { held = false; onReturn(); }
 }, p);
 return { capture, presence, set onReturn(fn) { onReturn = fn; }, get starts() { return starts; }, get live() { return live; }, get state() { return state; } };
}
test('away is not a failure: the loop stays enabled, says away, and resumes on return', async () => {
 const p = page(), c = awayCapture(p);
 const loop = createVoiceLoop({ capture: c.capture, speaker: { speaking: false } });
 c.onReturn = () => loop.sync();
 loop.start(); await tick(); assert.equal(c.state, 'recording'); assert.equal(loop.away, false);
 for (let i = 0; i < 5; i++) {
  p.blur(); assert.equal(c.live, 0, 'leaving releases the microphone'); assert.equal(loop.away, true);
  loop.sync(); await tick(); assert.equal(c.live, 0, 'nothing reacquires while away'); assert.equal(loop.enabled, true);
  p.focus(); await later(); await tick(); assert.equal(c.live, 1, 'returning resumes with no click'); assert.equal(loop.away, false);
 }
 assert.equal(c.starts, 6); assert.equal(c.live, 1, 'five away/return cycles leave exactly one live stream');
 p.hide(); assert.equal(c.live, 0); loop.pause(); p.show(); await later(); await tick();
 assert.equal(c.live, 0, 'an explicit pause while away is not undone by returning');
 loop.dispose(); c.presence.dispose();
});
test('a loop started while away waits instead of disabling itself', async () => {
 const p = page({ focused: false }), c = awayCapture(p);
 const loop = createVoiceLoop({ capture: c.capture, speaker: { speaking: false } });
 c.onReturn = () => loop.sync();
 loop.start(); await tick(); assert.equal(loop.enabled, true); assert.equal(loop.away, true); assert.equal(c.starts, 0);
 p.focus(); await later(); await tick(); assert.equal(c.state, 'recording');
 loop.dispose(); c.presence.dispose();
});
