export interface PlayerPreferences {
  readonly sensitivityX: number;
  readonly sensitivityY: number;
  readonly invertY: boolean;
  readonly fov: number;
  readonly cameraMotion: number;
  readonly shake: number;
  readonly reducedMotion: boolean;
  readonly showDiagnostics: boolean;
}

export type PlayerPreferencesPatch = Partial<PlayerPreferences>;

const STORAGE_KEY = "foldseek.preferences.v1";
const DEFAULTS: PlayerPreferences = {
  sensitivityX: 1,
  sensitivityY: 1,
  invertY: false,
  fov: 62,
  cameraMotion: 0.65,
  shake: 0.7,
  reducedMotion: false,
  showDiagnostics: false,
};

const listeners = new Set<(preferences: PlayerPreferences) => void>();

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function normalize(input: Partial<PlayerPreferences>): PlayerPreferences {
  return {
    sensitivityX: clamp(input.sensitivityX, 0.25, 2.5, DEFAULTS.sensitivityX),
    sensitivityY: clamp(input.sensitivityY, 0.25, 2.5, DEFAULTS.sensitivityY),
    invertY: typeof input.invertY === "boolean" ? input.invertY : DEFAULTS.invertY,
    fov: clamp(input.fov, 50, 90, DEFAULTS.fov),
    cameraMotion: clamp(input.cameraMotion, 0, 1, DEFAULTS.cameraMotion),
    shake: clamp(input.shake, 0, 1, DEFAULTS.shake),
    reducedMotion: typeof input.reducedMotion === "boolean" ? input.reducedMotion : DEFAULTS.reducedMotion,
    showDiagnostics: typeof input.showDiagnostics === "boolean" ? input.showDiagnostics : DEFAULTS.showDiagnostics,
  };
}

function load(): PlayerPreferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULTS : normalize(JSON.parse(raw) as Partial<PlayerPreferences>);
  } catch {
    return DEFAULTS;
  }
}

let current = load();

function applyDocumentPreference(preferences: PlayerPreferences): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.reducedMotion = preferences.reducedMotion ? "true" : "false";
}

applyDocumentPreference(current);

export function getPlayerPreferences(): PlayerPreferences {
  return current;
}

export function setPlayerPreferences(patch: PlayerPreferencesPatch): PlayerPreferences {
  current = normalize({ ...current, ...patch });
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // A Portals iframe may deny storage; preferences still apply for this page.
  }
  applyDocumentPreference(current);
  for (const listener of listeners) listener(current);
  return current;
}

export function subscribePlayerPreferences(listener: (preferences: PlayerPreferences) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
