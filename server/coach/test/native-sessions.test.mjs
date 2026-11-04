import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beginConversation, conversationDir, archiveIdleConversations, readInterruptedProgress, IDLE_SESSION_MS } from '../native-sessions.mjs';
import { runProviderTurn } from '../provider.mjs';

const choice = { provider: 'claude', model: 'opus' };
const binary = new URL('./bin/fake-claude.mjs', import.meta.url).pathname;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const code = Array.from({ length: 200 }, (_, i) => `line_${i} = ${i}`).join('\n');
  const conversation = { key: 'practice:lld-locker:one', requestId: 'r1', bootstrapPrompt: 'FULL SAVED CONVERSATION\n' + code,
    message: 'Why?', context: [['Problem', 'Lockers'], ['Workspace', { code }], ['Mode', 'voice']] };
  const options = { root, conversation, choice, systemPrompt: 'Coach role', toolSpecs: [{ name: 'get_state' }] };
  const state = async () => JSON.parse(await fs.readFile(path.join(conversationDir(root, conversation.key), 'state.json'), 'utf8'));
  return { root, conversation, options, state };
}

test('native identity survives independent turns; only acknowledged changes are sent', async t => {
  const f = await fixture(t), first = await beginConversation(f.options);
  assert.equal(first.prompt, f.conversation.bootstrapPrompt);
  await first.nativeId('native-one'); await first.complete();
  const next = { ...f.conversation, requestId: 'r2', message: 'And now?', context: [['Problem', 'Lockers'], ['Workspace', { code: f.conversation.context[1][1].code.replace('line_80 = 80', 'line_80 = 81') }], ['Mode', 'typed']] };
  const second = await beginConversation({ ...f.options, conversation: next });
  assert.equal(second.resumeSessionId, 'native-one'); assert.equal(second.metadata.resumed, true);
  assert.doesNotMatch(second.prompt, /FULL SAVED CONVERSATION/); assert.match(second.prompt, /And now\?/);
  assert.match(second.prompt, /codeChange/); assert.match(second.prompt, /line_80 = 81/);
  assert.doesNotMatch(second.prompt, /line_150/); assert.match(second.prompt, /typed/);
  await second.complete(); assert.equal((await f.state()).revision, 2);
});

test('provider switches including A to B to A create separate segments with full handoff', async t => {
  const f = await fixture(t);
  for (const [index, provider] of ['claude', 'codex', 'claude'].entries()) {
    const turn = await beginConversation({ ...f.options, choice: { provider, model: provider === 'claude' ? 'opus' : 'gpt-6-astra' } });
    assert.equal(turn.resumeSessionId, null); assert.equal(turn.prompt, f.conversation.bootstrapPrompt);
    await turn.nativeId(`native-${index}`); await turn.complete();
  }
  assert.deepEqual((await f.state()).segments.map(s => s.nativeId), ['native-0', 'native-1', 'native-2']);
});

test('failure retires uncertainty, prevents concurrent turn, and never advances the baseline', async t => {
  const f = await fixture(t), first = await beginConversation(f.options);
  await first.nativeId('uncertain');
  await assert.rejects(beginConversation(f.options), /already running/);
  first.token('Partial response'); await first.fail();
  assert.equal((await f.state()).revision, 0);
  const next = await beginConversation(f.options);
  assert.equal(next.resumeSessionId, null); assert.equal(next.metadata.reason, 'interrupted-or-failed');
  await next.stop();
  const dir = path.join(conversationDir(f.root, f.conversation.key), 'turns');
  const turns = await Promise.all((await fs.readdir(dir)).map(async n => JSON.parse(await fs.readFile(path.join(dir, n)))));
  assert.ok(turns.some(t => t.status === 'failed' && t.answer === 'Partial response'));
});

test('compaction resends complete current state once while preserving native identity', async t => {
  const f = await fixture(t), first = await beginConversation(f.options);
  await first.nativeId('same'); first.compaction({ trigger: 'auto' }); await first.complete();
  const second = await beginConversation(f.options);
  assert.equal(second.resumeSessionId, 'same'); assert.equal(second.metadata.resync, true);
  assert.match(second.prompt, /line_150/); assert.doesNotMatch(second.prompt, /FULL SAVED CONVERSATION/);
  await second.complete();
  const third = await beginConversation(f.options);
  assert.equal(third.metadata.resync, false); assert.doesNotMatch(third.prompt, /line_150/); await third.complete();
});

test('three-day expiry archives idle metadata, keeps evidence, and skips a live lease', async t => {
  const f = await fixture(t), first = await beginConversation(f.options);
  await first.nativeId('old'); first.token('Saved answer'); await first.complete();
  const future = Date.now() + IDLE_SESSION_MS + 100;
  assert.equal(await archiveIdleConversations(f.root, future), 1);
  const second = await beginConversation({ ...f.options, now: future });
  assert.equal(second.metadata.reason, 'idle'); assert.equal(second.resumeSessionId, null);
  assert.equal(await archiveIdleConversations(f.root, future + IDLE_SESSION_MS + 100), 0);
  await second.stop(); assert.equal((await f.state()).segments.length, 2);
});

