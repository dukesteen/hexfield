export const PACKAGE_NAME = '@cp2p/crypto';

export {
  generateIdentity,
  identityFromSecret,
  parsePeerId,
  sign,
  signObject,
  verify,
  verifyObject,
} from './identity.js';
export type { Identity } from './identity.js';
