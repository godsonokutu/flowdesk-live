'use strict';
const { Pool } = require('pg');
const { PgLifecycleOutboxWorker } = require('../src/lifecycle.outbox.pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const pollMs = Number(process.env.LIFECYCLE_POLL_MS || 250);
const concurrency = Number(process.env.LIFECYCLE_WORKER_CONCURRENCY || 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
  throw new Error('LIFECYCLE_WORKER_CONCURRENCY must be 1-32');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Math.max(concurrency + 2, 6),
  statement_timeout: 15000,
  application_name: 'flowdesk-lifecycle-worker',
});

let stopping = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loop(index) {
  const worker = new PgLifecycleOutboxWorker({ pool });
  while (!stopping) {
    try {
      const result = await worker.processNext();
      if (result.outcome === 'idle') await sleep(pollMs);
      if (result.outcome === 'dead_letter') {
        console.error(JSON.stringify({ level: 'error', worker: index, ...result }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        worker: index,
        code: error.code || 'WORKER_LOOP_ERROR',
        message: error.message,
      }));
      await sleep(Math.min(5000, pollMs * 4));
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', signal, message: 'worker shutdown requested' }));
  await pool.end();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

Promise.all(Array.from({ length: concurrency }, (_, i) => loop(i + 1)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
