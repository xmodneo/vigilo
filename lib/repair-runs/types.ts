import type { BaselineOutcome } from '../repository-baselines/types.ts';

export const REPAIR_RUN_STATES = [
  'created',
  'baseline_running',
  'ready_for_investigation',
  'baseline_failed',
  'infrastructure_failed',
  'cancelled',
] as const;

export type RepairRunState = (typeof REPAIR_RUN_STATES)[number];

export type RepairRunTerminalState = Exclude<RepairRunState, 'created' | 'baseline_running'>;

export interface RepairRunIdentity {
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  baseCommitSha: string;
  profileIdentity: string;
}

export interface RepairRunResult {
  id: string;
  state: RepairRunState;
  identity: RepairRunIdentity;
  baselineId: string | null;
  baselineOutcome: BaselineOutcome | null;
  failureClassification: string | null;
  failureCode: string | null;
  createdAt: Date;
  baselineStartedAt: Date | null;
  completedAt: Date | null;
  stateChangedAt: Date;
  updatedAt: Date;
}
