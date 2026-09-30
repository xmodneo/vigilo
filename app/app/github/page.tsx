import { randomUUID } from 'node:crypto';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { AccessDeniedError } from '../../../lib/auth/protected-context';
import { resolveRequestWorkspace } from '../../../lib/auth/resolve-request';
import { findGitHubInstallation } from '../../../lib/github-app/flow';
import { getAuthDatabase } from '../../../lib/auth/server';
import { publicExecutionProfile } from '../../../lib/execution-profiles/handlers';
import { getExecutionProfileForContext } from '../../../lib/execution-profiles/server';
import { getRepositoryOverviewForContext } from '../../../lib/github-repositories/server';
import { publicBaseline } from '../../../lib/repository-baselines/handlers';
import { getRepositoryBaselineForContext } from '../../../lib/repository-baselines/server';
import { publicRepairRun } from '../../../lib/repair-runs/handlers';
import { getLatestRepairRunForContext } from '../../../lib/repair-runs/server';
import { publicInvestigation } from '../../../lib/investigations/handlers';
import { getInvestigationForContext } from '../../../lib/investigations/server';
import { getLatestRepairCandidateForContext, publicRepairCandidate } from '../../../lib/repair-candidates/server';
import { getCandidateVerificationForContext } from '../../../lib/candidate-verifications/server';
import { publicCandidateVerification } from '../../../lib/candidate-verifications/handlers';
import { getAiInvestigationForContext } from '../../../lib/ai-investigations/server';
import { publicAiInvestigation } from '../../../lib/ai-investigations/handlers';
import { getAiCandidateGenerationForContext } from '../../../lib/ai-candidate-generations/server';
import { publicAiCandidateGeneration } from '../../../lib/ai-candidate-generations/handlers';
import { getRepairLoopForContext } from '../../../lib/repair-loops/server';
import { publicRepairLoop } from '../../../lib/repair-loops/handlers';
import { getHumanReviewForContext } from '../../../lib/human-reviews/server';
import { getRepairPublicationForContext } from '../../../lib/repair-publications/server';
import { resolveExecutionAvailability } from '../../../lib/external-execution/availability';
import type { ExecutionAvailabilityStatus } from '../../../lib/presentation/policy';
import { getReadinessResult } from '../../../lib/operations/readiness';
import { GitHubConnectionView } from './github-connection-view';

