import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.ts';

/**
 * Leader election with a lock file, so only one instance runs the minute dispatch and the daily
 * re-check. The file is created atomically with O_CREAT|O_EXCL ('wx'): exactly one creator wins.
 * It holds the holder's instance id and a heartbeat the holder refreshes; a lock whose heartbeat is
 * older than `staleMs` belongs to a dead (or hung) process and may be taken over.
 *
 * Takeover is serialized by a second O_EXCL file (`<lock>.takeover`): the taker re-reads the lock
 * under it and only replaces the exact stale content it judged, so two instances that both saw the
 * same stale lock can't both win, and a holder that heartbeats at the last moment keeps its lock.
 *
 * A file lock without fencing tokens can't stop a leader that was paused (GC, SIGSTOP) from finishing
 * the tick it was in after being replaced. That is acceptable because the lock only decides who runs
 * the jobs; send-once safety comes from the per-alert claim and lease in outbox.ts.
 *
 * The lock file must live on storage every instance sees (the data volume). With Postgres, replace
 * this with `pg_try_advisory_lock` held on a dedicated connection, and the per-alert claim with
 * SELECT ... FOR UPDATE SKIP LOCKED (see outbox.ts).
 */

export interface LockInfo {
  instanceId: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface JobLockOptions {
  file: string;
  instanceId: string;
  /** A heartbeat older than this means the holder is gone. Keep it several heartbeats long. */
  staleMs: number;
  clock?: () => Date;
}

interface Snapshot {
  raw: string;
  info?: LockInfo;
  mtimeMs: number;
}

const errCode = (err: unknown) => (err as NodeJS.ErrnoException).code;

export class JobLock {
  private file: string;
  private guardFile: string;
  private instanceId: string;
  private staleMs: number;
  private clock: () => Date;
  private acquiredAt?: string;
  private held = false;

  constructor(opts: JobLockOptions) {
    this.file = opts.file;
    this.guardFile = `${opts.file}.takeover`;
    this.instanceId = opts.instanceId;
    this.staleMs = opts.staleMs;
    this.clock = opts.clock ?? (() => new Date());
  }

  isLeader(): boolean {
    return this.held;
  }

  /** Becomes (or stays) the leader if possible. Safe to call on every tick. */
  tryAcquire(): boolean {
    const wasLeader = this.held;
    this.held = this.acquire();
    if (this.held !== wasLeader) log.info(this.held ? 'job lock acquired' : 'job lock lost', { instanceId: this.instanceId });
    return this.held;
  }

  /** Refreshes the heartbeat. Returns false (and steps down) if another instance holds the lock now. */
  heartbeat(): boolean {
    const current = this.read();
    if (current?.info?.instanceId !== this.instanceId) {
      if (this.held) log.warn('job lock taken over by another instance', { instanceId: this.instanceId });
      this.held = false;
      return false;
    }
    // Write-then-rename so readers never see a half-written file.
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, this.content());
    renameSync(tmp, this.file);
    this.held = true;
    return true;
  }

  /** Gives the lock up on shutdown so another instance can take over without waiting for staleness. */
  release(): void {
    if (this.read()?.info?.instanceId === this.instanceId) rmSync(this.file, { force: true });
    this.held = false;
  }

  /** What the lock file says right now (for ops/tests). */
  holder(): LockInfo | undefined {
    return this.read()?.info;
  }

  private acquire(): boolean {
    if (this.create()) return true;
    const current = this.read();
    if (!current) return this.create(); // released between our create and read
    if (current.info?.instanceId === this.instanceId) return this.heartbeat();
    if (!this.isStale(current)) return false;
    return this.takeOver(current);
  }

  private takeOver(seen: Snapshot): boolean {
    try {
      writeFileSync(this.guardFile, this.instanceId, { flag: 'wx' });
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err;
      // Another instance is mid-takeover, or crashed during one (the window is milliseconds).
      if (this.ageMs(this.guardFile) > this.staleMs) rmSync(this.guardFile, { force: true });
      return false;
    }
    try {
      const again = this.read();
      if (again && again.raw !== seen.raw) return false; // the holder heartbeated, or someone else won
      log.warn('taking over stale job lock', { previous: seen.info?.instanceId ?? 'unreadable', heartbeatAt: seen.info?.heartbeatAt });
      rmSync(this.file, { force: true });
      return this.create();
    } finally {
      rmSync(this.guardFile, { force: true });
    }
  }

  private isStale(s: Snapshot): boolean {
    const beat = s.info ? Date.parse(s.info.heartbeatAt) : Number.NaN;
    // Unreadable content (a creator that died between open and write): fall back to the file's mtime.
    const last = Number.isFinite(beat) ? beat : s.mtimeMs;
    return this.clock().getTime() - last > this.staleMs;
  }

  private create(): boolean {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const acquiredAt = this.clock().toISOString();
    try {
      writeFileSync(this.file, this.content(acquiredAt), { flag: 'wx' });
      this.acquiredAt = acquiredAt;
      return true;
    } catch (err) {
      if (errCode(err) === 'EEXIST') return false;
      throw err;
    }
  }

  private content(acquiredAt = this.acquiredAt): string {
    const now = this.clock().toISOString();
    const info: LockInfo = { instanceId: this.instanceId, pid: process.pid, acquiredAt: acquiredAt ?? now, heartbeatAt: now };
    return JSON.stringify(info);
  }

  private read(): Snapshot | undefined {
    let raw: string;
    let mtimeMs: number;
    try {
      raw = readFileSync(this.file, 'utf8');
      mtimeMs = statSync(this.file).mtimeMs;
    } catch (err) {
      if (errCode(err) === 'ENOENT') return undefined;
      throw err;
    }
    let info: LockInfo | undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<LockInfo>;
      if (typeof parsed.instanceId === 'string' && typeof parsed.heartbeatAt === 'string') info = parsed as LockInfo;
    } catch {
      // unreadable: judged by mtime
    }
    return { raw, info, mtimeMs };
  }

  private ageMs(file: string): number {
    try {
      return this.clock().getTime() - statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }
}
