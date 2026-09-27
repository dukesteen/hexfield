import type { SchnorrProof, SealedPayload } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';

export interface EscrowShareEnvelope {
  readonly body: {
    readonly protocol: 'escrow-share-v1';
    readonly ceremonyId: string;
    readonly dealer: { readonly seat: Seat; readonly publicKey: string };
    readonly holder: {
      readonly seat: Seat;
      readonly publicKey: string;
      readonly index: number;
      readonly encryptionKey: string;
    };
    readonly threshold: number;
    readonly masterPub: string;
    readonly commitments: readonly string[];
    readonly shareHash: string;
    readonly sealed: SealedPayload;
    readonly ephemeralProof: SchnorrProof;
  };
  readonly sig: string;
}
