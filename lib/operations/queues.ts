import {
  AI_CANDIDATE_GENERATION_QUEUE,
  AI_INVESTIGATION_QUEUE,
  CANDIDATE_VERIFICATION_QUEUE,
  INVESTIGATION_CONTEXT_QUEUE,
  REPAIR_BASELINE_QUEUE,
  REVIEWED_BASELINE_QUEUE,
  REPAIR_LOOP_QUEUE,
  REPAIR_PUBLICATION_QUEUE,
} from '../repair-runs/queue.ts';

export const canonicalRepairQueues = [
  AI_CANDIDATE_GENERATION_QUEUE,
  AI_INVESTIGATION_QUEUE,
  CANDIDATE_VERIFICATION_QUEUE,
  INVESTIGATION_CONTEXT_QUEUE,
  REPAIR_BASELINE_QUEUE,
  REPAIR_LOOP_QUEUE,
  REPAIR_PUBLICATION_QUEUE,
].sort() as readonly string[];

// Provisioned pg-boss queues include the exact-claim-only reviewed queue;
// general worker heartbeats and work() registrations use canonicalRepairQueues.
export const configuredRepairQueues = [...canonicalRepairQueues, REVIEWED_BASELINE_QUEUE].sort() as readonly string[];
