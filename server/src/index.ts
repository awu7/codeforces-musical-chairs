import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import express, { type Express } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameEngine } from './engine.js';
import { JudgingService } from './judging.js';
import { Runner } from './runner.js';
import { Store } from './store.js';
import { CodeforcesBridge } from './cf/bridge.js';
import { adminRouter, serializeAdminState } from './routes/admin.js';
import { createSocketServer } from './socket.js';
import type { Server as SocketServer } from 'socket.io';

export interface BackendOptions {
  dataDir?: string;
}

export interface Backend {
  app: Express;
  httpServer: HttpServer;
  io: SocketServer;
  store: Store;
  engine: GameEngine;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createBackend(options: BackendOptions = {}): Promise<Backend> {
  const store = new Store(options.dataDir);
  await store.load();
  const engine = new GameEngine(store);
  const runner = new Runner();
  const bridge = new CodeforcesBridge(store);
  const judging = new JudgingService(store, engine, runner, bridge);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });
  app.use(express.json({ limit: '8mb' }));
  const isTokenValid = (token: string) => store.state.adminTokens.includes(token);

  app.get('/api/health', (_req, res) => res.json({ ok: true, phase: store.state.phase }));
  app.get('/api/scoreboard', (req, res) => {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    if (!store.state.config.showScoreboardToClients && !isTokenValid(token)) {
      res.status(403).json({ error: 'Scoreboard is not public' });
      return;
    }
    res.json({
      eventName: store.state.config.eventName,
      clock: engine.clock(),
      rows: engine.visibleScoreboard(),
    });
  });
  app.post('/api/admin/login', (req, res) => {
    const password = String(req.body?.password ?? '');
    const configured = process.env.ADMIN_PASSWORD ?? 'admin';
    if (!safeEqual(password, configured)) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    const token = randomBytes(32).toString('base64url');
    store.state.adminTokens.push(token);
    store.log('info', 'Admin login');
    store.changed();
    res.json({ token });
  });
  app.use('/api/admin', (req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    if (isTokenValid(token)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Admin authentication required' });
  });
  app.use('/api/admin', (req, _res, next) => {
    if (req.method !== 'GET') {
      store.log('info', `Admin ${req.method} ${req.path}`);
      store.changed();
    }
    next();
  });
  app.use('/api/admin', adminRouter({
    store, engine, bridge, judging,
    tokenValid: isTokenValid,
  }));
  app.get('/api/admin-state', (req, res) => {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    if (!isTokenValid(token)) { res.status(401).json({ error: 'Admin authentication required' }); return; }
    res.json(serializeAdminState(store, engine));
  });

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  app.use(express.static(webDist));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) { res.status(404).json({ error: 'Not found' }); return; }
    res.sendFile(path.join(webDist, 'index.html'), (error) => {
      if (error) res.status(404).json({ error: 'Not found' });
    });
  });

  const httpServer = createServer(app);
  const io = createSocketServer({ httpServer, store, engine, runner, judging, tokenValid: isTokenValid });
  engine.startScheduler();
  const close = async () => {
    engine.stopScheduler();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await bridge.close();
    await store.close();
  };
  return {
    app,
    httpServer,
    io,
    store,
    engine,
    listen(port = Number(process.env.PORT ?? 3001), host = '0.0.0.0') {
      return new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          const address = httpServer.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    close,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is unset; using insecure default "admin"');
  void createBackend().then(async (backend) => {
    const port = await backend.listen();
    console.log(`Musical Chairs server listening on ${port}`);
    const shutdown = () => {
      void backend.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error: unknown) => {
    console.error(`Server startup failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
