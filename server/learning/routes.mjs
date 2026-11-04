import { readJsonBody } from '../coach/http.mjs';
import { HttpError, sendJson } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { readLearnerProfile, setLearnerPreferences } from './profile.mjs';
import { prepareProblem, publicProblem } from './selection.mjs';
const rootFor = ctx => ctx.homeRoot || HOME_ROOT;
export const learnerRoutes = {
  'GET /api/learner': async (_q, r, c) => sendJson(r, 200, { profile: await readLearnerProfile(rootFor(c)) }),
  'GET /api/learner/preferences': async (_q, r, c) => sendJson(r, 200, { preferences: (await readLearnerProfile(rootFor(c))).preferences }),
  'POST /api/learner/preferences': async (q, r, c) => {
    const body = await readJsonBody(q);
    try { return sendJson(r, 200, { preferences: await setLearnerPreferences(rootFor(c), body) }); }
    catch (error) { if (/targetLevel|answerMode/.test(error.message)) throw new HttpError(400, 'BAD_REQUEST', error.message); throw error; }
  },
  'POST /api/mock/prepare': async (q, r, c) => sendJson(r, 200, { problem: publicProblem(await prepareProblem(rootFor(c), await readJsonBody(q))) }),
};
