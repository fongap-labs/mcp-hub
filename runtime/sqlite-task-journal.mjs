import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Trusted Coding Runtime only: NEVER import this store into the public Hub Worker.
const REF = /^[A-Za-z0-9._:-]{1,200}$/;
const DISPATCH = /^dispatch_[A-Za-z0-9_-]{43}$/;
const RUNNER = /^runner_[A-Za-z0-9_-]{43}$/;
const LEASE = /^lease_[A-Za-z0-9_-]{43}$/;
const STATES = { started: 'running', completed: 'completed', failed: 'failed',
  cancelled: 'cancelled', uncertain: 'side_effects_uncertain', ready_to_retry: 'not_started' };

function valid(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError('invalid_' + label);
  return value;
}
function seal(key, value) {
  const raw = Buffer.from(JSON.stringify(value));
  if (raw.length > 262144) throw new RangeError('runtime_payload_too_large');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, cipher.getAuthTag ? Buffer.alloc(0) : Buffer.alloc(0),
    cipher.update(raw), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
function unseal(key, value) {
  const raw = Buffer.from(value, 'base64');
  if (raw.length < 29) throw new Error('invalid_runtime_ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString('utf8'));
}
function needed(row) {
  if (!row) throw new Error('runtime_task_not_found');
  return row;
}

/**
 * Durable encrypted local task / result store, independent of Hub's D1.
 * Task bodies never enter Hub or Cloudflare Queue messages.
 */
export class RuntimeTaskJournal {
  #db; #key; #clock;
  constructor({ databasePath, encryptionKey, clock = Date.now }) {
    if (typeof databasePath !== 'string' || !databasePath || databasePath === ':memory:') {
      throw new TypeError('runtime_database_path_required');
    }
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
      throw new TypeError('runtime_encryption_key_must_be_32_bytes');
    }
    if (typeof clock !== 'function') throw new TypeError('invalid_runtime_clock');
    const file = resolve(databasePath);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, 'a', 0o600);
    closeSync(fd);
    chmodSync(file, 0o600);
    this.#db = new DatabaseSync(file);
    this.#key = Buffer.from(encryptionKey);
    this.#clock = clock;
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.#db.exec([
      'CREATE TABLE IF NOT EXISTS runtime_tasks (',
      'task_ref TEXT PRIMARY KEY, resource_key TEXT NOT NULL, encrypted_task TEXT NOT NULL,',
      'dispatch_id TEXT UNIQUE, state TEXT NOT NULL CHECK(state IN (',
      "'prepared','dispatched','claimed','started','completed','failed','cancelled','uncertain','ready_to_retry')),",
      'runner_id TEXT, lease_id TEXT, sequence INTEGER NOT NULL DEFAULT 0,',
      'ack_sequence INTEGER NOT NULL DEFAULT 0, encrypted_result TEXT,',
      'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS runtime_task_events (',
      'task_ref TEXT NOT NULL REFERENCES runtime_tasks(task_ref), sequence INTEGER NOT NULL,',
      'state TEXT NOT NULL, created_at INTEGER NOT NULL, evidence_hash TEXT,',
      'PRIMARY KEY(task_ref,sequence));',
      'CREATE INDEX IF NOT EXISTS idx_runtime_recovery ON runtime_tasks(state,sequence,ack_sequence);',
    ].join('\n'));
  }
  #time() { return Math.floor(this.#clock() / 1000); }
  #tx(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.#db.exec('COMMIT'); return value; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #row(ref) { return needed(this.#db.prepare('SELECT * FROM runtime_tasks WHERE task_ref=?').get(ref)); }
  #event(ref, state, seq, evidence = null) {
    this.#db.prepare('INSERT INTO runtime_task_events(task_ref,sequence,state,created_at,evidence_hash) VALUES(?,?,?,?,?)')
      .run(ref, seq, state, this.#time(), evidence);
  }
  #transition(ref, before, after, extra = '', args = [], evidence = null) {
    const row = this.#db.prepare('UPDATE runtime_tasks SET state=?,sequence=sequence+1,updated_at=?' +
      extra + ' WHERE task_ref=? AND state=? RETURNING sequence')
      .get(after, this.#time(), ...args, ref, before);
    if (!row) throw new Error('runtime_task_conflict');
    this.#event(ref, after, row.sequence, evidence);
    return row.sequence;
  }
  createTask({ taskRef, resourceKey, task }) {
    valid(taskRef, REF, 'task_ref'); valid(resourceKey, REF, 'resource_key');
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new TypeError('invalid_runtime_task');
    const encrypted = seal(this.#key, task), at = this.#time();
    this.#tx(() => {
      this.#db.prepare('INSERT INTO runtime_tasks(task_ref,resource_key,encrypted_task,state,created_at,updated_at) VALUES(?,?,?, ?,?,?)')
        .run(taskRef, resourceKey, encrypted, 'prepared', at, at);
      this.#event(taskRef, 'prepared', 0);
    });
    return { taskRef, state: 'prepared' };
  }
  attachDispatch(taskRef, dispatchId) {
    valid(taskRef, REF, 'task_ref'); valid(dispatchId, DISPATCH, 'dispatch_id');
    return this.#tx(() => {
      const row = this.#row(taskRef);
      if (row.state === 'dispatched' && row.dispatch_id === dispatchId) return dispatchId;
      if (row.state !== 'prepared' || row.dispatch_id !== null) throw new Error('runtime_task_conflict');
      this.#transition(taskRef, 'prepared', 'dispatched', ',dispatch_id=?', [dispatchId]);
      return dispatchId;
    });
  }
  /**
   * Runtime-owned lookup. Caller identity must be verified independently by
   * the Runtime server, never copied from an untrusted Runner request body.
   * The supplied RuntimeDispatchClient.get authenticates using Runtime-only key.
   */
  async claimAcceptedTask(offer, authenticatedRunnerId, runtimeClient) {
    valid(authenticatedRunnerId, RUNNER, 'authenticated_runner');
    valid(offer?.dispatchId, DISPATCH, 'dispatch_id');
    valid(offer?.leaseId, LEASE, 'lease_id');
    valid(offer?.taskRef, REF, 'task_ref');
    valid(offer?.resourceKey, REF, 'resource_key');
    if (!runtimeClient || typeof runtimeClient.get !== 'function') throw new TypeError('runtime_hub_client_required');
    const status = await runtimeClient.get(offer.dispatchId);
    if (status.dispatch_id !== offer.dispatchId || status.status !== 'accepted' ||
        status.runner_id !== authenticatedRunnerId || status.lease_id !== offer.leaseId ||
        status.task_ref !== offer.taskRef || status.resource_key !== offer.resourceKey ||
        !Number.isSafeInteger(status.lease_expires_at) || status.lease_expires_at <= this.#time()) {
      throw new Error('runtime_lease_not_authorized');
    }
    return this.#tx(() => {
      const row = this.#row(offer.taskRef);
      if (row.dispatch_id !== offer.dispatchId || row.resource_key !== offer.resourceKey ||
          row.state !== 'dispatched') throw new Error('runtime_task_conflict');
      this.#transition(offer.taskRef, 'dispatched', 'claimed', ',runner_id=?,lease_id=?',
        [authenticatedRunnerId, offer.leaseId]);
      return unseal(this.#key, row.encrypted_task);
    });
  }
  /** Persist execution intent BEFORE running tools. Second call fails closed. */
  beginSideEffects(taskRef, runnerId, leaseId) {
    valid(taskRef, REF, 'task_ref'); valid(runnerId, RUNNER, 'runner_id'); valid(leaseId, LEASE, 'lease_id');
    return this.#tx(() => {
      const row = this.#row(taskRef);
      if (row.runner_id !== runnerId || row.lease_id !== leaseId) throw new Error('runtime_lease_not_authorized');
      return this.#transition(taskRef, 'claimed', 'started');
    });
  }
  /** Persist encrypted terminal result BEFORE reporting completion to Hub. */
  complete(taskRef, runnerId, leaseId, outcome, result) {
    valid(taskRef, REF, 'task_ref'); valid(runnerId, RUNNER, 'runner_id'); valid(leaseId, LEASE, 'lease_id');
    if (outcome !== 'completed' && outcome !== 'failed') throw new TypeError('invalid_runtime_outcome');
    const sealed = seal(this.#key, result);
    return this.#tx(() => {
      const row = this.#row(taskRef);
      if (row.runner_id !== runnerId || row.lease_id !== leaseId) throw new Error('runtime_lease_not_authorized');
      return this.#transition(taskRef, 'started', outcome, ',encrypted_result=?', [sealed]);
    });
  }
  requestCancellation(taskRef) {
    valid(taskRef, REF, 'task_ref');
    return this.#tx(() => {
      const { state } = this.#row(taskRef);
      if (['cancelled','completed','failed','uncertain'].includes(state)) return state;
      if (state === 'ready_to_retry') throw new Error('runtime_task_conflict');
      const target = state === 'claimed' || state === 'started' ? 'uncertain' : 'cancelled';
      this.#transition(taskRef, state, target);
      return target;
    });
  }
  /**
   * On restart, any exposed/started task becomes uncertain. Never replay
   * accepted work until independent side-effect evidence is reviewed.
   */
  recoverAfterRestart() {
    return this.#tx(() => {
      const rows = this.#db.prepare("SELECT task_ref,state FROM runtime_tasks WHERE state IN ('claimed','started') ORDER BY task_ref").all();
      for (const row of rows) this.#transition(row.task_ref, row.state, 'uncertain');
      return this.recoveryPlan();
    });
  }
  confirmNeverStarted(taskRef, evidence) {
    valid(taskRef, REF, 'task_ref');
    if (typeof evidence !== 'string' || evidence.trim().length < 16 || evidence.length > 4096) {
      throw new TypeError('runtime_recovery_evidence_required');
    }
    const hash = createHash('sha256').update(evidence).digest('hex');
    return this.#tx(() => this.#transition(taskRef, 'uncertain', 'ready_to_retry', '', [], hash));
  }
  recoveryPlan() {
    return this.#db.prepare('SELECT task_ref,dispatch_id,runner_id,lease_id,state,sequence,ack_sequence FROM runtime_tasks ORDER BY created_at,task_ref')
      .all().map(row => ({
        taskRef: row.task_ref, dispatchId: row.dispatch_id, runnerId: row.runner_id,
        leaseId: row.lease_id, state: row.state, sequence: row.sequence,
        report: STATES[row.state] && row.dispatch_id && row.sequence > row.ack_sequence
          ? { dispatchId: row.dispatch_id, sequence: row.sequence, state: STATES[row.state] } : null,
        requiresReview: row.state === 'uncertain',
      }));
  }
  /**
   * Hub must first accept the report. Only an acknowledged not_started state
   * may clear stale Runner identity and release the task for re-dispatch.
   */
  acknowledge(taskRef, sequence) {
    valid(taskRef, REF, 'task_ref');
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('invalid_runtime_sequence');
    return this.#tx(() => {
      const row = this.#row(taskRef);
      if (sequence === row.ack_sequence) return true;
      if (sequence !== row.sequence || sequence <= row.ack_sequence || !STATES[row.state]) {
        throw new Error('runtime_sequence_conflict');
      }
      if (row.state === 'ready_to_retry') {
        this.#db.prepare("UPDATE runtime_tasks SET state='dispatched',runner_id=NULL,lease_id=NULL,ack_sequence=?,updated_at=? WHERE task_ref=?")
          .run(sequence, this.#time(), taskRef);
      } else {
        this.#db.prepare('UPDATE runtime_tasks SET ack_sequence=? WHERE task_ref=?').run(sequence, taskRef);
      }
      return true;
    });
  }
  result(taskRef) {
    valid(taskRef, REF, 'task_ref');
    const row = this.#row(taskRef);
    if (!['completed','failed'].includes(row.state)) throw new Error('runtime_result_unavailable');
    return unseal(this.#key, row.encrypted_result);
  }
  close() { this.#db.close(); this.#key.fill(0); }
}
