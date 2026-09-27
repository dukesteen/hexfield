import { useEffect, useRef, useState } from 'react';
import type { CommandShape } from '@cp2p/engine';
import type { CommandFormProps } from './types.js';

export type CommandValidation = 'checking' | 'valid' | 'invalid';

/** Advisory only. The action controller repeats validation at the current head before submit. */
export function useCommandValidations(
  commands: readonly CommandShape[],
  {
    validate,
    validationKey = '',
    validationSession = null,
  }: Pick<CommandFormProps, 'validate' | 'validationKey' | 'validationSession'>,
): readonly CommandValidation[] {
  const commandsKey = JSON.stringify(commands);
  const key = `${validationKey}:${commandsKey}`;
  const validateRef = useRef(validate);
  validateRef.current = validate;
  const asynchronous =
    validationSession !== null && 'mode' in validationSession && validationSession.mode === 'p2p';
  const [settled, setSettled] = useState<{
    key: string;
    session: object | null;
    values: readonly CommandValidation[];
  } | null>(null);

  useEffect(() => {
    if (!asynchronous) return undefined;
    let current = true;
    const run = async () => {
      const values = await Promise.all(
        commands.map(async (command): Promise<CommandValidation> => {
          try {
            return (await validateRef.current(command)).ok ? 'valid' : 'invalid';
          } catch {
            return 'invalid';
          }
        }),
      );
      if (current) setSettled({ key, session: validationSession, values });
    };
    void run();
    return () => {
      current = false;
    };
    // Commands are represented by their exact serialized fields; render-created objects are not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asynchronous, key, validationSession]);

  if (!asynchronous) {
    return commands.map((command) => {
      try {
        const result = validate(command);
        return 'then' in result ? 'checking' : result.ok ? 'valid' : 'invalid';
      } catch {
        return 'invalid';
      }
    });
  }

  if (settled?.key === key && settled.session === validationSession) return settled.values;
  return commands.map(() => 'checking');
}
