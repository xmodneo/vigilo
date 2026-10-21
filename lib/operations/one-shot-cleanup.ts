/** A terminal heartbeat certifies settled execution, not reporter-client closure. */
export async function closeOneShotBusinessClientAndStopHeartbeat(
  closeBusinessClient: () => Promise<void>,
  stopHeartbeat: (failureCode?: string) => Promise<void>,
  alreadyFailed: boolean,
  executionSettled: boolean,
): Promise<Array<'database_client_close' | 'heartbeat_stop'>> {
  const failures: Array<'database_client_close' | 'heartbeat_stop'> = [];
  try { await closeBusinessClient(); }
  catch { failures.push('database_client_close'); }
  if (executionSettled && failures.length === 0) {
    try { await stopHeartbeat(alreadyFailed ? 'baseline_one_shot_failed' : undefined); }
    catch { failures.push('heartbeat_stop'); }
  }
  return failures;
}
