interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const margin = 8;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** Place a building confirmation beside its target, or above/below it on a narrow board. */
export function placePlacementConfirmation(
  board: Box,
  target: Point,
  popup: Size,
  viewport: Size,
  gap = 14,
): Point {
  const x = target.x - board.left;
  const y = target.y - board.top;
  const minX = Math.max(margin, margin - board.left);
  const maxX = Math.min(
    board.width - popup.width - margin,
    viewport.width - board.left - popup.width - margin,
  );
  const minY = Math.max(margin, margin - board.top);
  const maxY = Math.min(
    board.height - popup.height - margin,
    viewport.height - board.top - popup.height - margin,
  );
  const right = x + gap;
  const left = x - gap - popup.width;
  if (right <= maxX)
    return {
      x: clamp(right, minX, maxX),
      y: clamp(y - popup.height / 2, minY, maxY),
    };
  if (left >= minX)
    return {
      x: clamp(left, minX, maxX),
      y: clamp(y - popup.height / 2, minY, maxY),
    };
  const above = y - gap - popup.height;
  const below = y + gap;
  return {
    x: clamp(x - popup.width / 2, minX, maxX),
    y: clamp(above >= minY ? above : below, minY, maxY),
  };
}
