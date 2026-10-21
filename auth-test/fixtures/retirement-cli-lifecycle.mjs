import { registerHooks } from 'node:module';
import { PgBoss } from 'pg-boss';

const mode = process.env.VIGILO_TEST_RETIREMENT_LIFECYCLE;
const resources = new WeakMap();

PgBoss.prototype.start = async function () {
  process.stderr.write('fixture_retirement_start_attempted\n');
  resources.set(this, setInterval(() => {}, 1_000));
  if (mode === 'partial_start' || mode === 'start_stop_failure' || mode === 'stop_hang')
    throw new Error('fixture_secret_bearing_start_failure');
  return this;
};

PgBoss.prototype.stop = async function () {
  process.stderr.write('fixture_retirement_stop_attempted\n');
  if (mode === 'start_stop_failure') throw new Error('fixture_secret_bearing_stop_failure');
  if (mode === 'stop_hang') return new Promise(() => {});
  const resource = resources.get(this);
  if (resource) clearInterval(resource);
  resources.delete(this);
  process.stderr.write('fixture_retirement_resources_released\n');
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/operations/retire-reviewed-stage.ts') &&
        specifier === '../lib/external-execution/reviewed-retirement-cli.ts') {
      return { url: new URL('./retirement-cli-command.mjs', import.meta.url).href, shortCircuit: true };
    }
    if (context.parentURL?.endsWith('/operations/retire-reviewed-stage.ts') && specifier === 'postgres') {
      return { url: new URL('./retirement-cli-postgres.mjs', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
