// Real Studio app with connected integrations disabled for an illustrative demo.
import http from 'node:http';
import { boot } from '../../server/index.mjs';
import { HOST, PORT } from '../../server/paths.mjs';
import { LeetCodeError } from '../../server/leetcode.mjs';
import { sendJson } from '../../server/http-util.mjs';
import { StaticSite } from '../../server/static.mjs';
import { fileURLToPath } from 'node:url';

if (!process.env.STUDIO_HOME || !process.env.STUDIO_COACH_BINARY || !process.env.STUDIO_DEMO_TOKEN) {
  throw new Error('Start this disposable demo through npm run demo, not directly.');
}
const { app, leetcode } = boot({ quiet: true });
const showcase = new StaticSite(fileURLToPath(new URL('../../docs/', import.meta.url)));
leetcode.fetchQuestionImpl = async () => {
  throw new LeetCodeError('This illustrative demo only contains the seeded problem; live content fetching is disabled.');
};
const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://127.0.0.1').pathname;
  if (route.startsWith('/showcase/')) return showcase.serve(req, res, route.slice('/showcase'.length));
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
