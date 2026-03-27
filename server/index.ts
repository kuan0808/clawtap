import express from 'express';
import type { Request, Response } from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { readFileSync } from 'fs';
import {
  initAuth,
  login,
  authMiddleware,
} from './auth.js';
import './adapters/init.js';
import { initAll, installAllHooks, listAvailable, get as getAdapter, getAll as getAllAdapters, cleanupAll, DEFAULT_ADAPTER } from './adapters/registry.js';
import { initPush, getVapidPublicKey, saveSubscription, removeSubscription, getPendingSessions } from './push.js';
import {
  setupSessionManager,
  handleIncomingMessage,
  getClientCount,
  broadcastReviewStarted,
  broadcastReviewEnded,
  registerSessionAdapter,
} from './session-manager.js';
import { WebSocketTransport } from './transport/websocket-transport.js';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { initDB, closeDB, sessionReviews, sessionAdapters, savedInstructions } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

import multer from 'multer';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';

// --- Start ---

async function start(): Promise<void> {
  const config = loadConfig();
  initDB(config);

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Image upload config
  const uploadDir = config.paths.uploads;
  mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
        const ext = file.originalname.split('.').pop() || 'png';
        cb(null, `${randomUUID()}.${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Only images allowed'));
    },
  });

  // Serve built frontend in production
  const distPath: string = join(__dirname, '..', 'dist');
  app.use(express.static(distPath));

  // --- REST Routes ---

  app.get('/health', (_req: Request, res: Response) => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    res.json({ status: 'ok', branch: config.gitBranch, version: pkg.version });
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const { password } = req.body as { password?: string };
    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }
    const ip: string = req.ip || (req as any).connection?.remoteAddress || 'unknown';
    const result = await login(password, ip);
    if ('error' in result) {
      return res.status((result as { error: string; status: number }).status).json({ error: result.error });
    }
    res.json({ token: (result as { token: string }).token });
  });

  app.get('/api/sessions', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { dir, limit } = req.query as { dir?: string; limit?: string };
      const parsedLimit = limit ? parseInt(limit) : 0;
      const adapters = getAllAdapters();
      const results = await Promise.all(
        [...adapters.entries()].map(([name, adapter]) =>
          adapter.getSessions(dir, parsedLimit || undefined)
            .then(sessions => sessions.map(s => ({ ...s, adapter: name })))
            .catch(err => { console.warn(`[sessions] Failed to get sessions from ${name}:`, (err as Error).message); return [] as any[]; })
        )
      );
      const allSessions = results.flat();
      // Persist session→adapter mapping so server knows which adapter owns each session
      for (const s of allSessions) {
        if (s.sessionId && s.adapter) sessionAdapters.set(s.sessionId, s.adapter);
      }
      allSessions.sort((a, b) => {
        const aTime = typeof a.lastModified === 'number' ? a.lastModified : new Date(a.lastModified || 0).getTime();
        const bTime = typeof b.lastModified === 'number' ? b.lastModified : new Date(b.lastModified || 0).getTime();
        return bTime - aTime;
      });
      if (parsedLimit > 0) allSessions.splice(parsedLimit);
      const childIds = sessionReviews.getAllChildIds();
      const filtered = allSessions.filter((s: any) => !childIds.has(s.sessionId));
      res.json(filtered);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post('/api/upload', authMiddleware, upload.single('image'), (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    res.json({ path: req.file.path, filename: req.file.filename });
  });

  app.get('/api/sessions/:id/messages', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { adapter: adapterName, dir } = req.query as { adapter?: string; dir?: string };
      const adapter = getAdapter(adapterName || DEFAULT_ADAPTER);
      const messages = await adapter!.getMessages(req.params.id as string, dir);
      res.json(messages);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/browse', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { path: queryPath, adapter: adapterName } = req.query as { path?: string; adapter?: string };
      const requestedPath = queryPath ? resolve(queryPath) : undefined;
      const home = homedir();
      if (requestedPath && !requestedPath.startsWith(home)) {
        return res.status(403).json({ error: 'Browsing restricted to home directory' });
      }
      const adapter = getAdapter(adapterName || DEFAULT_ADAPTER);
      const dirs = await adapter!.listDirectory(requestedPath);
      res.json(dirs);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/active-sessions', authMiddleware, (req: Request, res: Response) => {
    try {
      const { adapter: adapterName } = req.query as { adapter?: string };

      let allActiveSessions: any[] = [];

      if (adapterName) {
        const adapter = getAdapter(adapterName);
        if (adapter?.getActiveSessions) {
          allActiveSessions = adapter.getActiveSessions();
        }
      } else {
        // No adapter specified — aggregate all adapters
        const adapters = getAllAdapters();
        for (const [, adapter] of adapters) {
          if (adapter.getActiveSessions) {
            allActiveSessions.push(...adapter.getActiveSessions());
          }
        }
      }

      for (const s of allActiveSessions) {
        const count = getClientCount(s.sessionId);
        const totalCount = count + (s.hasDesktop ? 1 : 0);
        s.hasClients = totalCount > 0;
        (s as any).clientCount = totalCount;
      }
      const childIds = sessionReviews.getAllChildIds();
      const filteredActive = allActiveSessions.filter((s: any) => !childIds.has(s.sessionId));
      res.json(filteredActive);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // --- Adapter Discovery Endpoints ---

  app.get('/api/adapters', authMiddleware, (_req: Request, res: Response) => {
    res.json(listAvailable());
  });

  app.get('/api/adapter/:name/config', authMiddleware, (req: Request, res: Response) => {
    const adapter = getAdapter(req.params.name as string);
    if (!adapter) return res.status(404).json({ error: 'Adapter not found' });
    res.json({
      models: adapter.getModels(),
      permissionModes: adapter.getPermissionModes(),
      effortLevels: adapter.getEffortLevels(),
      effortLabel: adapter.getEffortLabel(),
      capabilities: adapter.getCapabilities(),
    });
  });

  // --- Session Management ---

  app.delete('/api/active-sessions/:id', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { adapter: adapterName } = req.query as { adapter?: string };
      const adapter = getAdapter(adapterName || DEFAULT_ADAPTER);
      await adapter!.destroySession(req.params.id as string);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post('/api/sessions/start', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { adapter: adapterName, cwd, model, permissionMode } = req.body;
      if (!cwd) return res.status(400).json({ error: 'cwd required' });

      const adapter = getAdapter(adapterName || DEFAULT_ADAPTER);
      if (!adapter) return res.status(400).json({ error: `Unknown adapter: ${adapterName}` });

      const handle = await adapter.startSession(cwd, { model, permissionMode });
      registerSessionAdapter(handle.sessionId, adapterName || DEFAULT_ADAPTER);

      res.json({ sessionId: handle.sessionId });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post('/api/sessions/resume', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { sessionId, adapter: adapterName, cwd } = req.body;
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

      const resolvedAdapter = adapterName || DEFAULT_ADAPTER;
      const adapter = getAdapter(resolvedAdapter);
      if (!adapter) return res.status(400).json({ error: `Unknown adapter: ${resolvedAdapter}` });

      const handle = await adapter.resumeSession(sessionId, cwd || process.cwd());
      registerSessionAdapter(handle.sessionId, resolvedAdapter);

      res.json({ sessionId: handle.sessionId });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // --- Review API ---

  // Register a review after the child session is already created via QUERY
  app.post('/api/reviews/register', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { reviewId, parentCliSessionId, childSessionId, targetAdapter, anchorMessageId, prompt, title } = req.body;
      if (!reviewId || !parentCliSessionId || !childSessionId) {
        return res.status(400).json({ error: 'reviewId, parentCliSessionId and childSessionId required' });
      }

      // Find which adapter owns the parent session
      let parentAdapterName = DEFAULT_ADAPTER;
      for (const [name, a] of getAllAdapters()) {
        if (a.getSession(parentCliSessionId)) { parentAdapterName = name; break; }
      }

      sessionReviews.create(reviewId, parentCliSessionId, childSessionId, targetAdapter, parentAdapterName, anchorMessageId, prompt, title);

      // Ensure adapter mapping exists for the child session
      registerSessionAdapter(childSessionId, targetAdapter);

      broadcastReviewStarted(parentCliSessionId, {
        reviewId,
        childSessionId,
        childCliSessionId: childSessionId,
        childAdapter: targetAdapter,
        anchorMessageId,
        reviewTitle: title,
      });

      res.json({ reviewId });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.delete('/api/reviews/:id', authMiddleware, async (req: Request, res: Response) => {
    try {
      const review = sessionReviews.getById(req.params.id);
      if (!review) return res.status(404).json({ error: 'Review not found' });

      const { endAnchorMessageId } = req.body || {};
      sessionReviews.endReview(review.id, 0, endAnchorMessageId);

      // Broadcast to parent WS clients
      broadcastReviewEnded(review.parent_cli_session_id, review.id);

      // Try to destroy child tmux session
      const childAdapter = getAdapter(review.child_adapter);
      if (childAdapter) {
        try {
          await childAdapter.destroySession(review.child_cli_session_id);
        } catch (err) {
          console.error('[review] Failed to destroy child session:', (err as Error).message);
        }
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post('/api/reviews/:id/send-back', authMiddleware, async (req: Request, res: Response) => {
    try {
      const review = sessionReviews.getById(req.params.id);
      if (!review) return res.status(404).json({ error: 'Review not found' });

      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'message required' });

      // Find parent session from adapter's in-memory Map
      const parentAdapter = getAdapter(review.parent_adapter || DEFAULT_ADAPTER);
      if (!parentAdapter) return res.status(400).json({ error: 'Parent adapter not found' });

      const parentSessionId = review.parent_cli_session_id;
      if (!parentAdapter.getSession(parentSessionId)) {
        return res.status(404).json({ error: 'Parent session not found' });
      }

      // Check if parent is busy
      if (parentAdapter.isProcessing(parentSessionId)) {
        return res.status(409).json({ error: 'Parent session is busy. Wait for the current turn to complete.' });
      }

      // Format and send
      const formatted = `[Review feedback from ${review.child_adapter}]:\n${message}`;
      await parentAdapter.sendMessage(parentSessionId, formatted);

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/reviews', authMiddleware, (req: Request, res: Response) => {
    try {
      const { parentCliSessionId } = req.query as { parentCliSessionId?: string };
      if (!parentCliSessionId) return res.status(400).json({ error: 'parentCliSessionId required' });

      const reviews = sessionReviews.getAllForParent(parentCliSessionId);
      res.json(reviews);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // --- Saved Instructions API ---

  app.get('/api/instructions', authMiddleware, (_req: Request, res: Response) => {
    try {
      res.json(savedInstructions.getAll());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post('/api/instructions', authMiddleware, (req: Request, res: Response) => {
    try {
      const { label, instruction } = req.body;
      if (!label || !instruction) return res.status(400).json({ error: 'label and instruction required' });
      const id = randomUUID();
      savedInstructions.create(id, label, instruction);
      res.json({ id, label, instruction });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.delete('/api/instructions/:id', authMiddleware, (req: Request, res: Response) => {
    try {
      savedInstructions.delete(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // --- Push Notification API ---
  app.get('/api/push/vapid-public-key', authMiddleware, (_req: Request, res: Response) => {
    res.json({ publicKey: getVapidPublicKey() });
  });

  app.post('/api/push/subscribe', authMiddleware, (req: Request, res: Response) => {
    const { subscription } = req.body as { subscription?: { endpoint?: string } };
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Missing subscription' });
    saveSubscription(subscription as any);
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', authMiddleware, (req: Request, res: Response) => {
    const { endpoint } = req.body as { endpoint?: string };
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    removeSubscription(endpoint);
    res.json({ ok: true });
  });

  app.get('/api/push/pending', authMiddleware, (_req: Request, res: Response) => {
    res.json(getPendingSessions());
  });

  // SPA fallback
  app.get('*path', (_req: Request, res: Response) => {
    res.sendFile(join(distPath, 'index.html'));
  });

  // --- Server + WebSocket ---

  let server: HttpServer | HttpsServer;
  if (config.https) {
    server = createHttpsServer({ cert: config.https.cert, key: config.https.key }, app);
  } else {
    server = createServer(app);
  }

  // --- WebSocket Transport ---
  const wsTransport = new WebSocketTransport();
  wsTransport.setup(server);
  wsTransport.on('connection', (conn) => {
    conn.send({ type: 'client-id', clientId: conn.clientId });
  });
  wsTransport.on('message', async (conn, msg) => {
    try {
      await handleIncomingMessage(conn, msg);
    } catch (err) {
      conn.send({ type: 'error', error: (err as Error).message });
    }
  });

  // Register adapter routes (before listen — routes don't depend on port)
  initAll(app);

  setupSessionManager();

  // --- Find available port and Listen ---

  await initAuth(config);
  initPush(config);

  const protocol = config.https ? 'https' : 'http';
  const actualPort = await new Promise<number>((resolve, reject) => {
    const maxRetries = 10;
    let attempt = 0;
    function tryListen(port: number) {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < maxRetries) {
          attempt++;
          const nextPort = port + 1;
          console.log(`Port ${port} in use, trying ${nextPort}...`);
          server.close(() => tryListen(nextPort));
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(port, '0.0.0.0', () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    }
    tryListen(config.port);
  });

  // Update config with actual port (may differ if fallback occurred)
  config.port = actualPort;

  // Install hooks AFTER port is confirmed (hooks embed the port in CLI configs)
  installAllHooks(actualPort);

  writeFileSync(config.paths.pid, String(process.pid));
  console.log(`ClawTap running on ${protocol}://0.0.0.0:${actualPort}${config.https ? ' (HTTPS)' : ''}`);

  // --- Graceful Shutdown ---

  async function shutdown(signal: string): Promise<void> {
    console.log(`\n[shutdown] ${signal} received, cleaning up...`);
    await cleanupAll();
    wsTransport.destroy();
    closeDB();
    try { unlinkSync(config.paths.pid); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000); // Force exit after 3s
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err: Error) => {
    console.error('[fatal] uncaught exception:', err);
    cleanupAll().catch((e: unknown) => console.error('[cleanup]', e)).finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (err: unknown) => {
    console.error('[fatal] unhandled rejection:', err);
    cleanupAll().catch((e: unknown) => console.error('[cleanup]', e)).finally(() => process.exit(1));
  });
}

start().catch((err: unknown) => {
  console.error('Failed to start:', err);
  cleanupAll().catch((e: unknown) => console.error('[cleanup]', e)).finally(() => process.exit(1));
});
