export type TextSize = 'default' | 'large' | 'larger';

export const TEXT_SIZE_KEY = 'ci-planning-text-size';

function initial(): TextSize {
  try {
    const value = localStorage.getItem(TEXT_SIZE_KEY);
    if (value === 'large' || value === 'larger') return value;
  } catch {
    // Use the default when storage is unavailable.
  }
  return 'default';
}

function applyTextSize(size: TextSize): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.textSize = size;
}

let current = initial();
applyTextSize(current);

export function textSize(): TextSize {
  return current;
}

export function setTextSize(size: TextSize): void {
  current = size;
  applyTextSize(size);
  try {
    if (size === 'default') localStorage.removeItem(TEXT_SIZE_KEY);
    else localStorage.setItem(TEXT_SIZE_KEY, size);
  } catch {
    // The current session still uses the selected size.
  }
}