test('role/tool schema change makes explicit fresh handoff; model choice alone retains history', async t => {
  const f = await fixture(t), first = await beginConversation(f.options);
  await first.nativeId('same'); await first.complete();
  const second = await beginConversation({ ...f.options, choice: { ...choice, model: 'sonnet' } });
  assert.equal(second.resumeSessionId, 'same'); await second.complete();
  const third = await beginConversation({ ...f.options, toolSpecs: [] });
  assert.equal(third.metadata.reason, 'instructions-or-tools-changed'); assert.equal(third.resumeSessionId, null); await third.stop();
});

test('partial progress is durable before provider completion', async t => {
  const f = await fixture(t), turn = await beginConversation(f.options);
  await turn.nativeId('live'); turn.turnId('turn-1'); turn.token('First sentence.');
  await new Promise(resolve => setTimeout(resolve, 350));
  const file = path.join(conversationDir(f.root, f.conversation.key), 'turns', `${turn.metadata.attemptId}.json`);
  const progress = JSON.parse(await fs.readFile(file));
  assert.equal(progress.answer, 'First sentence.'); assert.equal(progress.status, 'running'); assert.equal(progress.nativeTurnId, 'turn-1');
  await turn.stop(); assert.equal(JSON.parse(await fs.readFile(file)).status, 'interrupted');
});

test('provider integration resumes real native ID and awaits the Studio commit before acknowledgement', async t => {
  const f = await fixture(t), argsFile = path.join(f.root, 'args.json'), promptFile = path.join(f.root, 'prompt.txt');
  const env = { ...process.env, FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_ARGS_FILE: argsFile, FAKE_CLAUDE_PROMPT_FILE: promptFile };
  let unlock, committing;
  const entered = new Promise(resolve => { committing = resolve; });
  const commit = new Promise(resolve => { unlock = resolve; });
  let output = '', error;
  const run = runProviderTurn({ ...f.options, binary, env, tools: '', onToken: t => { output += t; }, onError: e => { error = e; },
    onDone: async (_id,_reason,ack) => { committing(); await commit; await ack(); } });
  await entered;
  assert.ok(output); assert.equal((await f.state()).segments.at(-1).status, 'running');
  unlock(); await run.exited; assert.equal(error, undefined);
  const native = (await f.state()).segments.at(-1).nativeId;
  const second = runProviderTurn({ ...f.options, binary, env, tools: '', onDone:(_id,_reason,ack)=>ack(), onError: e => { error = e; } });
  await second.exited;
  const args = JSON.parse(await fs.readFile(argsFile));
  assert.equal(args[args.indexOf('--resume') + 1], native);
  assert.doesNotMatch(await fs.readFile(promptFile, 'utf8'), /FULL SAVED CONVERSATION/);
  assert.equal(error, undefined); assert.equal((await f.state()).revision, 2);
});

test('failure to save authoritative reply does not acknowledge native history', async t => {
  const f = await fixture(t); let message;
  const run = runProviderTurn({ ...f.options, binary, tools: '', env: { ...process.env, FAKE_CLAUDE_MODE: 'ok' },
    onDone: async () => { throw Error('disk full'); }, onError: e => { message = e; } });
  await run.exited; assert.match(message, /disk full/);
  assert.equal((await f.state()).revision, 0); assert.equal((await f.state()).segments.at(-1).status, 'failed');
});

test('a rejected reply cannot advance the baseline by withholding the commit callback',async t=>{
  const f=await fixture(t);let error;
  const run=runProviderTurn({...f.options,binary,tools:'',env:{...process.env,FAKE_CLAUDE_MODE:'ok'},onDone:()=>{},onError:e=>{error=e;}});
  await run.exited;
  assert.match(error,/not acknowledged/);assert.equal((await f.state()).revision,0);assert.equal((await f.state()).segments.at(-1).status,'failed');
});

test('restart handoff recovers durable partial output as unconfirmed evidence, not candidate speech',async t=>{
  const f=await fixture(t),turn=await beginConversation(f.options);
  await turn.nativeId('dead-process');turn.token('Incomplete reasoning that was displayed');await turn.stop();
  const dir=conversationDir(f.root,f.conversation.key),state=await f.state();
  state.segments.at(-1).status='running';state.currentTurn.status='running';
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state));
  const file=path.join(dir,'turns',`${turn.metadata.attemptId}.json`),progress=JSON.parse(await fs.readFile(file));
  progress.status='running';await fs.writeFile(file,JSON.stringify(progress));
  const next=await beginConversation(f.options);
  assert.equal(next.resumeSessionId,null);assert.equal(next.metadata.recoveredAttempts,1);
  assert.match(next.prompt,/Incomplete reasoning that was displayed/);assert.match(next.prompt,/Unconfirmed partial provider output/);
  const recovered=await readInterruptedProgress(f.root,f.conversation.key);
  assert.equal(recovered.length,1);assert.equal(recovered[0].requestId,'r1');assert.equal(recovered[0].status,'interrupted');
  await next.stop();
});
