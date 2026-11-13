import { createReply, isNoteOnlyReply } from './turn.js';
import { changeCards } from './turn-changes.js';
import { actionOutput, actionFailed } from './turn-output.js';
import { undoAction } from '../coach-actions.js';

// Screen adapters own prose, speech, and scroll position. This controller owns the
// activity/change lifecycle, including snapshots recovered without executing tools.
const replies = new WeakMap();
export const workspaceReply = body => replies.get(body);
export const interviewStamp = ms => Number.isFinite(ms) ? ms < 60000 ? 'At the start' : `${Math.floor(ms / 60000)} min in` : '';
export function createWorkspaceReply({ liveMock = false, ...options } = {}) {
  const reply = createReply(options), actions = new Map(), local = new Map();
  let steps = [], live = false, settled = false, foot = {}, notice = null;
  const paint = () => {
    const visibleSteps = steps.map(step => ({ ...step }));
    for (const action of actions.values()) {
      const step = visibleSteps.findLast(step => (step.tool || step.name)?.replace(/^mcp__studio__/, '') === action.tool);
      const detail = { output: actionOutput(action), failed: actionFailed(action) };
      if (step) Object.assign(step, detail);
      else visibleSteps.push({ tool: action.tool, display: action.display, ...detail });
    }
    reply.setActivity(visibleSteps, { live, endedAt: foot.at });
    reply.setChanges(changeCards([...actions.values()], { ui: local, settled, liveMock, onUndo: async action => {
      if (local.get(action.id)?.busy) return;
      local.set(action.id, { busy: true }); paint();
      try { const result = await undoAction(action); local.set(action.id, result.ok ? { undone: true } : { error: result.message }); }
      catch (error) { local.set(action.id, { error: error.message || 'Could not undo this change.' }); }
      paint();
    } }));
  };
  const controller = {
    ...reply,
    start() { settled = false; live = true; notice = null; reply.setNotice(null); paint(); },
    tool(step) { steps.push(step); live = true; paint(); },
    writing() { if (live) { live = false; paint(); } },
    action(action, { replay = false } = {}) {
      actions.set(action.id, replay && action.status === 'pending' ? { ...action, status: 'failed' } : action);
      paint();
    },
    restore(activity = [], savedActions = [], { pending = false, at } = {}) {
      steps = activity; live = pending && !reply.body.dataset.markdown; settled = !pending;
      if (at) foot.at = at;
      for (const action of savedActions) actions.set(action.id, action);
      paint();
    },
    setNotice(value) { notice = value; reply.setNotice(value); },
    finish(options = {}) {
      foot = { ...foot, ...options }; settled = true; live = false; paint();
      if (!notice && !liveMock && isNoteOnlyReply({ text: reply.body.dataset.markdown || '', activity: steps, actions: [...actions.values()] })) {
        reply.setNotice({ tone: 'warn', head: 'The coach saved a note and wrote only this.', body: 'A private note is not an explanation.' });
      }
      reply.finish(foot);
    },
  };
  replies.set(reply.body, controller);
  return controller;
}
