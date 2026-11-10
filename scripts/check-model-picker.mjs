import assert from 'node:assert/strict';

// Runs inside the composer's disposable browser; both preference routes are mocked.
export async function checkModelPicker(evaluate, until) {
  await evaluate(`
    window.pickerOriginalFetch = window.fetch;
    window.pickerModelHits = 0;
    window.pickerSaved = {provider:'codex',model:'astra',reasoningEffort:'low'};
    window.pickerWrites = [];
    window.fetch = async (url, options = {}) => {
      if (String(url).includes('/api/coach/models')) { window.pickerModelHits++; return new Response(JSON.stringify({selected:window.pickerSaved,providers:[
        {id:'codex',label:'Codex',models:[{id:'astra',label:'Astra fixture',reasoningEfforts:['low','high','max']},{id:'small',label:'Small fixture',reasoningEfforts:['low']}]},
        {id:'claude',label:'Claude',models:[{id:'default',label:'Claude fixture'}]}
      ]}),{headers:{'content-type':'application/json'}}); }
      if (String(url).includes('/api/coach/model')) {
        if (window.pickerFail) { window.pickerFail=false; return new Response(JSON.stringify({error:{message:'Fixture save failed'}}),{status:500}); }
        window.pickerSaved=JSON.parse(options.body);window.pickerWrites.push(window.pickerSaved);
        return new Response(JSON.stringify({selected:window.pickerSaved}));
      }
      return window.pickerOriginalFetch(url,options);
    };
    const {createCoachModelPicker}=await import('/js/coach-model.js?picker-fixture=1');
    window.pickerFixture=document.createElement('div');window.pickerFixture.style.cssText='position:fixed;top:20px;left:8px;width:350px;z-index:99999;background:var(--card);padding:8px';
    window.pickerA=createCoachModelPicker({compact:true});window.pickerB=createCoachModelPicker();
    window.pickerFixture.append(window.pickerA.root,window.pickerB.root);document.body.append(window.pickerFixture);
  `);
  const ready = expected => until(() => evaluate(`return (window.pickerSaved.reasoningEffort||'')===${JSON.stringify(expected)} && !window.pickerA.root.querySelector('.coach-model-select').disabled && !window.pickerA.root.querySelector('.coach-model-select button').textContent.includes('Loading')`), 'picker saved selection');
  const menuItem = text => ` [...document.querySelectorAll('[role="menu"]:not([hidden]) .ui-menu-item')].find(n=>n.querySelector('.ui-menu-label')?.textContent.includes(${JSON.stringify(text)}))`;
  const openModel = () => evaluate(`window.pickerA.root.querySelector('.coach-model-select button').click();await new Promise(r=>setTimeout(r,20));`);
  const chooseModel = text => evaluate(`const item=${menuItem(text)}; if(!item)throw Error('Missing model ${text}; model fetch hits='+window.pickerModelHits+' labels='+[...document.querySelectorAll('.ui-menu-item .ui-menu-label')].map(n=>n.textContent).join('|')); item.click();`);
  const chooseEffort = text => evaluate(`const item=${menuItem(text)}; if(!item)throw Error('Missing effort ${text}'); item.click();`);
  try {
    await ready('low');
    // Keyboard selection uses the actual nested menu and commits only at the level screen.
    await openModel(); await chooseModel('Astra fixture');
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));document.activeElement.click();`);
    await ready('max');
    assert.equal(await evaluate(`return window.pickerB.root.querySelector('.coach-model-select button').textContent.includes('Max')`), true);
    const beforeSwitch = await evaluate(`return window.pickerWrites.length`);
    await openModel(); await chooseModel('Small fixture');
    assert.equal(await evaluate(`return window.pickerWrites.length`), beforeSwitch);
    await chooseEffort('Model default'); await ready('');
    assert.deepEqual(await evaluate(`return window.pickerSaved`), {provider:'codex',model:'small'});
    await openModel(); await chooseModel('Claude fixture'); await ready('');
    await openModel(); await chooseModel('Astra fixture'); await chooseEffort('High'); await ready('high');
    const writesBeforeCancel = await evaluate(`return window.pickerWrites.length`);
    await openModel(); await chooseModel('Small fixture'); await chooseEffort('Back to models');
    assert.equal(await evaluate(`return window.pickerWrites.length`), writesBeforeCancel);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
    await openModel(); await chooseModel('Astra fixture'); await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
    assert.equal(await evaluate(`return window.pickerWrites.length`), writesBeforeCancel);
    await evaluate(`window.pickerFail=true`); await openModel(); await chooseModel('Astra fixture'); await chooseEffort('Max'); await until(() => evaluate(`return !window.pickerA.root.querySelector('.coach-model-select').disabled`), 'failed save rollback');
    assert.match(await evaluate(`return window.pickerA.root.querySelector('[role=status]').textContent`), /save failed/);
    assert.match(await evaluate(`return window.pickerA.root.querySelector('.coach-model-select button').textContent`), /High/);
    await evaluate(`window.pickerA.dispose();window.pickerA.root.remove();const m=await import('/js/coach-model.js?picker-fixture=1');window.pickerA=m.createCoachModelPicker({compact:true});window.pickerFixture.append(window.pickerA.root);`);
    await ready('high');
    await openModel(); await chooseModel('Astra fixture'); await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));`);
    assert.match(await evaluate(`return document.activeElement.textContent`), /^Model default/);
    assert.equal(await evaluate(`return document.activeElement.disabled`), false);
    await evaluate(`document.activeElement.click()`); await ready('');
    assert.equal(await evaluate(`return 'reasoningEffort' in window.pickerSaved`), false);
    assert.equal(await evaluate(`return [...window.pickerFixture.querySelectorAll('button')].filter(b=>b.getClientRects().length).every(b=>b.getBoundingClientRect().right<=innerWidth)`), true);
    console.log('ok — model/effort selection, keyboard, synced controls, persistence, reset, provider switch and failed-save rollback');
  } finally {
    await evaluate(`window.pickerA.dispose();window.pickerB.dispose();window.pickerFixture.remove();window.fetch=window.pickerOriginalFetch;`);
  }
}
