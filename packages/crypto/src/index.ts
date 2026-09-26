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

export {
  G,
  H,
  SCALAR_ORDER,
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  hashToPoint,
  invertScalar,
  modScalar,
  pointFromBytes,
  pointToBytes,
  scalarFromBytes,
  scalarToBytes,
  scalePoint,
} from './group.js';
export type { RistrettoPoint } from './group.js';
export { DERIVATION_LABELS, deriveBytes, deriveScalar } from './derivation.js';
export type { DerivationLabel } from './derivation.js';
export { createHashChain, verifyHashChainLink } from './hash-chain.js';
export { uniformInt } from './uniform.js';
export { createFeldmanShares, recoverSecret, verifyFeldmanShare } from './feldman.js';
export type { FeldmanDistribution, FeldmanShare, FeldmanShareExpectation } from './feldman.js';
export { proofChallenge, proofNonce } from './proof-transcript.js';
export {
  inspectSchnorrProof,
  prepareSchnorrProof,
  simulateSchnorrProof,
  proveDleq,
  proveSchnorr,
  verifyDleq,
  verifySchnorr,
} from './sigma.js';
export type {
  PreparedSchnorrProof,
  DleqProof,
  DleqStatement,
  SchnorrProof,
  SchnorrStatement,
} from './sigma.js';
export { proveCdsOr, verifyCdsOr } from './cds.js';
export type {
  CdsOrStatement,
  CdsOrProof,
  CdsBranchStatement,
  CdsBranchProof,
  CdsBranchWitness,
} from './cds.js';
export {
  inspectBitProof,
  inspectRangeProof,
  pedersenCommit,
  prepareRangeProof,
  proveBit,
  proveRange,
  simulateRangeProof,
  verifyBit,
  verifyRange,
} from './range.js';
export type {
  BitAnnouncements,
  BitProof,
  PreparedRangeProof,
  RangeProof,
  RangeStatement,
} from './range.js';
export { MAX_SEALED_BYTES, openSealed, openSealedWithSharedPoint, seal } from './seal.js';
export type { SealedPayload } from './seal.js';
export { proveShuffle, verifyShuffle } from './shuffle.js';
export type { ShuffleProof, ShuffleResponse, ShuffleStatement } from './shuffle.js';
