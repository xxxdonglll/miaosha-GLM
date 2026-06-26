import { storage } from '#imports';

export interface FireConfig {
  /** Payment method passed to create-sign */
  payType: 'ALI' | 'WE_CHAT';
  /** Delay between sequential burst shots (ms) */
  burstIntervalMs: number;
  /** Max shots per single launch (0 = unlimited) */
  maxShots: number;
  /** Automatically logout and re-login when maxShots is reached */
  autoRelogin: boolean;
}

export const FIRE_CONFIG_DEFAULT: FireConfig = {
  payType: 'ALI',
  burstIntervalMs: 2100,
  maxShots: 11,
  autoRelogin: false,
};

const STORAGE_KEY = 'local:fireConfig';

function clampInterval(value: number, fallback: number): number {
  const n = Math.round(value);
  if (!Number.isFinite(n) || n < 50) return fallback;
  return n;
}

export const fireStore = {
  async get(): Promise<FireConfig> {
    try {
      const stored = await storage.getItem<Partial<FireConfig>>(STORAGE_KEY);
      if (!stored) return { ...FIRE_CONFIG_DEFAULT };
      return {
        payType: stored.payType === 'WE_CHAT' ? 'WE_CHAT' : FIRE_CONFIG_DEFAULT.payType,
        burstIntervalMs: clampInterval(stored.burstIntervalMs ?? FIRE_CONFIG_DEFAULT.burstIntervalMs, FIRE_CONFIG_DEFAULT.burstIntervalMs),
        maxShots: Number.isFinite(stored.maxShots) ? Math.max(0, Math.round(stored.maxShots)) : FIRE_CONFIG_DEFAULT.maxShots,
        autoRelogin: typeof stored.autoRelogin === 'boolean' ? stored.autoRelogin : FIRE_CONFIG_DEFAULT.autoRelogin,
      };
    } catch {
      return { ...FIRE_CONFIG_DEFAULT };
    }
  },

  async set(config: FireConfig): Promise<void> {
    await storage.setItem(STORAGE_KEY, {
      payType: config.payType === 'WE_CHAT' ? 'WE_CHAT' : 'ALI',
      burstIntervalMs: clampInterval(config.burstIntervalMs, FIRE_CONFIG_DEFAULT.burstIntervalMs),
      maxShots: Number.isFinite(config.maxShots) ? Math.max(0, Math.round(config.maxShots)) : FIRE_CONFIG_DEFAULT.maxShots,
      autoRelogin: typeof config.autoRelogin === 'boolean' ? config.autoRelogin : FIRE_CONFIG_DEFAULT.autoRelogin,
    });
  },
};
