#!/usr/bin/env node
/**
 * MVP Test 2: JSONL Watcher with fs.watch()
 *
 * Validates that fs.watch() + byte-offset reading reliably detects new JSONL entries.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
const TEST_FILE = path.join(TEMP_DIR, 'test.jsonl');

class ImprovedJsonlWatcher {
  constructor(filePath) {
    this.filePath = filePath;
    this.lastByteOffset = 0;
    this._onEntries = null;
    this._fsWatcher = null;
    this._fallbackInterval = null;
  }

  start({ skipExisting = false } = {}) {
    if (skipExisting) {
      try { this.lastByteOffset = fs.statSync(this.filePath).size; } catch {}
    }

    // Primary: fs.watch() for instant notification
    this._fsWatcher = fs.watch(this.filePath, (event) => {
      // console.log(`  [dbg]fs.watch event: ${event}, calling poll`);
      this._poll();
    });

    // Fallback: poll every 2s
    this._fallbackInterval = setInterval(() => this._poll(), 2000);

    // Initial poll
    this._poll();
  }

  stop() {
    if (this._fsWatcher) { this._fsWatcher.close(); this._fsWatcher = null; }
    if (this._fallbackInterval) { clearInterval(this._fallbackInterval); this._fallbackInterval = null; }
  }

  onNewEntries(cb) { this._onEntries = cb; }
  pollNow() { this._poll(); }

  _poll() {
    try {
      const stats = fs.statSync(this.filePath);
      // console.log(`  [dbg]poll: size=${stats.size} offset=${this.lastByteOffset}`);
      if (stats.size <= this.lastByteOffset) return;

      const newSize = stats.size - this.lastByteOffset;
      const buffer = Buffer.alloc(newSize);
      const fd = fs.openSync(this.filePath, 'r');
      fs.readSync(fd, buffer, 0, newSize, this.lastByteOffset);
      fs.closeSync(fd);

      const text = buffer.toString('utf-8');
      const lines = text.split('\n');
      // Remove trailing empty string from split (artifact of text ending with \n)
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

      const entries = [];
      let bytesConsumed = 0;

      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');
        if (!line.trim()) { bytesConsumed += lineBytes; continue; }
        try {
          entries.push(JSON.parse(line));
          bytesConsumed += lineBytes;
        } catch {
          break; // partial line — don't advance offset, retry next poll
        }
      }

      this.lastByteOffset += bytesConsumed;
      if (entries.length > 0 && this._onEntries) this._onEntries(entries);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Poll error:', err.message);
    }
  }
}

async function main() {
  console.log('\n=== MVP Test 2: JSONL Watcher with fs.watch() ===\n');

  fs.writeFileSync(TEST_FILE, '');

  const watcher = new ImprovedJsonlWatcher(TEST_FILE);
  const detections = [];
  const appends = [];
  const startTime = Date.now();

  watcher.onNewEntries((entries) => {
    for (const entry of entries) {
      detections.push({ elapsed: Date.now() - startTime, id: entry.id, latency: Date.now() - entry.t });
    }
  });

  watcher.start();

  // Append entries at various delays
  const appendAt = [100, 250, 500, 800, 1200, 1700, 2300, 3000];
  for (const t of appendAt) {
    await new Promise(r => setTimeout(r, t - (appends.length > 0 ? appendAt[appends.length - 1] : 0)));
    const now = Date.now();
    fs.appendFileSync(TEST_FILE, JSON.stringify({ id: appends.length, t: now }) + '\n');
    appends.push({ id: appends.length, elapsed: now - startTime });
  }

  await new Promise(r => setTimeout(r, 2500));

  // Test partial JSON line
  console.log('Testing partial JSON handling...');
  const partial = JSON.stringify({ id: 99, t: Date.now() });
  fs.appendFileSync(TEST_FILE, partial.substring(0, 20)); // Write half
  await new Promise(r => setTimeout(r, 500));
  const beforeCount = detections.length;
  fs.appendFileSync(TEST_FILE, partial.substring(20) + '\n'); // Complete it
  await new Promise(r => setTimeout(r, 2500));

  watcher.stop();

  // Print timeline
  console.log('\n--- Event Timeline ---\n');
  for (const a of appends) {
    const d = detections.find(d => d.id === a.id);
    const status = d ? `detected T+${String(d.elapsed).padStart(5)}ms (latency: ${d.latency}ms)` : 'NOT DETECTED';
    console.log(`  Entry ${a.id}: appended T+${String(a.elapsed).padStart(5)}ms → ${status}`);
  }
  const pd = detections.find(d => d.id === 99);
  console.log(`  Entry 99 (partial): ${pd ? `detected (latency: ${pd.latency}ms)` : 'NOT DETECTED'}`);

  // Validate
  console.log('\n--- Results ---\n');
  const allDetected = appends.every(a => detections.some(d => d.id === a.id));
  const noDups = new Set(detections.map(d => d.id)).size === detections.length;
  const lats = detections.filter(d => d.id !== 99).map(d => d.latency);
  const avg = lats.length ? Math.round(lats.reduce((a, b) => a + b) / lats.length) : -1;
  const max = lats.length ? Math.max(...lats) : -1;

  const checks = [
    { name: 'All entries detected', pass: allDetected, detail: `${detections.filter(d => d.id !== 99).length}/${appends.length}` },
    { name: 'No duplicates', pass: noDups, detail: `${detections.length} unique` },
    { name: 'Avg latency < 200ms', pass: avg >= 0 && avg < 200, detail: `avg=${avg}ms max=${max}ms` },
    { name: 'Partial JSON handled', pass: !!pd, detail: pd ? `latency=${pd.latency}ms` : 'missed' },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`);
    if (!c.pass) allPass = false;
  }

  console.log(`\n${allPass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);
  try { fs.unlinkSync(TEST_FILE); } catch {}
  return allPass;
}

main().then(p => process.exit(p ? 0 : 1)).catch(e => { console.error(e); process.exit(1); });
