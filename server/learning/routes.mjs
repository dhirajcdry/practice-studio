import { readJsonBody } from '../coach/http.mjs';
import { HttpError, sendJson } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { readLearnerProfile, setLearnerPreferences } from './profile.mjs';
import { prepareProblem, publicProblem } from './selection.mjs';
import { readTrackHome } from './track-home.mjs';
const rootFor = ctx => ctx.homeRoot || HOME_ROOT;
export const learnerRoutes = {
  'GET /api/learner': async (_q, r, c) => sendJson(r, 200, { profile: await readLearnerProfile(rootFor(c)) }),
  'GET /api/learner/preferences': async (_q, r, c) => sendJson(r, 200, { preferences: (await readLearnerProfile(rootFor(c))).preferences }),
  'POST /api/learner/preferences': async (q, r, c) => {
    const body = await readJsonBody(q);
    try { return sendJson(r, 200, { preferences: await setLearnerPreferences(rootFor(c), body) }); }
    catch (error) { if (/targetLevel|answerMode/.test(error.message)) throw new HttpError(400, 'BAD_REQUEST', error.message); throw error; }
  },
  'GET /api/track-home': async (q, r, c) => {
    const discipline = new URL(q.url, 'http://local').searchParams.get('discipline');
    if (!['lld', 'design'].includes(discipline)) throw new HttpError(400, 'BAD_REQUEST', 'discipline must be lld or design');
    return sendJson(r, 200, await readTrackHome(rootFor(c), discipline));
  },
  'POST /api/mock/prepare': async (q, r, c) => sendJson(r, 200, { problem: publicProblem(await prepareProblem(rootFor(c), await readJsonBody(q))) }),
};
