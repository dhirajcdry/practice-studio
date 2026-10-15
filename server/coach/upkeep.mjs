import { runCoachTurn as runClaude } from './claude-cli.mjs';

const MAX_QUEUED = 20;

export function buildUpkeepPrompt(job) {
  const design = job.kind === 'design-debrief' || String(job.slug ?? '').startsWith('design:');
  const scope = design
    ? `Update only DESIGN.md and design/${String(job.slug).slice(7)}/NOTES.md: what this interview confirms or breaks about recurring patterns. Keep it short and specific.`
    : `Update problems/${job.slug}/NOTES.md, append to today's journal/<yyyy-mm-dd>.md using the local date, evolve TUTOR.md, and refine or author a skill only when something meaningful happened.`;
  return [
    'This step is invisible to the learner. You see the whole conversation; maintain memory for the exchange that just happened.',
    'Follow the Memory protocol and Skill library rules from CLAUDE.md. Nothing to update is a valid outcome.',
    scope,
    job.kind === 'attempt-review' ? `Also write the attempt debrief to problems/${job.slug}/debriefs/.` : '',
    'Preserve facts and do not invent statistics, events, or conclusions.',
    'Files you must NEVER write: meta.json, index.json, solution.py, attempts/, sessions/, chats.jsonl, coach-session.json, design/*/interview.json, design/*/turns.jsonl, design/*/scenes/**, design/*/interview.md.',
    'Reply with the single word done.',
  ].filter(Boolean).join('\n');
}

export function createUpkeepQueue({ runner = runClaude, logger = console, now = () => Date.now() } = {}) {
  let running = null;
  const queued = [];
  const warn = job => (job.log ?? logger).warn?.(`[coach] upkeep ${job.slug}: failed or queue full`);

  const startNext = () => {
    if (running || !queued.length) return;
    const job = queued.shift();
    running = job;
    const started = now();
    let first = null;
    let tools = 0;
    const toolSummary = [];
    const log = job.log ?? logger;
    const onTool = (name, summary) => {
      tools += 1;
      toolSummary.push(`${name ?? 'tool'} ${summary ?? ''}`.replace(/[\r\n]+/g, ' ').trim());
    };
    const onToken = () => {
      if (first === null) first = now() - started;
    };
    let turn;
    try {
      turn = runner({
        root: job.root, binary: job.binary || 'claude', env: job.env, spawnFn: job.spawnFn, prompt: buildUpkeepPrompt(job),
        resumeSessionId: job.sessionId ?? null,
        model: job.model === 'default' ? null : (job.model ?? null),
        tools: 'Read,Glob,Write,Edit', forkSession: true, noSessionPersistence: true,
        timeoutMs: 300000, onTool, onToken,
        onError: () => warn(job),
      });
    } catch {
      warn(job);
      turn = { exited: Promise.resolve() };
    }
    Promise.resolve(turn?.exited).catch(() => warn(job)).then(() => {
      const total = now() - started;
      log.info?.(`[coach] upkeep ${job.slug}: ${toolSummary.join(', ') || 'none'} total=${total}ms`);
      log.info?.(`[coach] timing ${job.slug} upkeep provider=claude model=${job.model ?? 'default'} first=${first ?? '-'} total=${total} tools=${tools}`);
      running = null;
      setImmediate(startNext);
    });
  };

  return {
    enqueue(job) {
      if (!job?.root || !job?.slug || !job?.sessionId) return false;
      const index = queued.findIndex(item => item.root === job.root && item.slug === job.slug);
      // A newer fork contains the earlier exchange; keep only its view of the thread.
      if (index !== -1) { queued[index] = job; return true; }
      if (queued.length >= MAX_QUEUED) { warn(job); return false; }
      queued.push(job);
      // The answer route must finish its SSE response before background work starts.
      setImmediate(startNext);
      return true;
    },
    status: () => ({ running: running?.slug ?? null, queued: queued.length }),
  };
}

export const upkeepQueue = createUpkeepQueue();
