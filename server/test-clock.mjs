// A movable clock for browser checks only. Never active in Studio itself: it installs
// only when STUDIO_TEST_CLOCK=1, which only scripts/check-*.mjs set on a scratch server.
// Moving it lets a check leave a mock running, let "minutes" pass, and come back, which
// is the only way to exercise the attended-time rule end to end without waiting.
import { readJsonBody } from './coach/http.mjs';
import { sendJson, HttpError } from './http-util.mjs';

let offset = 0;
export const testClockEnabled = process.env.STUDIO_TEST_CLOCK === '1';
if (testClockEnabled) {
  const RealDate = Date;
  class TestDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  globalThis.Date = TestDate;
}

export const testClockRoutes = testClockEnabled ? {
  /** POST /api/test/clock { advanceMs } moves this scratch server's clock forward. */
  'POST /api/test/clock': async (req, res) => {
    const body = await readJsonBody(req);
    if (!Number.isFinite(body.advanceMs) || body.advanceMs < 0) throw new HttpError(400, 'BAD_REQUEST', 'advanceMs must be a non-negative number.');
    offset += body.advanceMs;
    return sendJson(res, 200, { offsetMs: offset, now: Date.now() });
  },
} : {};
