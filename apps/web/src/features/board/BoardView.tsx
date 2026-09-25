import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { createBoardRenderer } from '@cp2p/renderer';
import type {
  BoardAppearance,
  BoardFocusPreview,
  BoardHighlights,
  BoardHit,
  BoardRenderer,
  RenderModel,
} from '@cp2p/renderer';

export interface BoardViewProps {
  readonly model: RenderModel;
  readonly highlights?: BoardHighlights;
  readonly focusTarget?: BoardHit | null;
  readonly focusPreview?: BoardFocusPreview;
  readonly appearance?: BoardAppearance;
  readonly reducedMotion?: boolean;
  readonly onSelect?: (hit: BoardHit) => void;
  readonly onTargetPreview?: (hit: BoardHit | null) => void;
  readonly onHover?: (hit: BoardHit | null) => void;
  readonly onRendererReady?: (renderer: BoardRenderer) => void;
  readonly className?: string;
  readonly label?: string;
  readonly targetLabel?: (hit: BoardHit) => string;
  readonly onRendererError?: (error: unknown) => void;
}

/** Accessible DOM wrapper; the canvas reports semantic locations for the app to resolve. */
export function BoardView({
  model,
  highlights,
  focusTarget,
  focusPreview,
  appearance,
  reducedMotion = false,
  onSelect,
  onTargetPreview,
  onHover,
  onRendererReady,
  onRendererError,
  className,
  label,
  targetLabel,
}: BoardViewProps) {
  const { t } = useTranslation('common');
  const targetSelectId = useId();
  const accessibleLabel = label ?? t('common:boardDefaultLabel');
  const formatHarborLabel = useCallback(
    (kind: string): string => {
      switch (kind) {
        case 'generic':
          return t('common:harborGeneric');
        case 'brick':
          return t('common:harborBrick');
        case 'lumber':
          return t('common:harborLumber');
        case 'wool':
          return t('common:harborWool');
        case 'grain':
          return t('common:harborGrain');
        case 'ore':
          return t('common:harborOre');
        default:
          return t('common:harborUnknown');
      }
    },
    [t],
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selectedTargetKey, setSelectedTargetKey] = useState('');
  const [targetChooserOpen, setTargetChooserOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const propsRef = useRef({
    model,
    highlights,
    appearance,
    reducedMotion,
    onSelect,
    onTargetPreview,
    onHover,
    onRendererReady,
    onRendererError,
    label: accessibleLabel,
    formatHarborLabel,
  });
  propsRef.current = {
    model,
    highlights,
    appearance,
    reducedMotion,
    onSelect,
    onTargetPreview,
    onHover,
    onRendererReady,
    onRendererError,
    label: accessibleLabel,
    formatHarborLabel,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return () => undefined;
    let active = true;
    const initialize = async (): Promise<void> => {
      try {
        const renderer = await createBoardRenderer(host, {
          ...(propsRef.current.appearance ? { appearance: propsRef.current.appearance } : {}),
          reducedMotion: propsRef.current.reducedMotion,
          accessibleLabel: propsRef.current.label,
          formatHarborLabel: (kind) => propsRef.current.formatHarborLabel(kind),
          onSelect: (hit) => propsRef.current.onSelect?.(hit),
          onHover: (hit) => propsRef.current.onHover?.(hit),
          onReady: (readyRenderer) => {
            if (active) {
              rendererRef.current = readyRenderer;
              propsRef.current.onRendererReady?.(readyRenderer);
            }
          },
        });
        if (!active) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
        if (propsRef.current.appearance) renderer.setAppearance(propsRef.current.appearance);
        renderer.render(propsRef.current.model);
        renderer.setHighlights(propsRef.current.highlights ?? {});
        renderer.setReducedMotion(propsRef.current.reducedMotion);
        setStatus('ready');
      } catch (error) {
        if (active) {
          setStatus('error');
          propsRef.current.onRendererError?.(error);
        }
      }
    };
    void initialize();
    return () => {
      active = false;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
    // The renderer is intentionally created once per host; updates flow through the effects below.
  }, []);

  useEffect(() => rendererRef.current?.render(model), [model]);
  useEffect(() => {
    rendererRef.current?.setHighlights(highlights ?? {});
  }, [highlights]);
  useEffect(() => {
    if (appearance) rendererRef.current?.setAppearance(appearance);
  }, [appearance]);
  useEffect(
    () => rendererRef.current?.setHarborLabelFormatter((kind) => formatHarborLabel(kind)),
    [formatHarborLabel],
  );
  useEffect(() => rendererRef.current?.setReducedMotion(reducedMotion), [reducedMotion]);

  const keyboardTargets: BoardHit[] = [
    ...(highlights?.vertices ?? []).map((id) => ({ kind: 'vertex' as const, id })),
    ...(highlights?.edges ?? []).map((id) => ({ kind: 'edge' as const, id })),
    ...(highlights?.hexes ?? []).map((id) => ({ kind: 'hex' as const, id })),
  ];
  const selectedTarget =
    keyboardTargets.find((hit) => targetKey(hit) === selectedTargetKey) ?? keyboardTargets[0];
  const selectedTargetPreviewKey = selectedTarget ? targetKey(selectedTarget) : '';
  const selectedTargetRef = useRef(selectedTarget);
  selectedTargetRef.current = selectedTarget;

  useEffect(() => {
    const target = focusTarget ?? (targetChooserOpen ? (selectedTargetRef.current ?? null) : null);
    const preview = focusTarget ? focusPreview : undefined;
    if (preview) rendererRef.current?.setFocusTarget(target, preview);
    else rendererRef.current?.setFocusTarget(target);
  }, [focusPreview, focusTarget, selectedTargetPreviewKey, status, targetChooserOpen]);

  useEffect(() => {
    propsRef.current.onTargetPreview?.(
      targetChooserOpen ? (selectedTargetRef.current ?? null) : null,
    );
  }, [onTargetPreview, selectedTargetPreviewKey, targetChooserOpen]);

  return (
    <div
      className={['board-renderer-root', className].filter(Boolean).join(' ')}
      role="group"
      aria-label={accessibleLabel}
      data-testid="board-renderer"
    >
      <div ref={hostRef} className="board-view-canvas" aria-hidden={status !== 'ready'} />
      {status === 'loading' && (
        <div className="board-renderer-status" role="status">
          {t('common:boardRendererLoading')}
        </div>
      )}
      {status === 'error' && (
        <div className="board-renderer-status board-renderer-error" role="alert">
          {t('common:boardRendererError')}
        </div>
      )}
      {keyboardTargets.length > 0 && (
        <details
          className="board-keyboard-targets"
          data-testid="board-keyboard-targets"
          onToggle={(event) => setTargetChooserOpen(event.currentTarget.open)}
        >
          <summary>{t('common:legalBoardTargets', { count: keyboardTargets.length })}</summary>
          <label htmlFor={targetSelectId}>{t('common:boardTargetSelectLabel')}</label>
          <select
            id={targetSelectId}
            value={selectedTarget ? targetKey(selectedTarget) : ''}
            onChange={(event) => setSelectedTargetKey(event.currentTarget.value)}
          >
            {keyboardTargets.map((hit) => (
              <option key={targetKey(hit)} value={targetKey(hit)}>
                {targetLabel?.(hit) ?? describeTarget(hit, t)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!selectedTarget || !onSelect}
            onClick={() => selectedTarget && onSelect?.(selectedTarget)}
          >
            {t('common:boardTargetChoose')}
          </button>
        </details>
      )}
    </div>
  );
}

function targetKey(hit: BoardHit): string {
  return `${hit.kind}:${hit.id}`;
}

function describeTarget(hit: BoardHit, t: TFunction<'common'>): string {
  const kind =
    hit.kind === 'vertex'
      ? t('common:targetKindVertex')
      : hit.kind === 'edge'
        ? t('common:targetKindEdge')
        : t('common:targetKindHex');
  return t('common:targetLabel', { kind, id: hit.id });
}
