import { PgBoss } from 'pg-boss';
import { registerHooks } from 'node:module';

const resources = new WeakMap();
const mode = process.env.VIGILO_TEST_BOSS_START_MODE;

if (mode === 'reporter_close_failure' || mode === 'reporter_close_hang') registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'postgres' && context.parentURL?.endsWith('/worker/baseline-once.ts'))
      return { url: new URL('./baseline-once-postgres-close.mjs', import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

PgBoss.prototype.start = async function () {
  process.stderr.write('fixture_boss_start_attempted\n');
  resources.set(this, setInterval(() => {}, 1_000));
  if (mode !== 'started') throw new Error('fixture_partial_start_failure');
  return this;
};

PgBoss.prototype.stop = async function () {
  process.stderr.write('fixture_boss_stop_attempted\n');
  if (mode === 'stop_failure') throw new Error('fixture_stop_failure');
  if (mode === 'stop_hang') return new Promise(() => {});
  const resource = resources.get(this);
  if (resource) clearInterval(resource);
  resources.delete(this);
  process.stderr.write('fixture_boss_resources_released\n');
};
