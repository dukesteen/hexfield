import { fileURLToPath } from 'node:url';

export const SIM_PLACEHOLDER = 'simulation CLI pending';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(SIM_PLACEHOLDER);
}
