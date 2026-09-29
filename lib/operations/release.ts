const RELEASE_SHA = /^[0-9a-f]{40}$/;

export function readRuntimeRelease(
  environment: NodeJS.ProcessEnv = process.env,
  options: { testReleaseSha?: string } = {},
): string {
  const candidate = environment.NODE_ENV === 'test' && options.testReleaseSha
    ? options.testReleaseSha
    : environment.VIGILO_RELEASE_SHA?.trim();
  if (!candidate || !RELEASE_SHA.test(candidate)) throw new Error('runtime_release_unavailable');
  return candidate;
}
