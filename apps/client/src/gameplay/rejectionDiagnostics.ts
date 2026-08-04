import type { CommandRejection } from "../networking/NetworkAdapter";

export interface RejectionDiagnostic {
  readonly atLocalMs: number;
  readonly phase: string | null;
  readonly commandType: string;
  readonly reason: string;
  readonly detail: string | null;
}

const MAX_REJECTION_DIAGNOSTICS = 100;
const diagnostics: RejectionDiagnostic[] = [];

/**
 * Keeps authority refusals available to diagnostics without turning transport
 * races and validation details into player-facing error cards.
 */
export function recordRejectionDiagnostic(
  rejection: CommandRejection,
  phase: string | null,
  atLocalMs = Date.now(),
): void {
  diagnostics.push({
    atLocalMs,
    phase,
    commandType: rejection.type,
    reason: rejection.reason,
    detail: rejection.detail ?? null,
  });
  if (diagnostics.length > MAX_REJECTION_DIAGNOSTICS) {
    diagnostics.splice(0, diagnostics.length - MAX_REJECTION_DIAGNOSTICS);
  }
  console.debug("[round] command rejection retained in diagnostics", diagnostics.at(-1));
}

export function readRejectionDiagnostics(): readonly RejectionDiagnostic[] {
  return diagnostics.slice();
}

export function clearRejectionDiagnostics(): void {
  diagnostics.length = 0;
}
