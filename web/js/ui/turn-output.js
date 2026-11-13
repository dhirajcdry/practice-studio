export function actionOutput(action) {
  const result = action.result || action.run;
  if (!result || typeof result !== 'object') return null;
  if ('stdout' in result || 'stderr' in result) return (result.stdout || '') + (result.stderr || '');
  if (Array.isArray(result.cases)) return [result.error?.message, ...result.cases.map((item, i) => [`Case ${i + 1}`, item.stdout, item.stderr, item.error?.message, item.error?.traceback].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
  if (result.error) return [result.error.message, result.error.traceback].filter(Boolean).join('\n');
  if (typeof result.diff === 'string') return result.diff;
  return null;
}
export function actionFailed(action) {
  const result = action.result || action.run;
  return action.status === 'failed' || Boolean(result?.timedOut) || (result?.exitCode != null && result.exitCode !== 0)
    || result?.ok === false || result?.passed === false || Boolean(result?.error)
    || (Number.isFinite(result?.summary?.passed) && result.summary.passed < result.summary.total);
}

