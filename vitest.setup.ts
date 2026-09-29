import { beforeEach } from 'vitest';

/**
 * Give the worker's event loop a turn before every test. Vitest sends task updates to the main
 * process without waiting for them, and synchronous tests run back to back without a macrotask in
 * between, so a file of long synchronous tests could hold the reply past Vitest's 60 s RPC limit
 * and fail the run with "Timeout calling onTaskUpdate" although every test passed.
 */
beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
