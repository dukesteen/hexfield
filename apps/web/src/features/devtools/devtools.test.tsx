// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { BoardRenderer } from '@cp2p/renderer';
import { standardFixedBoard } from '@cp2p/maps';
import editor from '../../i18n/locales/en/editor.json';
import { LocalSession } from '../../session/local-session.js';
import { deriveActionAvailability } from '../actions/availability.js';
import { DevDrawer } from './DevDrawer.js';
import { installDevHook, type DevHookView } from './hook.js';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { editor } }, initImmediate: false });
});
afterEach(cleanup);

function makeSession(): LocalSession {
  const made = LocalSession.create({
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1],
      options: { base: { mapLayout: 'standard-fixed' } },
      board: standardFixedBoard(),
    },
    humanSeats: [0, 1],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(9),
  });
  if (!made.ok) throw new Error(made.error.message);
  return made.value;
}

describe('development diagnostics', () => {
  test('hook exposes current diagnostics and renderer coordinates, then cleans up safely', () => {
    const session = makeSession();
    const renderer: BoardRenderer = {
      render() {},
      setHighlights() {},
      setFocusTarget() {},
      setAppearance() {},
      setReducedMotion() {},
      playEffects() {},
      skipAnimations() {},
      getDiagnostics: () => ({
        renderedFrames: 0,
        rebuiltLayers: 0,
        activeEffects: 0,
        queuedDisposals: 0,
      }),
      setHarborLabelFormatter() {},
      hitTest: () => null,
      subscribeViewChange(listener) {
        listener();
        return () => undefined;
      },
      getPixelPosition: () => ({ x: 18, y: 29 }),
      boardToScreen: (point) => point,
      screenToBoard: (point) => point,
      fitToBoard() {},
      destroy() {},
    };
    const seat = session.getPending().find((item) => item.kind === 'player')?.seat;
    if (seat === undefined) throw new Error('No setup choice');
    const actions = deriveActionAvailability(
      session.getLegalCommands(seat),
      session.getPending(),
      seat,
    );
    const view: DevHookView = { renderer, actions: null };
    const remove = installDevHook({ session, view });
    const hook = Reflect.get(window, '__cp2p');
    view.actions = { revision: hook?.diagnostics().revision ?? -1, availability: actions };
    expect(hook?.session).toBe(session);
    expect(hook?.diagnostics().actions).toEqual(actions);
    expect(hook?.diagnostics().actions).not.toBe(actions);
    expect(hook?.diagnostics().hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hook?.pixelPosition({ kind: 'vertex', id: 'v:0,0,N' })).toEqual({ x: 18, y: 29 });
    const updatedActions = { ...actions, availableTypes: ['UPDATED'] };
    const updatedRenderer: BoardRenderer = {
      ...renderer,
      getPixelPosition: () => ({ x: 31, y: 47 }),
    };
    view.actions = { revision: -1, availability: updatedActions };
    view.renderer = updatedRenderer;
    expect(Reflect.get(window, '__cp2p')).toBe(hook);
    expect(hook?.renderer).toBe(updatedRenderer);
    expect(hook?.diagnostics().actions).toBeNull();
    view.actions = { revision: hook?.diagnostics().revision ?? -1, availability: updatedActions };
    expect(hook?.diagnostics().actions).toEqual(updatedActions);
    expect(hook?.diagnostics().actions).not.toBe(updatedActions);
    expect(hook?.pixelPosition({ kind: 'vertex', id: 'v:0,0,N' })).toEqual({ x: 31, y: 47 });
    view.actions = null;
    view.renderer = null;
    expect(hook?.diagnostics().actions).toBeNull();
    expect(hook?.pixelPosition({ kind: 'vertex', id: 'v:0,0,N' })).toBeNull();
    const removeNewer = installDevHook({ session, view: { renderer: null, actions: null } });
    remove();
    expect(Reflect.get(window, '__cp2p')).toBeTruthy();
    removeNewer();
    expect(Reflect.get(window, '__cp2p')).toBeUndefined();
    session.dispose();
  });

  test('drawer exports authoritative saves and validates raw commands through the session', async () => {
    const session = makeSession();
    const onImportSave = vi.fn<(raw: unknown) => Promise<void>>(async () => {});
    const onExportSave = vi.fn<(save: unknown) => Promise<void>>(async () => {});
    const onExportReplay = vi.fn<(save: unknown) => Promise<void>>(async () => {});
    render(
      <I18nextProvider i18n={i18n}>
        <DevDrawer
          session={session}
          onImportSave={onImportSave}
          onExportSave={onExportSave}
          onExportReplay={onExportReplay}
        />
      </I18nextProvider>,
    );
    expect(screen.queryByText(/State hash:/)).toBeNull();
    fireEvent.click(screen.getByText('Developer tools'));
    fireEvent.click(screen.getByText('Force next dice'));
    expect(screen.getByRole('status').textContent).toContain('The next random dice result is set.');
    fireEvent.click(screen.getByText('Export authoritative save'));
    await waitFor(() => expect(onExportSave).toHaveBeenCalledOnce());
    expect(onExportSave.mock.calls[0]?.[0]).toEqual(session.exportSave());
    fireEvent.click(screen.getByText('Export replay JSON'));
    await waitFor(() => expect(onExportReplay).toHaveBeenCalledOnce());
    expect(onExportReplay.mock.calls[0]?.[0]).toEqual(session.exportSave());
    fireEvent.change(screen.getByLabelText('Authoritative save JSON'), {
      target: { value: JSON.stringify(session.exportSave()) },
    });
    fireEvent.click(screen.getByText('Load save'));
    await waitFor(() => expect(onImportSave).toHaveBeenCalledOnce());
    expect(onImportSave.mock.calls[0]?.[0]).toEqual(session.exportSave());

    const pending = session.getPending().find((item) => item.kind === 'player');
    if (pending?.kind !== 'player') throw new Error('No setup choice');
    const command = session.getLegalCommands(pending.seat).commands[0];
    if (!command) throw new Error('No setup command');
    fireEvent.change(screen.getByLabelText('Command seat'), {
      target: { value: String(pending.seat) },
    });
    fireEvent.change(screen.getByLabelText('Raw command JSON'), {
      target: { value: '{"type":"NOT_A_COMMAND"}' },
    });
    fireEvent.click(screen.getByText('Apply raw command'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('unknown-command'),
    );
    expect(session.exportSave().batches).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Raw command JSON'), {
      target: { value: JSON.stringify(command) },
    });
    fireEvent.click(screen.getByText('Apply raw command'));
    await waitFor(() => expect(session.exportSave().batches).toHaveLength(1));
    expect(session.exportSave().batches[0]?.submitted).toEqual({
      kind: 'command',
      seat: pending.seat,
      command,
    });
    session.dispose();
  });
});
