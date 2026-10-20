import type { Rectangle } from 'electron';

/** Keep the quick view beside its tray icon, inside the display's work area. */
export function trayWindowBounds(anchor: Rectangle, area: Rectangle): Rectangle {
  const gap = 8;
  const width = Math.min(440, area.width);
  const height = Math.min(520, area.height);
  const above = anchor.y - area.y;
  const below = area.y + area.height - anchor.y - anchor.height;
  const y = above >= height + gap || above > below
    ? anchor.y - height - gap : anchor.y + anchor.height + gap;
  return {
    x: Math.round(Math.max(area.x, Math.min(anchor.x + anchor.width - width, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
    width,
    height,
  };
}
