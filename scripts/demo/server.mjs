// Real Studio app with connected integrations disabled for an illustrative demo.
import http from 'node:http';
import { boot } from '../../server/index.mjs';
import { HOST, PORT } from '../../server/paths.mjs';
import { LeetCodeError } from '../../server/leetcode.mjs';
import { sendJson } from '../../server/http-util.mjs';

if (!process.env.STUDIO_HOME || !process.env.STUDIO_COACH_BINARY || !process.env.STUDIO_DEMO_TOKEN) {
  throw new Error('Start this disposable demo through npm run demo, not directly.');
}
const { app, leetcode } = boot({ quiet: true });
leetcode.fetchQuestionImpl = async () => {
  throw new LeetCodeError('This illustrative demo only contains the seeded problem; live content fetching is disabled.');
};
const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://127.0.0.1').pathname;
  if (route === '/api/demo') return sendJson(res, 200, { token: process.env.STUDIO_DEMO_TOKEN });
  if (route === '/api/submit' || route === '/api/asr') {
    return sendJson(res, 503, { error: { code: 'DEMO_ONLY',
      message: 'Illustrative demo: real submissions and microphone transcription are disabled.' } });
  }
  return app(req, res);
});
server.listen(PORT, HOST);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
