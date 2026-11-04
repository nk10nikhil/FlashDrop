export type ShutdownStep = { name: string; run: () => Promise<unknown> };

export async function runShutdownSequence(steps: ShutdownStep[], onError: (name: string, error: unknown) => void) {
  for (const step of steps) {
    try { await step.run(); }
    catch (error) { onError(step.name, error); }
  }
}