export default async function GitHubConnectionPage({ searchParams }: { searchParams?: Promise<{ error?: string | string[] }> }) {
  try {
    const requestHeaders = await headers();
    const context = await resolveRequestWorkspace(requestHeaders);
    const installation = await findGitHubInstallation(
      getAuthDatabase(),
      context.workspace.id,
    );
    let repositories = undefined;
    let repositoryError: 'unavailable' | undefined;
    let workflowError: 'unavailable' | undefined;
    let selectedRepository = undefined;
    let executionProfile = undefined;
    let baseline = undefined;
    let repairRun = undefined;
    let investigation = undefined;
    let repairCandidate = undefined;
    let candidateVerification = undefined;
    let aiInvestigation = undefined;
    let aiCandidateGeneration = undefined;
    let repairLoop = undefined;
    let humanReview = undefined;
    let repairPublication = undefined;
    let executionAvailability: ExecutionAvailabilityStatus = 'unknown';
    if (installation) {
      try {
        const overview = await getRepositoryOverviewForContext(context);
        repositories = overview.repositories ?? undefined;
        selectedRepository = overview.selected
          ? {
              defaultBranch: overview.selected.defaultBranch,
              fullName: overview.selected.fullName,
              id: overview.selected.githubRepositoryId,
              isPrivate: overview.selected.isPrivate,
            }
          : null;
        const publicSelection = overview.selected && !overview.selected.isPrivate ? overview.selected : null;
        try {
          executionProfile = publicSelection
            ? publicExecutionProfile(await getExecutionProfileForContext(context))
            : null;
          baseline = publicSelection
            ? publicBaseline(await getRepositoryBaselineForContext(context))
            : null;
          repairRun = publicSelection
            ? publicRepairRun(await getLatestRepairRunForContext(context, publicSelection.githubRepositoryId))
            : null;
          investigation = repairRun
            ? publicInvestigation(await getInvestigationForContext(context, repairRun.id))
            : null;
          aiInvestigation = investigation
            ? publicAiInvestigation(await getAiInvestigationForContext(context, investigation.id))
            : null;
          aiCandidateGeneration = aiInvestigation
            ? publicAiCandidateGeneration(await getAiCandidateGenerationForContext(context, aiInvestigation.id))
            : null;
          repairCandidate = investigation
            ? publicRepairCandidate(await getLatestRepairCandidateForContext(context, investigation.id))
            : null;
          candidateVerification = repairCandidate
            ? publicCandidateVerification(await getCandidateVerificationForContext(context, repairCandidate.id))
            : null;
          repairLoop = repairRun
            ? publicRepairLoop(await getRepairLoopForContext(context, repairRun.id))
            : null;
          humanReview = repairRun && repairLoop
            ? await getHumanReviewForContext(context, repairRun.id)
            : null;
          repairPublication = repairRun
            ? await getRepairPublicationForContext(context, repairRun.id)
            : null;
          if (publicSelection) {
            const authority = await resolveExecutionAvailability(getAuthDatabase(), context.workspace.id, { operationalReady: true });
            executionAvailability = authority.status;
            if (executionAvailability === 'available') {
              const readiness = await getReadinessResult();
              if (readiness.status !== 200) executionAvailability = 'operational_unavailable';
            }
          }
        } catch {
          workflowError = 'unavailable';
          executionAvailability = 'unknown';
          executionProfile = undefined;
          baseline = undefined;
          repairRun = undefined;
          investigation = undefined;
          repairCandidate = undefined;
          candidateVerification = undefined;
          aiInvestigation = undefined;
          aiCandidateGeneration = undefined;
          repairLoop = undefined;
          humanReview = undefined;
          repairPublication = undefined;
        }
      } catch {
        repositoryError = 'unavailable';
      }
    }

    const parameters = await searchParams;
    const notice = Array.isArray(parameters?.error) ? parameters.error[0] : parameters?.error;
    return (
      <GitHubConnectionView
        installation={installation}
        executionAvailability={executionAvailability}
        aiInvestigationRequestId={randomUUID()}
        aiCandidateGenerationRequestId={randomUUID()}
        repairLoopRequestId={randomUUID()}
        investigationRequestId={randomUUID()}
        {...(investigation !== undefined ? { investigation } : {})}
        {...(repairCandidate !== undefined ? { repairCandidate } : {})}
        {...(candidateVerification !== undefined ? { candidateVerification } : {})}
        {...(aiInvestigation !== undefined ? { aiInvestigation } : {})}
        {...(aiCandidateGeneration !== undefined ? { aiCandidateGeneration } : {})}
        {...(repairLoop !== undefined ? { repairLoop } : {})}
        {...(humanReview !== undefined ? { humanReview } : {})}
        humanReviewRequestId={randomUUID()}
        {...(repairPublication !== undefined ? { repairPublication } : {})}
        repairPublicationRequestId={randomUUID()}
        {...(baseline !== undefined ? { baseline } : {})}
        {...(executionProfile !== undefined ? { executionProfile } : {})}
        {...(repositories ? { repositories } : {})}
        repairRequestId={randomUUID()}
        {...(repairRun !== undefined ? { repairRun } : {})}
        {...(repositoryError ? { repositoryError } : {})}
        {...(workflowError ? { workflowError } : {})}
        {...(notice ? { noticeCode: notice } : {})}
        {...(selectedRepository !== undefined ? { selectedRepository } : {})}
        workspaceId={context.workspace.id}
      />
    );
  } catch (error) {
    if (error instanceof AccessDeniedError && error.code === 'unauthorized') {
      redirect('/sign-in');
    }
    return (
      <main className="workspace-shell">
        <section className="workspace-card" aria-labelledby="workspace-unavailable-title">
          <p className="eyebrow">Controlled beta workspace</p>
          <h1 id="workspace-unavailable-title">Workspace unavailable</h1>
          <p role="alert">Vigilo could not load durable workspace state safely. No external operation was started.</p>
          <a className="primary-action button-link" href="/app/github">Try again</a>
        </section>
      </main>
    );
  }
}
