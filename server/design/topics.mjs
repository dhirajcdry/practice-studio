import crypto from 'node:crypto';
export const DESIGN_TOPICS = [
  { slug: 'design-url-shortener', title: 'URL shortener', prompt: 'Design a URL-shortening service.' },
  { slug: 'design-messaging', title: 'Messaging', prompt: 'Design a messaging service for one-to-one conversations.' },
  { slug: 'design-file-storage', title: 'File storage', prompt: 'Design a cloud file-storage service.' },
  { slug: 'design-news-feed', title: 'News feed', prompt: 'Design a personalized news-feed service.' },
];
export function topicFor(prompt) {
  const text = String(prompt || '').trim();
  return DESIGN_TOPICS.find(t => t.prompt === text) || { slug: 'design-custom-' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 12), title: text || 'System design', prompt: text };
}
