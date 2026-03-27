#!/usr/bin/env node
/**
 * End-to-End Verification Test
 *
 * Tests the full pipeline: Server → WS → tmux → Claude → hooks → JSONL → WS
 *
 * Captures a millisecond-precision timeline of ALL events and validates:
 * 1. Event ordering (thinking → text-delta → tool events → message-complete → turn-complete)
 * 2. Bidirectional sync (Desktop tmux ↔ Mobile WS)
 * 3. Hook delivery (tool-start, tool-done from HTTP hooks)
 * 4. JSONL-based messages (message-complete)
 * 5. Streaming text preview (text-delta from pane capture)
 */

import { spawn } from 'child_process';
import WebSocket from 'ws';
import { readFileSync } from 'fs';
import { join } from 'path';

const PORT = 3458; // Avoid conflict with main server
const PASSWORD = 'test-e2e-' + Date.now();
const PROJECT_DIR = join(import.meta.dirname, '..', '..');

const events = [];
const startTime = Date.now();

function log(source, type, data = '') {
  const elapsed = Date.now() - startTime;
  const entry = { elapsed, source, type, data: typeof data === 'object' ? JSON.stringify(data).substring(0, 150) : String(data).substring(0, 150) };
  events.push(entry);
  const dataStr = entry.data ? ` ${entry.data}` : '';
  console.log(`  T+${String(elapsed).padStart(6)}ms  ${source.padEnd(8)}  ${type.padEnd(20)}${dataStr}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getToken() {
  const res = await fetch(`http://localhost:${PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const data = await res.json();
  return data.token;
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(token)}`);
    ws.on('open', () => {
      log('WS', 'connected');
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

async function main() {
  console.log('\n=== End-to-End Verification Test ===\n');

  // 1. Start server
  console.log('Starting server...');
  const serverProcess = spawn('node', ['server/index.js'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: String(PORT), CLAWTAP_PASSWORD: PASSWORD },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let serverReady = false;
  serverProcess.stdout.on('data', (d) => {
    const text = d.toString();
    if (text.includes('running on')) serverReady = true;
  });
  serverProcess.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text) console.error(`  [server stderr] ${text.substring(0, 200)}`);
  });

  // Wait for server ready
  for (let i = 0; i < 30; i++) {
    if (serverReady) break;
    await sleep(500);
  }
  if (!serverReady) {
    console.error('Server failed to start');
    serverProcess.kill();
    process.exit(1);
  }
  log('SERVER', 'ready');

  try {
    // 2. Authenticate
    const token = await getToken();
    log('AUTH', 'token_received');

    // 3. Connect WebSocket
    const ws = await connectWs(token);
    const wsMessages = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      wsMessages.push(msg);
      log('WS_RECV', msg.type, msg.type === 'text-delta' ? `"${(msg.text || '').substring(0, 80)}..."` :
        msg.type === 'message-complete' ? `${msg.messages?.length || 0} messages` :
        msg.type === 'tool-start' ? `${msg.toolName}` :
        msg.type === 'tool-done' ? `${msg.toolName}` :
        msg.type === 'thinking' ? msg.text :
        msg.type === 'turn-complete' ? 'ready' :
        msg.type === 'session-created' ? msg.sessionId :
        msg.type === 'tool-updates' ? `${Object.keys(msg.tools || {}).length} tools` :
        '');
    });

    // 4. Send a query that triggers tool use
    const testPrompt = 'Read the file package.json and tell me just the "name" field. Be very brief, one sentence.';
    log('SEND', 'query', testPrompt.substring(0, 60));
    ws.send(JSON.stringify({
      type: 'query',
      prompt: testPrompt,
      options: { cwd: PROJECT_DIR },
    }));

    // 5. Wait for response (up to 90 seconds)
    let turnComplete = false;
    const maxWait = 90000;
    const waitStart = Date.now();

    while (!turnComplete && Date.now() - waitStart < maxWait) {
      await sleep(500);
      turnComplete = wsMessages.some(m => m.type === 'turn-complete');
      // Also check for message-complete as a fallback signal
      if (!turnComplete && Date.now() - waitStart > 60000) {
        turnComplete = wsMessages.some(m => m.type === 'message-complete');
      }
    }

    if (!turnComplete) {
      log('TIMEOUT', 'no_turn_complete', `waited ${maxWait}ms`);
    }

    // Wait a bit more for any trailing events
    await sleep(2000);

    ws.close();
    log('WS', 'disconnected');

    // 6. Analyze results
    console.log('\n\n=== Analysis ===\n');

    const sessionCreated = wsMessages.find(m => m.type === 'session-created');
    const textDeltas = wsMessages.filter(m => m.type === 'text-delta');
    const thinkingMsgs = wsMessages.filter(m => m.type === 'thinking');
    const toolStarts = wsMessages.filter(m => m.type === 'tool-start');
    const toolDones = wsMessages.filter(m => m.type === 'tool-done');
    const messageCompletes = wsMessages.filter(m => m.type === 'message-complete');
    const turnCompletes = wsMessages.filter(m => m.type === 'turn-complete');
    const toolUpdates = wsMessages.filter(m => m.type === 'tool-updates');
    const errors = wsMessages.filter(m => m.type === 'error');

    console.log('Event counts:');
    console.log(`  session-created:   ${sessionCreated ? 1 : 0}`);
    console.log(`  thinking:          ${thinkingMsgs.length}`);
    console.log(`  text-delta:        ${textDeltas.length}`);
    console.log(`  tool-start:        ${toolStarts.length} (${toolStarts.map(m => m.toolName).join(', ')})`);
    console.log(`  tool-done:         ${toolDones.length} (${toolDones.map(m => m.toolName).join(', ')})`);
    console.log(`  tool-updates:      ${toolUpdates.length}`);
    console.log(`  message-complete:  ${messageCompletes.length}`);
    console.log(`  turn-complete:     ${turnCompletes.length}`);
    console.log(`  errors:            ${errors.length} ${errors.map(m => m.error).join(', ')}`);

    console.log('\n--- Checks ---\n');
    const checks = [
      { name: 'Session created', pass: !!sessionCreated },
      { name: 'Got thinking or text-delta (streaming)', pass: thinkingMsgs.length > 0 || textDeltas.length > 0 },
      { name: 'Tool start received (hooks working)', pass: toolStarts.length > 0 },
      { name: 'Tool done received (hooks working)', pass: toolDones.length > 0 },
      { name: 'Tool start before tool done', pass: toolStarts.length > 0 && toolDones.length > 0 &&
          events.findIndex(e => e.type === 'tool-start') < events.findIndex(e => e.type === 'tool-done') },
      { name: 'Message complete received (JSONL working)', pass: messageCompletes.length > 0 },
      { name: 'Turn complete received (Stop hook)', pass: turnCompletes.length > 0 },
      { name: 'No errors', pass: errors.length === 0 },
      { name: 'Message complete before turn complete', pass:
          messageCompletes.length > 0 && turnCompletes.length > 0 &&
          events.findIndex(e => e.type === 'message-complete') < events.findIndex(e => e.type === 'turn-complete') },
    ];

    let allPass = true;
    for (const c of checks) {
      console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}`);
      if (!c.pass) allPass = false;
    }

    // Show message content if available
    if (messageCompletes.length > 0) {
      const lastMsg = messageCompletes[messageCompletes.length - 1];
      const textContent = lastMsg.messages?.flatMap(m =>
        (m.content || []).filter(b => b.type === 'text').map(b => b.text)
      ).join(' ');
      if (textContent) {
        console.log(`\n  Response: "${textContent.substring(0, 200)}"`);
      }
    }

    console.log(`\n${allPass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);
    return allPass;

  } finally {
    serverProcess.kill();
    await sleep(1000);
  }
}

main()
  .then(pass => process.exit(pass ? 0 : 1))
  .catch(err => {
    console.error('Test error:', err);
    process.exit(1);
  });
