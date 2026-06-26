import { storage } from '#imports';

export interface CaptchaConfig {
  /** Max captchas to solve in one batch session */
  batchSessionLimit: number;
  /** Whether to auto-solve captcha via local OCR service */
  autoSolve: boolean;
  /** URL of the local OCR service */
  ocrServiceUrl: string;
  /** Minimum confidence to accept an OCR character match (0-1) */
  confidenceThreshold: number;
  /** Click interval in ms between characters */
  clickInterval: number;
  /** Random click jitter in pixels (+/-) */
  clickJitter: number;
}

export const CAPTCHA_CONFIG_DEFAULT: CaptchaConfig = {
  batchSessionLimit: 100,
  autoSolve: false,
  ocrServiceUrl: 'http://127.0.0.1:9876',
  confidenceThreshold: 0.1,
  clickInterval: 200,
  clickJitter: 3,
};

const STORAGE_KEY = 'local:captchaConfig';

export const captchaStore = {
  async get(): Promise<CaptchaConfig> {
    try {
      const stored = await storage.getItem<Partial<CaptchaConfig>>(STORAGE_KEY);
      return {
        ...CAPTCHA_CONFIG_DEFAULT,
        ...(stored || {}),
      };
    } catch {
      return { ...CAPTCHA_CONFIG_DEFAULT };
    }
  },

  async set(config: CaptchaConfig): Promise<void> {
    await storage.setItem(STORAGE_KEY, config);
  },
};
