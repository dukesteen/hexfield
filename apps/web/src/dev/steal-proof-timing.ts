const button = document.querySelector<HTMLButtonElement>('#run');
const output = document.querySelector<HTMLPreElement>('#result');
if (!button || !output) throw new Error('Missing timing controls');

button.addEventListener('click', () => {
  button.disabled = true;
  output.textContent = 'Running three samples…';
  const worker = new Worker(new URL('./steal-proof-timing.worker.ts', import.meta.url), {
    type: 'module',
  });
  const timeout = window.setTimeout(() => finish('Timed out after 15 seconds.'), 15_000);
  function finish(result: string) {
    window.clearTimeout(timeout);
    worker.terminate();
    if (output) output.textContent = result;
    if (button) button.disabled = false;
  }
  worker.addEventListener('message', (event: MessageEvent<unknown>) =>
    finish(JSON.stringify(event.data, null, 2)),
  );
  worker.addEventListener('error', (event) => finish(`Failed: ${event.message}`));
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messaging has no targetOrigin.
  worker.postMessage('run');
});
