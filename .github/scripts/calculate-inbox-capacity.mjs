#!/usr/bin/env node

const numberFromEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

const producerRps = numberFromEnv('INBOX_QUEUE_PRODUCER_RPS', 5_000);
const backlogBytes = numberFromEnv('INBOX_QUEUE_BACKLOG_BYTES', 25_000_000_000);
const averageMessageBytes = numberFromEnv('INBOX_CAPACITY_AVG_MESSAGE_BYTES', 16_384);
const p95ProcessMs = numberFromEnv('INBOX_CAPACITY_P95_PROCESS_MS');
const effectiveConcurrency = numberFromEnv('INBOX_CAPACITY_EFFECTIVE_CONCURRENCY');
const safetyRatio = numberFromEnv('INBOX_CAPACITY_SAFETY_RATIO', 0.8);
const targetRps = numberFromEnv('INBOX_CAPACITY_TARGET_RPS');
const burstRps = numberFromEnv('INBOX_CAPACITY_BURST_RPS', targetRps);

if (safetyRatio <= 0 || safetyRatio >= 1) throw new Error('INBOX_CAPACITY_SAFETY_RATIO must be between 0 and 1');
if (p95ProcessMs == null || effectiveConcurrency == null || targetRps == null) {
  throw new Error(
    'Measured INBOX_CAPACITY_P95_PROCESS_MS, INBOX_CAPACITY_EFFECTIVE_CONCURRENCY, and INBOX_CAPACITY_TARGET_RPS are required',
  );
}

const hardProducerRps = producerRps;
const measuredDrainRps = effectiveConcurrency * 1_000 / p95ProcessMs;
const sustainableRps = Math.min(hardProducerRps, measuredDrainRps);
const safeAdmissionRps = Math.floor(sustainableRps * safetyRatio);
const estimatedBacklogMessages = Math.floor(backlogBytes / averageMessageBytes);
const growthRps = Math.max(0, burstRps - measuredDrainRps);
const secondsToBacklogFull = growthRps > 0 ? estimatedBacklogMessages / growthRps : null;

const report = {
  inputs: {
    queueCount: 1,
    producerRps,
    averageMessageBytes,
    p95ProcessMs,
    effectiveConcurrency,
    safetyRatio,
    targetRps,
    burstRps,
  },
  limits: {
    hardProducerRps,
    measuredDrainRps: Math.floor(measuredDrainRps),
    sustainableRps: Math.floor(sustainableRps),
    safeAdmissionRps,
    backlogBytes,
    estimatedBacklogMessages,
    secondsToBacklogFull: secondsToBacklogFull == null ? null : Math.floor(secondsToBacklogFull),
  },
  pass: targetRps <= safeAdmissionRps,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) {
  process.stderr.write(
    `Inbox capacity gate failed: target ${targetRps}/s exceeds safe measured admission ${safeAdmissionRps}/s.\n`,
  );
  process.exitCode = 1;
}
