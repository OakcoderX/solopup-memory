/** Shared durable state for both dream executors. Never store raw evidence here. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const APPLICATION_ID = 0x53504452
const SCHEMA_VERSION = 3
const MODES = ['ordinary', 'superagent']
const ACTIVE = "'prepared', 'dispatching', 'running', 'uncertain'"
const MAX_RUNS = 10_000
const DAY_MS = 86_400_000
const EXECUTOR_REQUEST_SCHEMA = `
CREATE TABLE executor_request (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ordinary', 'superagent')),
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  reason TEXT
) STRICT;
`

const SCHEMA = `
CREATE TABLE settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('ordinary', 'superagent')),
  pending_mode TEXT CHECK (pending_mode IN ('ordinary', 'superagent') AND pending_mode <> mode),
  epoch INTEGER NOT NULL CHECK (epoch >= 1)
) STRICT;
INSERT INTO settings VALUES (1, 'ordinary', NULL, 1);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  checkpoint TEXT,
  metadata TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'prepared', 'dispatching', 'running', 'uncertain',
    'completed', 'failed', 'invalidated', 'cancelled'
  )),
  queued_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  mode TEXT CHECK (mode IN ('ordinary', 'superagent')),
  epoch INTEGER,
  manual INTEGER CHECK (manual IN (0, 1)),
  lease_until INTEGER,
  remote_id TEXT,
  remote_binding TEXT,
  reason TEXT
) STRICT;
CREATE UNIQUE INDEX one_active_run ON runs ((1)) WHERE status IN (${ACTIVE});
CREATE INDEX ready_runs ON runs (status, available_at, project_id);

CREATE TABLE attempts (
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt INTEGER NOT NULL,
  day TEXT NOT NULL,
  reserved INTEGER NOT NULL,
  used INTEGER,
  unsent INTEGER NOT NULL DEFAULT 0 CHECK (unsent IN (0, 1)),
  PRIMARY KEY (run_id, attempt)
) STRICT;
CREATE INDEX daily_attempts ON attempts (day, unsent);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  scan_checkpoint TEXT,
  last_auto_attempt_at INTEGER,
  last_completed_at INTEGER
) STRICT;

CREATE TABLE reports (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  payload TEXT NOT NULL,
  completed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE reviewed (
  project_id TEXT NOT NULL REFERENCES projects(id),
  item_key TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES reports(run_id),
  PRIMARY KEY (project_id, item_key)
) STRICT;
${EXECUTOR_REQUEST_SCHEMA}
`

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code) => { throw new Error(`dream-queue-${code}`) }

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`invalid-${name}`)
  return value
}

function identifier(value, name, max = 256) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > max ||
      /[\u0000-\u001f\u007f]/.test(value)) fail(`invalid-${name}`)
  return value
}

function boundedJson(value, name, maxBytes) {
  let encoded
  try { encoded = JSON.stringify(value) } catch { fail(`invalid-${name}`) }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maxBytes) fail(`invalid-${name}`)
  return encoded
}

function itemKeys(value) {
  if (!Array.isArray(value) || value.length > 5 || new Set(value).size !== value.length) fail('invalid-item-keys')
  for (const item of value) identifier(item, 'item-key')
  return value
}

function projectFilter(projectIds) {
  if (projectIds === undefined) return null
  if (!Array.isArray(projectIds) || projectIds.length > 16 || new Set(projectIds).size !== projectIds.length) fail('invalid-project-filter')
  for (const id of projectIds) identifier(id, 'project-id')
  return JSON.stringify(projectIds)
}

function inspectFile(path) {
  let info
  try { info = lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077)) fail('unsafe-database-file')
  return info
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* Preserve the failure that aborted the transaction. */ }
    throw error
  }
}

