import crypto from 'node:crypto';
import { TOOL_SPECS, createToolSession } from './tools.mjs';
import { serviceFor, writeMcpConfig } from './routes.mjs';

export { MEMORY_SCOPES, memoryFile, readAgentMemory } from './memory.mjs';

export const INTERVIEW_POLICY = 'Hands-off interview by default. Read current state before acting. Do not volunteer hints or solutions during the mock. When asked to edit, improve, or take control, use the appropriate Studio tools. Distinguish observed evidence from coached suggestions; write memory only from observed or tested facts, preserving uncertainty. Never claim a change without a successful tool result.';

// A live mock is judged on what happens in it, so its interviewer has no past record.
export const LIVE_MOCK_POLICY = 'Hands-off interview by default. Read current state before acting. Do not volunteer solutions during the mock. When asked to edit, improve, or take control, use the appropriate Studio tools. You have no record of the candidate\'s past work: judge only what happens in this interview. Lessons are saved at the debrief. Never claim a change without a successful tool result.';
const PAST_RECORD_TOOLS = ['get_submissions', 'save_note', 'read_memory', 'update_memory', 'search_context'];

export async function createWorkspaceTools({ root, slug, target = null, req, stream, getState, readContext, sessionContext, sessionRecords, setProblem, kind = 'code', onAction, runCode, liveMock = false } = {}) {
  const svc = serviceFor({ homeRoot: root });
  let names = kind === 'coding' ? ['get_state','edit_code','mark_lines','clear_marks','run_code','add_case','update_case','remove_case','get_submissions','save_note','read_memory','update_memory'] : kind === 'board' ? ['get_state','edit_board','save_note','read_memory','update_memory'] : kind === 'review' ? [...(getState ? ['get_state'] : []),'save_note','read_memory','update_memory'] : ['get_state','edit_code','mark_lines','clear_marks','save_note','read_memory','update_memory', ...(runCode ? ['run_code'] : [])];
  names.push('read_context','search_context','read_coaching_instructions','update_coaching_instructions');
  if (!liveMock) names.push('start_notes_session','notes_session_status');
  if (liveMock) names = names.filter(name => !PAST_RECORD_TOOLS.includes(name));
  if(sessionContext)names.push('record_session');
  if(setProblem)names.push('set_practice_problem');
  const store = svc.actions;
  const runs = stream ? { action: (_run, payload) => stream.send('action', payload) } : null;
  const state = getState ? async () => {
    const value = await getState();
    if (value && Array.isArray(value.elements) && !value.revision) value.revision = crypto.createHash('sha256').update(JSON.stringify(value.elements)).digest('hex');
    return value;
  } : null;
  const session = createToolSession({ root, slug, store, runs, run: stream ? { subscribers: new Set([stream]) } : null, target, sessionLog: kind === 'coding' ? svc.sessionLog : null, capabilities: { names, liveMock, includeCases: kind === 'coding', getState: state, readContext, sessionContext, sessionRecords, setProblem, ...(runCode ? { runCode } : {}) }, onAction });
  let token, mcp;
  try {
    const specs = TOOL_SPECS.filter(s => names.includes(s.name)).map(spec => liveMock && spec.name === 'read_context' ? { ...spec, description: 'Retrieve earlier parts of this interview omitted from the prompt: session, runs, scenes, native_progress or result:<id>. Past interviews and notes are not available during a mock.' } : spec).map(spec => spec.name === 'get_state' ? { ...spec, description: 'Read the latest saved workspace: complete Python code or whiteboard elements and revision. The editor can contain newer work; edits are checked against it.' } : spec.name === 'run_code' && runCode ? { ...spec, description: 'Execute the saved Python document as a script using the local runner. Returns real output and errors; this is a coach run, not a learner test. Do not supply numbered cases.' } : spec);
    if (req) { token = crypto.randomBytes(32).toString('hex'); svc.toolTokens.set(token, session); const port = req.socket?.localPort || 4173; mcp = await writeMcpConfig(`http://127.0.0.1:${port}/api/coach/tools/call`, token, specs); }
    return { options: { toolSession: session, toolSpecs: specs, mcpConfigPath: mcp?.file, studioTools: names }, get actions() { return session.actions; }, async dispose() { session.dispose(); if (token) svc.toolTokens.delete(token); try { await session.flush(); } finally { await mcp?.dispose?.(); } } };
  } catch (error) { session.dispose(); await session.flush(); if (token) svc.toolTokens.delete(token); await mcp?.dispose?.(); throw error; }
}
