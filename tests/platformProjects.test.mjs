import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectStorage } from '../lib/platform/projects/storage.mjs';
import { downloadTicket, verifyTicket } from '../lib/platform/projects/download.mjs';
import { readBounded, validateAsset, validateProject } from '../lib/platform/projects/validation.mjs';

test('private local objects use generated names, restrictive permissions and repeatable removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-objects-'));
  const storage = projectStorage('local', { PLATFORM_PROJECT_ROOT: root });
  const id = randomUUID();
  try {
    await storage.put(id, Buffer.from('private script'));
    assert.equal((await storage.get(id)).toString(), 'private script');
    assert.equal((await stat(join(root, 'projects', id.slice(0,2), id))).mode & 0o777, 0o600);
    await assert.rejects(storage.put(id, Buffer.from('replacement')), { code: 'EEXIST' });
    assert.throws(() => storage.get('../object'), /Invalid/);
    await storage.remove(id);
    await storage.remove(id);
    await assert.rejects(storage.get(id), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('download links bind owner, project and asset, and end at the exact deadline', () => {
  const secret = 's'.repeat(32);
  const now = new Date();
  const project = { id: randomUUID(), expiresAt: new Date(+now + 900) };
  const id = randomUUID();
  const link = downloadTicket('first', project, id, now, secret);
  const params = new URL(link.url, 'http://localhost').searchParams;
  assert.equal(link.expiresAt, project.expiresAt.toISOString());
  verifyTicket(params, 'first', project.id, id, new Date(+now + 899), secret);
  for (const [user, proj, asset, time] of [
    ['second',project.id,id,now], ['first',randomUUID(),id,now], ['first',project.id,randomUUID(),now],
    ['first',project.id,id,project.expiresAt],
  ]) assert.throws(() => verifyTicket(params,user,proj,asset,time,secret), { code: 'DOWNLOAD_LINK_INVALID' });
});
test('content, project payloads and chunked uploads are checked before storage', async () => {
  const file = { kind: 'script', filename: '脚本.txt', mediaType: 'text/plain' };
  assert.equal(validateAsset(file, Buffer.from('字幕')).kind, 'script');
  assert.throws(() => validateAsset({ ...file, filename: '../file.txt' }, Buffer.from('x')), { code: 'INVALID_FILENAME' });
  assert.throws(() => validateAsset({ kind: 'media', filename: 'img.png', mediaType: 'image/png' }, Buffer.from('wrong')), { code: 'UNSUPPORTED_ASSET' });
  assert.throws(() => validateProject({ name: 'ok', document: { x: '\0' } }), { code: 'INVALID_PROJECT' });
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); controller.close();
  } });
  await assert.rejects(readBounded(new Request('http://localhost', { method: 'POST', body, duplex: 'half' }), 7), { status: 413 });
});
