const RELEASE_SHA = /^[0-9a-f]{40}$/;

export function readRuntimeRelease(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = environment.VIGILO_RELEASE_SHA;
  if (!candidate || !RELEASE_SHA.test(candidate)) throw new Error('runtime_release_unavailable');
  return candidate;
}
