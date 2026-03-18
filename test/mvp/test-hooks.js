#!/usr/bin/env node
/**
 * MVP Test 1: Hook Delivery
 *
 * Validates that Claude Code HTTP hooks reach our server with correct data.
 *
 * Steps:
 * 1. Start Express server on port 3457 (avoid conflict with main server)
 * 2. Temporarily add hooks to ~/.claude/settings.local.json
 * 3. Run: claude -p "read the file package.json" --verbose --output-format json
 * 4. Collect all hook POSTs received
 * 5. Assert: PreToolUse, PostToolUse, Stop received with correct data
 * 6. Restore settings
 */

import express from 'express';
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const PORT = 3457;
const SETTINGS_PATH = join(process.env.HOME, '.claude', 'settings.local.json');
const PROJECT_DIR = join(import.meta.dirname, '..', '..');
const TIMEOUT_MS = 60000;

// Event log
const events = [];
const startTime = Date.now();

function log(source, type, data = {}) {
  const elapsed = Date.now() - startTime;
  const entry = { elapsed, source, type, ...data };
  events.push(entry);
  console.log(`  T+${String(elapsed).padStart(6)}ms  ${source.padEnd(8)}  ${type}  ${JSON.stringify(data).substring(0, 120)}`);
}

async function main() {
  console.log('\n=== MVP Test 1: Hook Delivery ===\n');

  // Backup existing settings
  let settingsBackup = null;
  if (existsSync(SETTINGS_PATH)) {
    settingsBackup = readFileSync(SETTINGS_PATH, 'utf-8');
    console.log('Backed up existing settings.local.json');
  }

  // Write hook configuration
  const hookConfig = {
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{ type: 'http', url: `http://localhost:${PORT}/hooks/pre-tool-use`, timeout: 10 }]
      }],
      PostToolUse: [{
        matcher: '*',
        hooks: [{ type: 'http', url: `http://localhost:${PORT}/hooks/post-tool-use`, timeout: 10 }]
      }],
      Stop: [{
        hooks: [{ type: 'http', url: `http://localhost:${PORT}/hooks/stop`, timeout: 10 }]
      }]
    }
  };

  writeFileSync(SETTINGS_PATH, JSON.stringify(hookConfig, null, 2));
  console.log(`Wrote hook config to ${SETTINGS_PATH}`);

  // Start Express server
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.post('/hooks/pre-tool-use', (req, res) => {
    log('HOOK', 'PreToolUse', {
      tool_name: req.body.tool_name,
      session_id: req.body.session_id?.substring(0, 8),
      has_tool_input: !!req.body.tool_input,
      has_tool_use_id: !!req.body.tool_use_id
    });
    res.json({});
  });

  app.post('/hooks/post-tool-use', (req, res) => {
    log('HOOK', 'PostToolUse', {
      tool_name: req.body.tool_name,
      session_id: req.body.session_id?.substring(0, 8),
      has_tool_response: !!req.body.tool_response
    });
    res.json({});
  });

  app.post('/hooks/stop', (req, res) => {
    log('HOOK', 'Stop', {
      session_id: req.body.session_id?.substring(0, 8),
    });
    res.json({});
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => {
      console.log(`Hook server listening on port ${PORT}`);
      resolve(s);
    });
  });

  try {
    // Run Claude CLI with a prompt that triggers tool use
    console.log('\nRunning: claude -p "read the file package.json and tell me the project name" ...\n');
    console.log('--- Event Timeline ---');

    const claudeProcess = spawn('claude', [
      '-p', 'Read the file package.json in the current directory and tell me what the "name" field is. Be brief.',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--no-session-persistence'
    ], {
      cwd: PROJECT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: true
    });

    let stdout = '';
    let stderr = '';

    claudeProcess.stdout.on('data', (data) => { stdout += data.toString(); });
    claudeProcess.stderr.on('data', (data) => { stderr += data.toString(); });

    // Wait for process to finish or timeout
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        claudeProcess.kill();
        reject(new Error('Claude process timed out'));
      }, TIMEOUT_MS);

      claudeProcess.on('close', (code) => {
        clearTimeout(timeout);
        log('CLAUDE', 'exit', { code });
        resolve();
      });

      claudeProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Parse Claude output
    try {
      const result = JSON.parse(stdout);
      log('RESULT', 'response', {
        session_id: result.session_id?.substring(0, 8),
        result_length: result.result?.length,
      });
    } catch {
      log('RESULT', 'raw', { length: stdout.length, preview: stdout.substring(0, 100) });
    }

    // Wait a moment for any trailing hooks
    await new Promise(r => setTimeout(r, 2000));

    // Analyze results
    console.log('\n--- Results ---\n');

    const preToolUseEvents = events.filter(e => e.type === 'PreToolUse');
    const postToolUseEvents = events.filter(e => e.type === 'PostToolUse');
    const stopEvents = events.filter(e => e.type === 'Stop');

    const checks = [
      {
        name: 'PreToolUse hook received',
        pass: preToolUseEvents.length > 0,
        detail: `${preToolUseEvents.length} event(s): ${preToolUseEvents.map(e => e.tool_name).join(', ')}`
      },
      {
        name: 'PreToolUse has tool_name',
        pass: preToolUseEvents.every(e => !!e.tool_name),
        detail: preToolUseEvents.map(e => e.tool_name).join(', ')
      },
      {
        name: 'PreToolUse has session_id',
        pass: preToolUseEvents.every(e => !!e.session_id),
        detail: preToolUseEvents[0]?.session_id || 'N/A'
      },
      {
        name: 'PreToolUse has tool_input',
        pass: preToolUseEvents.every(e => e.has_tool_input),
        detail: ''
      },
      {
        name: 'PostToolUse hook received',
        pass: postToolUseEvents.length > 0,
        detail: `${postToolUseEvents.length} event(s): ${postToolUseEvents.map(e => e.tool_name).join(', ')}`
      },
      {
        name: 'PostToolUse has tool_response',
        pass: postToolUseEvents.every(e => e.has_tool_response),
        detail: ''
      },
      {
        name: 'Stop hook received',
        pass: stopEvents.length > 0,
        detail: `${stopEvents.length} event(s)`
      },
      {
        name: 'PreToolUse before PostToolUse',
        pass: preToolUseEvents.length > 0 && postToolUseEvents.length > 0 &&
              preToolUseEvents[0].elapsed < postToolUseEvents[0].elapsed,
        detail: preToolUseEvents.length > 0 && postToolUseEvents.length > 0
          ? `Pre: T+${preToolUseEvents[0].elapsed}ms, Post: T+${postToolUseEvents[0].elapsed}ms`
          : 'N/A'
      },
      {
        name: 'Stop after PostToolUse',
        pass: stopEvents.length > 0 && postToolUseEvents.length > 0 &&
              stopEvents[stopEvents.length - 1].elapsed >= postToolUseEvents[postToolUseEvents.length - 1].elapsed,
        detail: stopEvents.length > 0 && postToolUseEvents.length > 0
          ? `Post: T+${postToolUseEvents[postToolUseEvents.length - 1].elapsed}ms, Stop: T+${stopEvents[stopEvents.length - 1].elapsed}ms`
          : 'N/A'
      },
    ];

    let allPass = true;
    for (const check of checks) {
      const icon = check.pass ? '✓' : '✗';
      console.log(`  ${icon} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
      if (!check.pass) allPass = false;
    }

    console.log(`\n${allPass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);

    if (stderr && !allPass) {
      console.log('Claude stderr (first 500 chars):');
      console.log(stderr.substring(0, 500));
    }

    return allPass;

  } finally {
    // Cleanup
    server.close();

    if (settingsBackup) {
      writeFileSync(SETTINGS_PATH, settingsBackup);
      console.log('Restored settings.local.json backup');
    } else {
      try { unlinkSync(SETTINGS_PATH); } catch {}
      console.log('Removed temporary settings.local.json');
    }
  }
}

main()
  .then(pass => process.exit(pass ? 0 : 1))
  .catch(err => {
    console.error('Test error:', err);
    // Cleanup settings on error
    try { unlinkSync(SETTINGS_PATH); } catch {}
    process.exit(1);
  });
