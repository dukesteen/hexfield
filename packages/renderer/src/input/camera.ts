export interface CameraPoint {
  readonly x: number;
  readonly y: number;
}

/** Place a world point at a screen point after changing zoom. */
export function cameraPositionAtAnchor(
  worldAnchor: CameraPoint,
  screenAnchor: CameraPoint,
  zoom: number,
): CameraPoint {
  return {
    x: screenAnchor.x - worldAnchor.x * zoom,
    y: screenAnchor.y - worldAnchor.y * zoom,
  };
}

/** Clamp one camera axis so board bounds stay visible, or center a smaller board. */
export function clampCameraAxis(
  cameraPosition: number,
  minimumWorld: number,
  maximumWorld: number,
  viewportSize: number,
  zoom: number,
  margin: number,
): number {
  const worldSpan = (maximumWorld - minimumWorld) * zoom;
  if (worldSpan <= viewportSize - margin * 2) {
    return viewportSize / 2 - ((minimumWorld + maximumWorld) * zoom) / 2;
  }
  const lower = viewportSize - margin - maximumWorld * zoom;
  const upper = margin - minimumWorld * zoom;
  return Math.min(upper, Math.max(lower, cameraPosition));
}
