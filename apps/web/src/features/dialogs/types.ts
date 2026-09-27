import type {
  CommandShape,
  GameState,
  LegalCommandSet,
  PrivateState,
  Result,
  Seat,
} from '@cp2p/engine';

/** The controller supplies a current, seat-scoped view and validates before submission. */
export interface CommandFormProps {
  legal: LegalCommandSet;
  privateState: PrivateState;
  state: GameState;
  seat: Seat;
  playerLabel: (seat: Seat) => string;
  validate: (command: CommandShape) => Result<void> | Promise<Result<void>>;
  /** Invalidates advisory results when the certified head or session changes. */
  validationKey?: string;
  validationSession?: object | null;
  onSubmit: (command: CommandShape) => void;
  onCancel?: () => void;
}
