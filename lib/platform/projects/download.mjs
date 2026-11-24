import { createHmac, timingSafeEqual } from 'node:crypto';
import { projectError } from './validation.mjs';

const lifetimeMs = 5 * 60 * 1000;
function digest(owner, projectId, assetId, until, secret) {
  if (!secret || secret.length < 32) throw new Error('Private download signing is unconfigured');
  return createHmac('sha256', secret).update(JSON.stringify(['project-download-v1', owner, projectId, assetId, until])).digest();
}
export function downloadTicket(owner, project, assetId, now, secret = process.env.BETTER_AUTH_SECRET) {
  const until = Math.min(now.getTime() + lifetimeMs, project.expiresAt?.getTime() ?? Infinity);
  const signature = digest(owner, project.id, assetId, until, secret).toString('base64url');
  const path = '/api/platform/v1/projects/' + project.id + '/assets/' + assetId + '/download';
  return { url: path + '?' + new URLSearchParams({ until, signature }), expiresAt: new Date(until).toISOString() };
}
export function verifyTicket(params, owner, projectId, assetId, now, secret = process.env.BETTER_AUTH_SECRET) {
  const raw = params.get('until');
  const until = Number(raw);
  const token = params.get('signature') || '';
  if (!/^\d{1,15}$/.test(raw) || until <= now.getTime() || until > now.getTime() + lifetimeMs ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token, 'base64url'), digest(owner, projectId, assetId, until, secret))) {
    throw projectError('DOWNLOAD_LINK_INVALID', 403);
  }
}
export function attachmentHeaders(asset) {
  return { 'Content-Type': asset.mediaType, 'Content-Length': String(asset.byteSize),
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(asset.filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()),
    'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
}
