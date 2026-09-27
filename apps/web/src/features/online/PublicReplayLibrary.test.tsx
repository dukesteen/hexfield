// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from '../../session/online-public-archive-format.js';
import { PublicReplayLibrary } from './PublicReplayLibrary.js';

const mocks = vi.hoisted(() => ({
  import: vi.fn<() => Promise<string>>(async () => 'a'.repeat(64)),
  navigate: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: () => null,
  useNavigate: () => mocks.navigate,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../queries/online-public-replays.js', () => ({
  usePublicReplays: () => ({ data: [], isError: false }),
  useImportPublicReplay: () => ({ isPending: false, mutateAsync: mocks.import }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('Home rejects an oversized replay file before reading or starting verification', () => {
  const read = vi.fn<() => Promise<ArrayBuffer>>(async () => new ArrayBuffer(1));
  render(<PublicReplayLibrary />);
  fireEvent.change(screen.getByLabelText('lobby:publicReplayChoose'), {
    target: { files: [{ size: MAX_ONLINE_PUBLIC_ARCHIVE_BYTES + 1, arrayBuffer: read }] },
  });
  expect(read).not.toHaveBeenCalled();
  expect(mocks.import).not.toHaveBeenCalled();
});
