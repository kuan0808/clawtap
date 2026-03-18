import fs from 'fs';
import path from 'path';
import os from 'os';

const CLAWTAP_DIR = path.join(os.homedir(), '.clawtap');

export interface AppConfig {
  password: string;
  port: number;
  clawtapDir: string;
  https: { cert: Buffer; key: Buffer } | null;
  transcription: { provider: 'whisper'; apiKey: string } | null;
  gitBranch: string;
  paths: {
    auth: string;
    vapidKeys: string;
    pushSubs: string;
    pid: string;
    uploads: string;
    db: string;
  };
}

export function loadConfig(): AppConfig {
  const password = process.env.CLAUDE_UI_PASSWORD;
  if (!password) {
    throw new Error(
      'CLAUDE_UI_PASSWORD is required.\n' +
      'Set it and try again:\n' +
      '  export CLAUDE_UI_PASSWORD=your-password'
    );
  }

  const port = parseInt(process.env.PORT || '', 10) || 3456;

  const certPath = path.join(CLAWTAP_DIR, 'cert.pem');
  const keyPath = path.join(CLAWTAP_DIR, 'key.pem');
  const httpsConfig = (fs.existsSync(certPath) && fs.existsSync(keyPath))
    ? { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }
    : null;

  const transcription = process.env.OPENAI_API_KEY
    ? { provider: 'whisper' as const, apiKey: process.env.OPENAI_API_KEY }
    : null;

  const config: AppConfig = {
    password,
    port,
    clawtapDir: CLAWTAP_DIR,
    https: httpsConfig,
    transcription,
    gitBranch: process.env.GIT_BRANCH || 'unknown',
    paths: {
      auth: path.join(os.homedir(), '.clawtap-auth.json'),
      vapidKeys: path.join(CLAWTAP_DIR, 'vapid-keys.json'),
      pushSubs: path.join(CLAWTAP_DIR, 'push-subscriptions.json'),
      pid: path.join(CLAWTAP_DIR, 'server.pid'),
      uploads: path.join(os.tmpdir(), 'clawtap-uploads'),
      db: path.join(CLAWTAP_DIR, 'clawtap.db'),
    },
  };

  printFeatureStatus(config);
  return config;
}

function printFeatureStatus(config: AppConfig): void {
  const features: [string, string][] = [
    ['HTTPS', config.https ? '✓ enabled' : '✗ disabled (no certs)'],
    ['Voice Transcription', config.transcription ? `✓ ${config.transcription.provider}` : '✗ disabled (no OPENAI_API_KEY)'],
    ['Port', String(config.port)],
  ];

  console.log('\n  ClawTap Configuration:');
  for (const [name, status] of features) {
    console.log(`    ${name}: ${status}`);
  }
  console.log('');
}
