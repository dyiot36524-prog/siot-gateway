// PWA 정적 파일(apps/web/dist) 서빙. API 경로가 아닌 GET 은 파일, 없으면 index.html(SPA 라우팅).
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const API_PREFIXES = ['/v1/', '/app/', '/gateway', '/metrics', '/healthz'];

export type StaticHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>;

/** dist 가 있으면 404 처리기에서 부를 정적 처리기, 없으면 null */
export async function createStaticHandler(root: string): Promise<StaticHandler | null> {
  try {
    if (!(await stat(join(root, 'index.html'))).isFile()) return null;
  } catch {
    return null;
  }
  const base = normalize(root + sep);
  return async (req, reply) => {
    const path = decodeURIComponent(req.url.split('?')[0] ?? '/');
    if ((req.method !== 'GET' && req.method !== 'HEAD') || API_PREFIXES.some((p) => path.startsWith(p))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '경로를 찾을 수 없습니다' } });
    }
    let file = normalize(join(root, path));
    if (!file.startsWith(base)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '경로를 찾을 수 없습니다' } });
    try {
      if (!(await stat(file)).isFile()) throw new Error('dir');
    } catch {
      file = join(root, 'index.html');
    }
    const ext = extname(file);
    const immutable = file.includes(`${sep}assets${sep}`);
    reply
      .header('content-type', TYPES[ext] ?? 'application/octet-stream')
      .header('cache-control', ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    return reply.send(await readFile(file));
  };
}
