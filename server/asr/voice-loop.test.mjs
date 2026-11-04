import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceLoop} from '../../web/js/voice-loop.js';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
 let state='idle',busy=false,error=false,starts=0,warmed=0,deny=false;
 const capture={start:async()=>{starts++;state=deny?'idle':'recording';},stop:()=>{if(state==='recording')state='working';},isBusy:()=>state!=='idle',hasTranscriptionError:()=>error};
 const speaker={speaking:false,prepare:async()=>{warmed++;}};
 const loop=createVoiceLoop({capture,speaker,canListen:()=>!busy});
 return {loop,speaker,set busy(v){busy=v;loop.sync();},set error(v){error=v;},set deny(v){deny=v;},get starts(){return starts},get warmed(){return warmed},get state(){return state},settle(){state='idle';loop.sync();}};
}
test('voice joins once, waits for reply and audio, then listens again without another gesture',async()=>{
 const h=fixture();h.loop.start();await tick();assert.equal(h.state,'recording');assert.equal(h.warmed,1);
 h.busy=true;await tick();assert.equal(h.state,'working');h.settle();await tick();assert.equal(h.starts,1);
 h.speaker.speaking=true;h.busy=false;await tick();assert.equal(h.starts,1);
 h.speaker.speaking=false;h.loop.sync();await tick();assert.equal(h.starts,2);assert.equal(h.state,'recording');
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
