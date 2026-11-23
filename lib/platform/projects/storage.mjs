import aws4 from 'aws4';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { uuidPattern } from './validation.mjs';

export function projectStorage(backend = process.env.PLATFORM_PROJECT_STORAGE || 'local', env = process.env) {
  function key(id) {
    if (!uuidPattern.test(id)) throw new TypeError('Invalid private asset ID');
    return 'projects/' + id.slice(0,2) + '/' + id;
  }
  if (backend === 'local') {
    const root = resolve(env.PLATFORM_PROJECT_ROOT || '.private-projects');
    const publicDir = resolve('public');
    if (root === publicDir || root.startsWith(publicDir + sep)) throw new Error('Choose a private asset directory');
    return {
      backend,
      async put(id, bytes) {
        const path = join(root, key(id));
        await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(bytes); } finally { await file.close(); }
      },
      get: id => readFile(join(root, key(id))),
      remove: id => rm(join(root, key(id)), { force: true }),
    };
  }
  if (backend !== 's3') throw new Error('Unknown private object backend');
  const endpoint = new URL(env.PLATFORM_S3_ENDPOINT);
  const bucket = env.PLATFORM_S3_BUCKET || '';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
      !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))) {
    throw new Error('Invalid private S3 endpoint or bucket');
  }
  const credentials = { accessKeyId: env.PLATFORM_S3_ACCESS_KEY, secretAccessKey: env.PLATFORM_S3_SECRET_KEY,
    sessionToken: env.PLATFORM_S3_SESSION_TOKEN || undefined };
  if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error('Missing private S3 credentials');
  async function request(method, id, body, type) {
    const path = '/' + bucket + '/' + key(id);
    const { headers } = aws4.sign({ host: endpoint.host, path, method, service: 's3',
      region: env.PLATFORM_S3_REGION || 'us-east-1', body, headers: type ? { 'Content-Type': type } : {} }, credentials);
    const res = await fetch(new URL(path, endpoint), { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (method === 'GET' && res.ok) return Buffer.from(await res.arrayBuffer());
    await res.body?.cancel();
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error('Private S3 request failed (' + res.status + ')');
  }
  return { backend, put: (id, bytes, type) => request('PUT', id, bytes, type),
    get: id => request('GET', id), remove: id => request('DELETE', id) };
}
