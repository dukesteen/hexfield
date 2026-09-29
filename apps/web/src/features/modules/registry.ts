import type { ComponentType, ReactNode } from 'react';
import type { GameEvent, GameState, RenderHint, Seat } from '@cp2p/engine';
import type { BoardRenderer, FixtureArt, RenderLayerPlugin } from '@cp2p/renderer';
import type { GamePresentation } from '../../queries/repositories/saved-games';

export interface ModuleHudProps {
  readonly state: Readonly<GameState>;
  readonly hints: readonly RenderHint[];
  readonly presentation: GamePresentation;
  /** The board renderer once it is ready, for widgets that follow the camera. */
  readonly renderer: BoardRenderer | null;
  /** Open the dialog a module registered for one of its fixtures. */
  readonly openFixture: (fixtureId: string) => void;
}

export interface ModulePanelProps {
  readonly state: Readonly<GameState>;
  readonly seat: Seat;
  readonly presentation: GamePresentation;
}

export interface ModuleDialogProps {
  readonly state: Readonly<GameState>;
  readonly hints: readonly RenderHint[];
  readonly presentation: GamePresentation;
  readonly onClose: () => void;
}

/** Everything a rules module may add to the web app. Every entry is optional. */
export interface UiModule {
  /** Extra lines inside a player's panel. */
  readonly PlayerPanelExtras?: ComponentType<ModulePanelProps>;
  /** Overlays above the board, such as a phase banner or an off-screen countdown. */
  readonly HudWidgets?: readonly ComponentType<ModuleHudProps>[];
  /** Art and live-state rendering for this module's fixtures, keyed by fixture art id. */
  readonly BoardFixtures?: Readonly<Record<string, FixtureArt>>;
  /** Extra action-bar entries for this module's commands. */
  readonly ActionBarItems?: readonly ComponentType<ModuleHudProps>[];
  /** Dialogs keyed by the module's phase or fixture id (opened by a fixture tap). */
  readonly Dialogs?: Readonly<Record<string, ComponentType<ModuleDialogProps>>>;
  /** Event-log text for this module's events, keyed by event type. */
  readonly LogFormatters?: Readonly<
    Record<string, (event: GameEvent, name: (seat: Seat) => string) => ReactNode>
  >;
  /** Renderer plugin layers and a function that slices the render model for them. */
  readonly RenderLayers?: readonly {
    readonly plugin: RenderLayerPlugin;
    readonly slice: (state: Readonly<GameState>, hints: readonly RenderHint[]) => unknown;
  }[];
  /** Lobby option labels or hidden options for this module's option schema. */
  readonly LobbyOptionOverrides?: Readonly<
    Record<string, { readonly labelKey?: string; readonly hidden?: boolean }>
  >;
}

const registry = new Map<string, UiModule>();

/** Register a module's UI. Registration is idempotent per module id. */
export function registerUiModule(id: string, module: UiModule): void {
  registry.set(id, module);
}

/** The registered UI modules for a game's module list, in that order. */
export function uiModulesFor(moduleIds: readonly string[]): { id: string; ui: UiModule }[] {
  return moduleIds.flatMap((id) => {
    const ui = registry.get(id);
    return ui ? [{ id, ui }] : [];
  });
}

export function uiModule(id: string): UiModule | undefined {
  return registry.get(id);
}
