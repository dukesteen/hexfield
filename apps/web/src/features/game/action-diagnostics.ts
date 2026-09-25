let rejectedSubmissions = 0;

/** DEV diagnostics for ordinary controls; raw dev commands are deliberately excluded. */
export function ordinaryActionRejectionCount(): number {
  return rejectedSubmissions;
}

export function recordOrdinaryActionRejection(): void {
  rejectedSubmissions += 1;
}

export function resetOrdinaryActionRejections(): void {
  rejectedSubmissions = 0;
}
