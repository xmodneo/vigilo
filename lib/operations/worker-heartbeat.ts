import type postgres from 'postgres';

import { canonicalRepairQueues } from './queues.ts';
import { EXPECTED_SCHEMA_VERSION } from './migrations.ts';

export type WorkerHeartbeatState = 'starting' | 'ready' | 'draining' | 'stopped';

export interface WorkerHeartbeatValue {
  id: string;
  releaseSha: string;
  state: 'starting';
  registeredQueues: readonly string[];
}

export interface WorkerHeartbeatStore {
  create(value: WorkerHeartbeatValue): Promise<void>;
  transition(id: string, state: WorkerHeartbeatState, failureCode?: string): Promise<void>;
  cleanup(): Promise<number>;
}

export class PostgresWorkerHeartbeatStore implements WorkerHeartbeatStore {
  constructor(private readonly client: ReturnType<typeof postgres>) {}

  async create(value: WorkerHeartbeatValue): Promise<void> {
    await this.client`
      insert into operational_worker_heartbeat
        (id, service, release_sha, expected_schema_version, registered_queues, state, started_at, last_heartbeat_at)
      values (${value.id}, 'vigilo-worker', ${value.releaseSha}, ${EXPECTED_SCHEMA_VERSION}, ${JSON.stringify(value.registeredQueues)}::jsonb, 'starting', statement_timestamp(), statement_timestamp())
    `;
  }

  async transition(id: string, state: WorkerHeartbeatState, failureCode?: string): Promise<void> {
    const rows = await this.client`
      update operational_worker_heartbeat
      set state = ${state}, failure_code = ${failureCode ?? null}
      where id = ${id}
      returning id
    `;
    if (rows.length !== 1) throw new Error('worker_heartbeat_unavailable');
  }

  async cleanup(): Promise<number> {
    const rows = await this.client`
      delete from operational_worker_heartbeat
      where id in (
        select id from operational_worker_heartbeat
        where (state = 'stopped' and stopped_at < statement_timestamp() - interval '7 days')
           or (state <> 'stopped' and last_heartbeat_at < statement_timestamp() - interval '7 days')
        order by last_heartbeat_at limit 100
      ) returning id
    `;
    return rows.length;
  }
}

export class WorkerHeartbeatLifecycle {
  private state: WorkerHeartbeatState | 'new' = 'new';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refresh: Promise<void> | undefined;

  constructor(
    private readonly store: WorkerHeartbeatStore,
    private readonly identity: { id: string; releaseSha: string },
    private readonly options: { heartbeatIntervalMs?: number } = {},
  ) {}

  async start(): Promise<void> {
    if (this.state !== 'new') throw new Error('worker_heartbeat_transition_invalid');
    await this.store.create({ ...this.identity, state: 'starting', registeredQueues: canonicalRepairQueues });
    this.state = 'starting';
    await this.store.cleanup();
  }

  async ready(): Promise<void> {
    if (this.state !== 'starting' && this.state !== 'ready') throw new Error('worker_heartbeat_transition_invalid');
    await this.store.transition(this.identity.id, 'ready');
    this.state = 'ready';
  }

  begin(): void {
    if (this.state !== 'ready' || this.timer) throw new Error('worker_heartbeat_transition_invalid');
    this.schedule();
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pulse();
    }, this.options.heartbeatIntervalMs ?? 15_000);
    this.timer.unref();
  }

  private async pulse(): Promise<void> {
    if (this.state !== 'ready') return;
    const refresh = this.store.transition(this.identity.id, 'ready');
    this.refresh = refresh;
    try { await refresh; } catch { /* Readiness fails once the durable heartbeat becomes stale. */ }
    finally { if (this.refresh === refresh) this.refresh = undefined; }
    if (this.state === 'ready' && !this.timer) this.schedule();
  }

  async draining(): Promise<void> {
    if (this.state !== 'starting' && this.state !== 'ready' && this.state !== 'draining') throw new Error('worker_heartbeat_transition_invalid');
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.state = 'draining';
    try { await this.refresh; } catch { /* The draining transition below is authoritative. */ }
    await this.store.transition(this.identity.id, 'draining');
  }

  async stopped(failureCode?: string): Promise<void> {
    if (this.state === 'new' || this.state === 'stopped') throw new Error('worker_heartbeat_transition_invalid');
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.store.transition(this.identity.id, 'stopped', failureCode);
    this.state = 'stopped';
  }
}
