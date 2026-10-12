// Reuse public question content already downloaded on this machine. Never copy
// solution buffers, activity, credentials, sessions, or make network requests.
import fsp from 'node:fs/promises';
import path from 'node:path';
export async function copyCachedQuestions(source, destination, slugs) {
  await fsp.mkdir(destination, {recursive:true});
  let copied=0;
  for (const slug of slugs) {
    if (!/^[a-z0-9-]+$/.test(slug)) continue;
    const target=path.join(destination,`${slug}.json`);
    try { await fsp.access(target); continue; } catch {}
    let record;
    try { record=JSON.parse(await fsp.readFile(path.join(source,`${slug}.json`),'utf8')); } catch { continue; }
    if (!record?.question || record.question.titleSlug!==slug || record.complete===false) continue;
    // Preserve only the public question cache schema.
    const text=JSON.stringify({slug,complete:true,fetchedAt:record.fetchedAt??null,question:record.question});
    const temporary=`${target}.demo-tmp`;
    await fsp.writeFile(temporary,text); await fsp.rename(temporary,target); copied++;
  }
  return copied;
}
