import postgres from 'postgres';

let created = 0;
export default function testPostgres(...arguments_) {
  const client = postgres(...arguments_);
  created += 1;
  if (created === 2) client.end = async () => {
    if (process.env.VIGILO_TEST_BOSS_START_MODE === 'reporter_close_hang' || process.env.VIGILO_TEST_SHARED_BOSS_MODE === 'reporter_close_hang') return new Promise(() => {});
    throw new Error('fixture_secret_bearing_reporter_close_failure');
  };
  return client;
}