function openDatabase(dataRoot, existingOnly) {
  const dataPath = resolve(dataRoot)
  let parent
  try { parent = realpathSync(dirname(dataPath)) } catch (error) {
    if (existingOnly && error.code === 'ENOENT') fail('not-initialized')
    throw error
  }
  const dir = join(parent, `${basename(dataPath)}.dream`)
  if (!existingOnly) {
    try { mkdirSync(dir, { mode: 0o700 }) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  let dirInfo
  try { dirInfo = lstatSync(dir) } catch (error) {
    if (existingOnly && error.code === 'ENOENT') fail('not-initialized')
    throw error
  }
  if (!dirInfo.isDirectory() || (dirInfo.mode & 0o077)) fail('unsafe-directory')
  const path = join(dir, 'state.sqlite')
  inspectFile(path + '-journal')
  if (inspectFile(path + '-wal') || inspectFile(path + '-shm')) fail('unexpected-journal-mode')
  if (!inspectFile(path)) {
    if (existingOnly) fail('not-initialized')
    try { closeSync(openSync(path, 'wx', 0o600)) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  const before = inspectFile(path)
  if (!before) fail('database-missing')
  const db = new DatabaseSync(path)
  try {
    const after = inspectFile(path)
    if (!after || before.ino !== after.ino || before.dev !== after.dev) fail('database-changed')
    db.exec('PRAGMA busy_timeout=750; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;')
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') fail('unexpected-journal-mode')
    transaction(db, () => {
      const appId = db.prepare('PRAGMA application_id').get().application_id
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (appId === APPLICATION_ID && version === SCHEMA_VERSION) return
      if (existingOnly) fail('not-initialized')
      if (appId === APPLICATION_ID && [1, 2].includes(version)) {
        if (version === 1) db.exec(EXECUTOR_REQUEST_SCHEMA)
        db.exec('ALTER TABLE runs ADD COLUMN remote_binding TEXT')
        db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
        return
      }
      if (appId || version || db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        fail('incompatible-database')
      }
      db.exec(SCHEMA)
      db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`)
    })
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function publicRun(row) {
  if (!row) return undefined
  return {
    runId: row.id,
    projectId: row.project_id,
    inputHash: row.input_hash,
    policyVersion: row.policy_version,
    checkpoint: row.checkpoint,
    metadata: JSON.parse(row.metadata),
    status: row.status,
    owner: row.owner,
    mode: row.mode,
    epoch: row.epoch,
    attempt: row.attempt,
    manual: row.manual === 1,
    leaseUntil: row.lease_until,
    remoteId: row.remote_id,
    remoteBinding: row.remote_binding === null ? null : JSON.parse(row.remote_binding),
    reason: row.reason
  }
}

/**
 * All handles for one memory root share execution rights and budget.
 * Evidence and report permissions are owned by the caller. Persist IDs only
 * in metadata and a validated, reference-only report in finish().
 */
export function openDreamQueue(dataRoot, {
  now = Date.now,
  maxDailyAttempts = 2,
  maxDailyTokens = 12_000,
  leaseMs = 195_000,
  autoIntervalMs = DAY_MS,
  maxRunDispatches = 3,
  existingOnly = false
} = {}) {
  integer(maxDailyAttempts, 1, 1000, 'daily-attempts')
  integer(maxDailyTokens, 1, 100_000_000, 'daily-tokens')
  integer(leaseMs, 1, 86_400_000, 'lease')
  integer(autoIntervalMs, 0, 604_800_000, 'auto-interval')
  integer(maxRunDispatches, 1, 100, 'run-dispatches')
  if (typeof existingOnly !== 'boolean') fail('invalid-existing-only')
  const db = openDatabase(dataRoot, existingOnly)
  const write = (fn) => transaction(db, fn)
  const settings = () => db.prepare('SELECT * FROM settings WHERE singleton=1').get()
  const runRow = (runId) => db.prepare('SELECT * FROM runs WHERE id=?').get(runId)
  const getRun = (runId) => publicRun(runRow(runId))
  const active = () => db.prepare(`SELECT * FROM runs WHERE status IN (${ACTIVE})`).get()
  const time = () => integer(now(), 0, 8_640_000_000_000_000 - 604_800_000, 'clock')
  const dayAt = (at) => new Date(at).toISOString().slice(0, 10)
  const budgetAt = (at) => {
    const day = dayAt(at)
    const row = db.prepare(`
      SELECT count(*) AS attempts, coalesce(sum(coalesce(used, reserved)), 0) AS tokens
      FROM attempts WHERE day=? AND unsent=0
    `).get(day)
    return { day, ...row, maxAttempts: maxDailyAttempts, maxTokens: maxDailyTokens }
  }

  function completeModeSwitch() {
    if (active()) return
    db.exec(`
      UPDATE settings SET mode=pending_mode, pending_mode=NULL, epoch=epoch+1
      WHERE singleton=1 AND pending_mode IS NOT NULL
    `)
  }

  function requeuePrepared(row, reason) {
    db.prepare(`
      UPDATE runs SET status='queued', owner=NULL, mode=NULL, epoch=NULL, manual=NULL,
        lease_until=NULL, remote_id=NULL, remote_binding=NULL, reason=?
      WHERE id=? AND status='prepared'
    `).run(reason, row.id)
  }

  function recoverExpired(at) {
    const row = active()
    if (row && row.lease_until !== null && row.lease_until <= at) {
      if (row.status === 'prepared') requeuePrepared(row, 'prepare-lease-expired')
      else {
        db.prepare(`
          UPDATE runs SET status='uncertain', lease_until=NULL, reason='dispatch-lease-expired'
          WHERE id=?
        `).run(row.id)
      }
    }
    completeModeSwitch()
  }

  function matchingClaim(claim, statuses) {
    if (!claim || typeof claim.runId !== 'string') return undefined
    const row = runRow(claim.runId)
    if (!row || !statuses.includes(row.status) || row.owner !== claim.owner ||
        row.attempt !== claim.attempt || row.mode !== claim.mode || row.epoch !== claim.epoch ||
        row.input_hash !== claim.inputHash) return undefined
    return row
  }

  function usageFor(row) {
    return db.prepare('SELECT * FROM attempts WHERE run_id=? AND attempt=?').get(row.id, row.attempt)
  }

  function updateUsage(row, usedTokens, confirmedUnsent) {
    db.prepare('UPDATE attempts SET used=?, unsent=? WHERE run_id=? AND attempt=?')
      .run(usedTokens ?? null, Number(confirmedUnsent), row.id, row.attempt)
  }

  function executorRequest() {
    return db.prepare(`
      SELECT id, mode, requested_at AS requestedAt, status, reason
      FROM executor_request WHERE singleton=1
    `).get()
  }

  function status() {
    db.exec('BEGIN')
    try {
      const config = settings()
      const counts = Object.fromEntries(db.prepare('SELECT status, count(*) AS n FROM runs GROUP BY status')
        .all().map((row) => [row.status, row.n]))
      const state = {
        mode: config.mode,
        pendingMode: config.pending_mode,
        epoch: config.epoch,
        executorRequest: executorRequest(),
        active: publicRun(active()),
        counts,
        budget: budgetAt(time())
      }
      db.exec('COMMIT')
      return state
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* Preserve the read failure. */ }
      throw error
    }
  }

  function nextAutomaticAt({ reservedTokens = 1, projectIds } = {}) {
    integer(reservedTokens, 1, 100_000_000, 'reserved-tokens')
    const projectList = projectFilter(projectIds)
    if (reservedTokens > maxDailyTokens) return undefined
    const row = active()
    if (row) return row.lease_until ?? undefined
    if (settings().pending_mode !== null) return undefined
    const pending = db.prepare(`
      SELECT min(max(runs.available_at, coalesce(projects.last_auto_attempt_at + ?, 0))) AS ready_at
      FROM runs JOIN projects ON projects.id=runs.project_id WHERE runs.status='queued'
        AND (? IS NULL OR runs.project_id IN (SELECT value FROM json_each(?)))
    `).get(autoIntervalMs, projectList, projectList)
    if (pending.ready_at === null) return undefined
    const at = time()
    const budget = budgetAt(at)
    const nextBudget = budget.attempts >= maxDailyAttempts || budget.tokens + reservedTokens > maxDailyTokens
      ? (Math.floor(at / DAY_MS) + 1) * DAY_MS
      : at
    return Math.max(pending.ready_at, nextBudget)
  }

  function enqueue({ projectId, inputHash, policyVersion, checkpoint, metadata = {} }) {
    identifier(projectId, 'project-id')
    if (typeof inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(inputHash)) fail('invalid-input-hash')
    identifier(policyVersion, 'policy-version')
    if (checkpoint !== undefined && checkpoint !== null) identifier(checkpoint, 'checkpoint')
    if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') fail('invalid-metadata')
    if (metadata.itemKeys !== undefined) itemKeys(metadata.itemKeys)
    const encoded = boundedJson(metadata, 'metadata', 12 * 1024)
    const runId = digest([projectId, inputHash, policyVersion])
    return write(() => {
      const existing = getRun(runId)
      if (existing) {
        if (runRow(runId).metadata !== encoded) fail('input-metadata-mismatch')
        return existing
      }
      if (db.prepare('SELECT count(*) AS n FROM runs').get().n >= MAX_RUNS) fail('capacity')
      const at = time()
      db.prepare(`
        INSERT INTO projects (id, scan_checkpoint) VALUES (?,?)
        ON CONFLICT(id) DO UPDATE SET scan_checkpoint=coalesce(excluded.scan_checkpoint, projects.scan_checkpoint)
      `).run(projectId, checkpoint ?? null)
      db.prepare(`
        INSERT INTO runs(id,project_id,input_hash,policy_version,checkpoint,metadata,status,queued_at,available_at)
        VALUES (?,?,?,?,?,?,'queued',?,?)
      `).run(runId, projectId, inputHash, policyVersion, checkpoint ?? null, encoded, at, at)
      return getRun(runId)
    })
  }

  function claim({ owner, manual = false, projectId, projectIds, runId } = {}) {
    identifier(owner, 'owner')
    if (typeof manual !== 'boolean') fail('invalid-manual')
    if (projectId !== undefined) identifier(projectId, 'project-id')
    const projectList = projectFilter(projectIds)
    if (runId !== undefined) identifier(runId, 'run-id')
    return write(() => {
      const at = time()
      recoverExpired(at)
      const config = settings()
      if (config.pending_mode !== null || active()) return undefined
      const budget = budgetAt(at)
      if (budget.attempts >= maxDailyAttempts || budget.tokens >= maxDailyTokens) return undefined
      const row = db.prepare(`
        SELECT runs.id FROM runs JOIN projects ON projects.id=runs.project_id
        WHERE runs.status='queued' AND runs.available_at<=?
          AND (? IS NULL OR runs.project_id=?)
          AND (? IS NULL OR runs.project_id IN (SELECT value FROM json_each(?)))
          AND (? IS NULL OR runs.id=?)
          AND (? OR projects.last_auto_attempt_at IS NULL OR projects.last_auto_attempt_at<=?)
        ORDER BY coalesce(projects.last_completed_at, -1), runs.queued_at, runs.id
        LIMIT 1
      `).get(at, projectId ?? null, projectId ?? null, projectList, projectList, runId ?? null, runId ?? null,
        Number(manual), at - autoIntervalMs)
      if (!row) return undefined
      db.prepare(`
        UPDATE runs SET status='prepared', owner=?, mode=?, epoch=?, manual=?, attempt=attempt+1,
          lease_until=?, remote_id=NULL, remote_binding=NULL, reason=NULL WHERE id=?
      `).run(owner, config.mode, config.epoch, Number(manual), at + leaseMs, row.id)
      return getRun(row.id)
    })
  }

  function beginDispatch(claimValue, { reservedTokens } = {}) {
    integer(reservedTokens, 1, 100_000_000, 'reserved-tokens')
    return write(() => {
      const at = time()
      recoverExpired(at)
      const config = settings()
      const row = matchingClaim(claimValue, ['prepared'])
      if (!row || config.pending_mode !== null || row.epoch !== config.epoch) return undefined
      const budget = budgetAt(at)
      if (budget.attempts >= maxDailyAttempts || budget.tokens + reservedTokens > maxDailyTokens) return undefined
      db.prepare('INSERT INTO attempts (run_id, attempt, day, reserved) VALUES (?,?,?,?)')
        .run(row.id, row.attempt, budget.day, reservedTokens)
      if (row.manual === 0) db.prepare('UPDATE projects SET last_auto_attempt_at=? WHERE id=?')
        .run(at, row.project_id)
      db.prepare("UPDATE runs SET status='dispatching', lease_until=? WHERE id=?").run(at + leaseMs, row.id)
      return getRun(row.id)
    })
  }

  function markRunning(claimValue, { remoteId, binding } = {}) {
    if (remoteId !== undefined && remoteId !== null) identifier(remoteId, 'remote-id')
    return write(() => {
      recoverExpired(time())
      const row = matchingClaim(claimValue, ['dispatching', 'running'])
      if (!row || (row.remote_id !== null && row.remote_id !== remoteId)) return undefined
      let bindingJson = row.remote_binding
      if (binding !== undefined) {
        if (row.mode !== 'superagent' || !binding || binding.runId !== row.id || binding.attempt !== row.attempt ||
            binding.projectId !== row.project_id || !remoteId || binding.ticketId !== remoteId ||
            typeof binding.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(binding.inputDigest) ||
            (binding.workerSessionId !== undefined && binding.workerSessionId !== `worker-${remoteId}`)) fail('invalid-remote-binding')
        const normalized = {
          runId: row.id, attempt: row.attempt, projectId: row.project_id, inputDigest: binding.inputDigest,
          runtimeId: identifier(binding.runtimeId, 'runtime-id'), isolationId: identifier(binding.isolationId, 'isolation-id'),
          ticketId: remoteId, ...(binding.workerSessionId === undefined ? {} : { workerSessionId: binding.workerSessionId }),
        }
        if (bindingJson !== null && Object.entries(JSON.parse(bindingJson)).some(([key, value]) => normalized[key] !== value)) {
          fail('changed-remote-binding')
        }
        bindingJson = boundedJson(normalized, 'remote-binding', 4096)
      }
      db.prepare("UPDATE runs SET status='running', remote_id=?, remote_binding=? WHERE id=?")
        .run(remoteId ?? null, bindingJson, row.id)
      return getRun(row.id)
    })
  }

  function release(claimValue) {
    return write(() => {
      recoverExpired(time())
      const row = matchingClaim(claimValue, ['prepared'])
      if (!row) return undefined
      requeuePrepared(row, 'released-before-dispatch')
      completeModeSwitch()
      return getRun(row.id)
    })
  }

  // After dispatch, use a terminal outcome only when the executor returned a
  // terminal result or acknowledged cancellation. A lost reply is uncertain.
  function finish(claimValue, {
    status: outcome,
    report,
    reviewedItemKeys = [],
    usedTokens,
    confirmedUnsent = false,
    retryAfterMs = 60_000,
    reason
  } = {}) {
    if (!['completed', 'retryable', 'failed', 'invalidated', 'cancelled', 'uncertain'].includes(outcome)) fail('invalid-outcome')
    if (usedTokens !== undefined && usedTokens !== null) integer(usedTokens, 0, 100_000_000, 'used-tokens')
    if (typeof confirmedUnsent !== 'boolean' || (confirmedUnsent && (
      ['completed', 'uncertain'].includes(outcome) || (usedTokens ?? 0) !== 0
    ))) fail('invalid-unsent')
    if (reason !== undefined && reason !== null) identifier(reason, 'reason')
    integer(retryAfterMs, 0, 604_800_000, 'retry-delay')
    itemKeys(reviewedItemKeys)
    let payload
    if (outcome === 'completed') {
      if (!report || typeof report !== 'object' || Array.isArray(report)) fail('invalid-report')
      payload = boundedJson(report, 'report', 24 * 1024)
    } else if (reviewedItemKeys.length || report !== undefined) fail('unexpected-report')
    return write(() => {
      const at = time()
      recoverExpired(at)
      const row = matchingClaim(claimValue, ['prepared', 'dispatching', 'running'])
      if (!row) return undefined
      const attempt = usageFor(row)
      if (!attempt && ['completed', 'uncertain'].includes(outcome)) fail('no-dispatch')
      if (outcome === 'retryable' && attempt && !confirmedUnsent && usedTokens == null) {
        fail('retry-requires-termination-proof')
      }
      if (attempt && outcome !== 'uncertain') updateUsage(row, usedTokens, confirmedUnsent)
      let finalStatus = outcome
      let finalReason = reason ?? null
      if (outcome === 'completed') {
        if (usedTokens != null && usedTokens > attempt.reserved) {
          finalStatus = 'failed'
          finalReason = 'reservation-exceeded'
        } else {
          const selected = new Set(JSON.parse(row.metadata).itemKeys ?? [])
          if (reviewedItemKeys.some((key) => !selected.has(key))) fail('unexpected-reviewed-item')
          db.prepare('INSERT INTO reports VALUES (?,?,?)').run(row.id, payload, at)
          const review = db.prepare(`
            INSERT INTO reviewed (project_id, item_key, run_id) VALUES (?,?,?)
            ON CONFLICT(project_id, item_key) DO NOTHING
          `)
          for (const item of reviewedItemKeys) review.run(row.project_id, item, row.id)
          db.prepare('UPDATE projects SET last_completed_at=? WHERE id=?').run(at, row.project_id)
        }
      }
      if (outcome === 'retryable') {
        const n = db.prepare('SELECT count(*) AS n FROM attempts WHERE run_id=?').get(row.id).n
        finalStatus = n >= maxRunDispatches ? 'failed' : 'queued'
        if (finalStatus === 'failed') finalReason = 'retry-limit'
      }
      if (finalStatus === 'queued') {
        db.prepare(`
          UPDATE runs SET status='queued', available_at=?, owner=NULL, mode=NULL, epoch=NULL,
            manual=NULL, lease_until=NULL, remote_id=NULL, remote_binding=NULL, reason=? WHERE id=?
        `).run(at + retryAfterMs, finalReason, row.id)
      } else {
        db.prepare('UPDATE runs SET status=?, lease_until=NULL, reason=? WHERE id=?')
          .run(finalStatus, finalReason, row.id)
      }
      completeModeSwitch()
      return getRun(row.id)
    })
  }

  function setMode(mode) {
    recoverExpired(time())
    const current = settings()
    const row = active()
    const pending = mode === current.mode ? null : mode
    db.prepare('UPDATE settings SET pending_mode=? WHERE singleton=1').run(pending)
    if (pending !== null && row?.status === 'prepared') requeuePrepared(row, 'executor-switch')
    completeModeSwitch()
  }

  /** Invoke only after the user selects an executor and its capability check passes. */
  function requestMode(mode) {
    if (!MODES.includes(mode)) fail('invalid-mode')
    write(() => setMode(mode))
    return status()
  }

  function requestExecutor(mode) {
    if (!MODES.includes(mode)) fail('invalid-mode')
    return write(() => {
      const current = executorRequest()
      if (current?.status === 'pending' && current.mode === mode) return current
      db.prepare(`
        INSERT INTO executor_request VALUES (1,?,?,?,'pending',NULL)
        ON CONFLICT(singleton) DO UPDATE SET id=excluded.id, mode=excluded.mode,
          requested_at=excluded.requested_at, status='pending', reason=NULL
      `).run(randomUUID(), mode, time())
      return executorRequest()
    })
  }

  function acknowledgeExecutorRequest(id, accepted, reason) {
    identifier(id, 'executor-request-id')
    if (reason !== undefined && reason !== null) identifier(reason, 'reason')
    return write(() => {
      const request = executorRequest()
      if (!request || request.id !== id || request.status !== 'pending') return undefined
      if (accepted) setMode(request.mode)
      db.prepare('UPDATE executor_request SET status=?, reason=? WHERE singleton=1')
        .run(accepted ? 'accepted' : 'rejected', reason ?? null)
      return executorRequest()
    })
  }

  /** A validated terminal receipt may unblock the queue. An uncertain run is never requeued. */
  function resolveUncertain(runId, { status: outcome, usedTokens, reason } = {}) {
    identifier(runId, 'run-id')
    if (!['failed', 'invalidated', 'cancelled'].includes(outcome)) fail('invalid-reconciliation')
    if (usedTokens !== undefined && usedTokens !== null) integer(usedTokens, 0, 100_000_000, 'used-tokens')
    if (reason !== undefined && reason !== null) identifier(reason, 'reason')
    return write(() => {
      const row = runRow(runId)
      if (!row || row.status !== 'uncertain') return undefined
      updateUsage(row, usedTokens, false)
      db.prepare('UPDATE runs SET status=?, reason=? WHERE id=?')
        .run(outcome, reason ?? 'terminal-receipt', row.id)
      completeModeSwitch()
      return getRun(row.id)
    })
  }

  function listQueued({ projectId, limit = 50 } = {}) {
    if (projectId !== undefined) identifier(projectId, 'project-id')
    integer(limit, 1, 1000, 'limit')
    return db.prepare(`
      SELECT * FROM runs WHERE status='queued' AND (? IS NULL OR project_id=?)
      ORDER BY queued_at, id LIMIT ?
    `).all(projectId ?? null, projectId ?? null, limit).map(publicRun)
  }

  function report(runId) {
    identifier(runId, 'run-id')
    const row = db.prepare(`
      SELECT reports.payload FROM reports JOIN runs ON runs.id=reports.run_id
      WHERE reports.run_id=? AND runs.status='completed'
    `).get(runId)
    return row ? JSON.parse(row.payload) : undefined
  }

  function listReports({ projectId, limit = 50 } = {}) {
    if (projectId !== undefined) identifier(projectId, 'project-id')
    integer(limit, 1, 1000, 'limit')
    return db.prepare(`
      SELECT runs.id AS runId, runs.project_id AS projectId, runs.mode, reports.completed_at AS completedAt
      FROM reports JOIN runs ON runs.id=reports.run_id
      WHERE runs.status='completed' AND (? IS NULL OR runs.project_id=?)
      ORDER BY reports.completed_at DESC, runs.id LIMIT ?
    `).all(projectId ?? null, projectId ?? null, limit).map(row => ({ ...row }))
  }

  function invalidateReport(runId) {
    identifier(runId, 'run-id')
    return write(() => {
      const row = runRow(runId)
      if (!row || row.status !== 'completed') return undefined
      db.prepare('DELETE FROM reviewed WHERE run_id=?').run(runId)
      db.prepare('DELETE FROM reports WHERE run_id=?').run(runId)
      db.prepare("UPDATE runs SET status='invalidated', reason='report-invalidated' WHERE id=?").run(runId)
      return getRun(runId)
    })
  }

  return {
    status,
    enqueue,
    claim,
    beginDispatch,
    markRunning,
    finish,
    release,
    requestMode,
    requestExecutor,
    pendingExecutorRequest() {
      const request = executorRequest()
      return request?.status === 'pending' ? request : undefined
    },
    acceptExecutorRequest(id) { return acknowledgeExecutorRequest(id, true) },
    rejectExecutorRequest(id, { reason } = {}) { return acknowledgeExecutorRequest(id, false, reason) },
    resolveUncertain,
    listQueued,
    getRun,
    nextAutomaticAt,
    report,
    listReports,
    invalidateReport,
    recover() {
      write(() => recoverExpired(time()))
      return status()
    },
    wasReviewed(projectId, itemKey) {
      identifier(projectId, 'project-id')
      identifier(itemKey, 'item-key')
      return !!db.prepare('SELECT 1 FROM reviewed WHERE project_id=? AND item_key=?').get(projectId, itemKey)
    },
    scanCheckpoint(projectId) {
      identifier(projectId, 'project-id')
      return db.prepare('SELECT scan_checkpoint FROM projects WHERE id=?').get(projectId)?.scan_checkpoint
    },
    close() { db.close() }
  }
}
