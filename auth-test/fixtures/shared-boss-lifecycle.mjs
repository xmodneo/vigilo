import { registerHooks } from 'node:module';
import { PgBoss } from 'pg-boss';

import { WorkerHeartbeatLifecycle } from '../../lib/operations/worker-heartbeat.ts';

const mode = process.env.VIGILO_TEST_SHARED_BOSS_MODE;
const resources = new WeakMap();

WorkerHeartbeatLifecycle.prototype.start = async function () {
  process.stderr.write('fixture_heartbeat_started_without_db\n');
};
WorkerHeartbeatLifecycle.prototype.draining = async function () {
  process.stderr.write('fixture_heartbeat_draining_without_db\n');
};
WorkerHeartbeatLifecycle.prototype.stopped = async function () {
  process.stderr.write('fixture_heartbeat_stopped_without_db\n');
};

PgBoss.prototype.start = async function () {
  process.stderr.write('fixture_shared_boss_start_attempted\n');
  resources.set(this, setInterval(() => {}, 1_000));
  if (['partial_start', 'start_stop_failure', 'stop_hang'].includes(mode))
    throw new Error('fixture_secret_bearing_start_failure');
  if (mode === 'signal_during_startup') process.emit('SIGTERM');
  return this;
};
PgBoss.prototype.createQueue = async function () {
  process.stderr.write('fixture_shared_boss_queue_config_attempted\n');
  if (mode === 'configuration_failure') throw new Error('fixture_secret_bearing_configuration_failure');
};
PgBoss.prototype.updateQueue = async function () {};
PgBoss.prototype.work = async function () {
  process.stderr.write('fixture_shared_boss_work_registered\n');
  throw new Error('fixture_unexpected_consumer_registration');
};
PgBoss.prototype.stop = async function () {
  process.stderr.write('fixture_shared_boss_stop_attempted\n');
  if (mode === 'start_stop_failure' || mode === 'staging_failure_stop_reject') throw new Error('fixture_secret_bearing_stop_failure');
  if (mode === 'stop_hang' || mode === 'post_apply_stop_hang' || mode === 'staging_failure_stop_hang') return new Promise(() => {});
  const resource = resources.get(this);
  if (resource) clearInterval(resource);
  resources.delete(this);
  process.stderr.write('fixture_shared_boss_resources_released\n');
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mode === 'reporter_close_failure' && specifier === 'postgres' && context.parentURL?.endsWith('/worker/main.ts'))
      return { url: new URL('./baseline-once-postgres-close.mjs', import.meta.url).href, shortCircuit: true };
    if (['post_apply_stop_hang', 'post_apply_success', 'staging_failure_stop_reject', 'staging_failure_stop_hang'].includes(mode) && context.parentURL?.endsWith('/operations/stage-reviewed-repair-run.ts') &&
        specifier === '../lib/external-execution/reviewed-staging.ts') {
      return { url: new URL('./shared-boss-staging-service.mjs', import.meta.url).href, shortCircuit: true };
    }
    if (context.parentURL?.endsWith('/operations/stage-reviewed-repair-run.ts') &&
        specifier === '../lib/external-execution/reviewed-staging-cli.ts') {
      return { url: new URL('./shared-boss-staging-command.mjs', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
