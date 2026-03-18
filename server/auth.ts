import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { Request, Response, NextFunction } from 'express';
import type { AppConfig } from './config.js';
import { rateLimit } from './db.js';

const SALT_ROUNDS = 10;
const JWT_EXPIRY = '7d';
const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 60;

let jwtSecret: string;
let passwordHash: string;

// Must be called before any other function
export async function initAuth(config: AppConfig): Promise<void> {
  const { password } = config;
  const AUTH_FILE = config.paths.auth;

  // Load or generate JWT secret
  if (existsSync(AUTH_FILE)) {
    try {
      const data = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
      jwtSecret = data.jwtSecret;
    } catch {}
  }
  if (!jwtSecret) {
    const { randomBytes } = await import('crypto');
    jwtSecret = randomBytes(64).toString('hex');
    writeFileSync(AUTH_FILE, JSON.stringify({ jwtSecret }), { mode: 0o600 });
  }

  passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
}

export async function login(
  password: string,
  ip: string
): Promise<{ token: string } | { error: string; status: number }> {
  // Check rate limit from SQLite
  const recentAttempts = rateLimit.countRecent(ip, WINDOW_SECONDS);
  if (recentAttempts >= MAX_ATTEMPTS) {
    return { error: 'Too many login attempts. Try again later.', status: 429 };
  }

  // Record this attempt
  rateLimit.record(ip);

  const valid = await bcrypt.compare(password, passwordHash);
  if (!valid) {
    return { error: 'Invalid password', status: 401 };
  }

  // Periodically clean up old attempts
  rateLimit.cleanup();

  const token = jwt.sign({ user: 'admin' }, jwtSecret, { expiresIn: JWT_EXPIRY });
  return { token };
}

export function verifyToken(token: string): Record<string, unknown> | null {
  try {
    return jwt.verify(token, jwtSecret) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    res.status(403).json({ error: 'Invalid token' });
    return;
  }

  // Auto-refresh: if past halfway, issue new token
  if (decoded.exp && decoded.iat) {
    const now = Math.floor(Date.now() / 1000);
    const halfLife = ((decoded.exp as number) - (decoded.iat as number)) / 2;
    if (now > (decoded.iat as number) + halfLife) {
      const newToken = jwt.sign({ user: 'admin' }, jwtSecret, { expiresIn: JWT_EXPIRY });
      res.setHeader('X-Refreshed-Token', newToken);
    }
  }

  (req as Request & { user: Record<string, unknown> }).user = decoded;
  next();
}

export function verifyWebSocketToken(token: string): boolean {
  return verifyToken(token) !== null;
}
