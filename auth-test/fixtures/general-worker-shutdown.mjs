import { stopGeneralWorker } from '../../lib/operations/general-worker-shutdown.ts';

let accepting = true;
const consumer = setInterval(() => {
  if (accepting) process.stdout.write('accepted_work\n');
}, 10);
process.once('SIGTERM', () => {
  accepting = false;
  void stopGeneralWorker({
    heartbeat: { draining: async () => { process.stdout.write('draining\n'); }, stopped: async () => { process.stdout.write('stopped\n'); } },
    supervisor: { stop: async () => {} },
    boss: { offWork: async () => new Promise(() => {}), stop: async () => { process.stdout.write('boss_stopped\n'); } },
    workers: [{ id: 'held', queue: 'repair-baseline-v1' }],
    closeClients: async () => { process.stdout.write('clients_closed\n'); },
    deadlineMs: 100,
  }).then(() => { process.exit(0); }, () => { clearInterval(consumer); process.exit(1); });
});
process.stdout.write('ready\n');
