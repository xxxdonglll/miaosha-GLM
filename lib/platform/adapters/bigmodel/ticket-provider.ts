import type { ITicketProvider, Ticket } from '../../types';

const CAPTCHA_APPID = '196026326';

type CaptchaCallback = (ticket: Ticket | null) => void;

export class BigmodelTicketProvider implements ITicketProvider {
  readonly providerId = 'tencent-captcha';
  private batchMode = false;
  private batchCount = 0;
  private batchSessionLimit = 100;
  private activeCaptcha: any = null;
  private pendingResolve: CaptchaCallback | null = null;

  private autoSolve = false;
  private ocrServiceUrl = 'http://127.0.0.1:9876';
  private solvingGen = 0;
  private confidenceThreshold = 0.1;
  private clickInterval = 200;
  private clickJitter = 3;

  async produce(): Promise<Ticket | null> {
    if (typeof (window as any).TencentCaptcha === 'undefined') return null;

    return new Promise<Ticket | null>((resolve) => {
      this.pendingResolve = resolve;
      try {
        const c = new (window as any).TencentCaptcha(
          CAPTCHA_APPID,
          (res: any) => {
            this.activeCaptcha = null;
            if (res.ret === 0 && res.ticket) {
              const ticket: Ticket = {
                ticket: res.ticket,
                randstr: res.randstr,
                provider: this.providerId,
                createdAt: Date.now(),
              };
              this.resolve(ticket);
              if (this.batchMode) {
                this.batchCount++;
                if (this.batchCount >= this.batchSessionLimit) {
                  this.stopBatch();
                  return;
                }
                setTimeout(() => this.produce(), 300);
              }
            } else {
              this.resolve(null);
              if (this.batchMode) setTimeout(() => this.produce(), 500);
            }
          },
          { mode: 'popup' },
        );
        this.activeCaptcha = c;
        c.show();
        if (this.autoSolve) {
          setTimeout(() => this.autoSolveCaptcha(), 600);
        }
      } catch {
        this.resolve(null);
      }
    });
  }

  startBatch(): void {
    this.batchMode = true;
    this.batchCount = 0;
    this.produce();
  }

  stopBatch(): void {
    this.batchMode = false;
    this.destroyActive();
  }

  destroyActive(): void {
    if (this.activeCaptcha && typeof this.activeCaptcha.destroy === 'function') {
      try { this.activeCaptcha.destroy(); } catch {}
    }
    this.activeCaptcha = null;
    this.resolve(null);
  }

  setBatchSessionLimit(limit: number): void {
    this.batchSessionLimit = Math.max(1, Math.round(limit));
  }

  setAutoSolve(enabled: boolean): void {
    this.autoSolve = enabled;
  }

  setOcrServiceUrl(url: string): void {
    if (url) this.ocrServiceUrl = url;
  }

  private resolve(ticket: Ticket | null): void {
    if (this.pendingResolve) {
      this.pendingResolve(ticket);
      this.pendingResolve = null;
    }
  }

  // ── OCR auto-solve ──

  private async autoSolveCaptcha(): Promise<void> {
    const gen = ++this.solvingGen;
    const bgEl = document.querySelector('.tencent-captcha-dy__verify-bg-img') as HTMLElement | null;
    const headerEl = document.querySelector('.tencent-captcha-dy__header-text') as HTMLElement | null;
    if (!bgEl || !headerEl) {
      if (this.activeCaptcha) setTimeout(() => this.autoSolveCaptcha(), 200);
      return;
    }

    const headerText = headerEl.textContent || '';
    const chars = headerText.replace('请依次点击：', '').trim().split(/\s+/).filter(Boolean);
    if (chars.length !== 3) {
      if (this.activeCaptcha) setTimeout(() => this.autoSolveCaptcha(), 200);
      return;
    }

    const bg = bgEl.style.backgroundImage;
    const imageUrl = bg.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    if (!imageUrl) {
      if (this.activeCaptcha) setTimeout(() => this.autoSolveCaptcha(), 200);
      return;
    }

    try {
      const res = await fetch(this.ocrServiceUrl + '/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: imageUrl,
          chars,
          confidence_threshold: this.confidenceThreshold,
        }),
      });
      if (!res.ok) throw new Error('OCR service returned ' + res.status);
      const data = await res.json();
      if (!data.positions || data.positions.length !== 3) throw new Error('Invalid OCR response');

      if (gen !== this.solvingGen) return;

      const displayW = bgEl.offsetWidth;
      const displayH = bgEl.offsetHeight;
      const scaleX = displayW / data.image_width;
      const scaleY = displayH / data.image_height;

      let totalDelay = 0;
      const myGen = gen;
      data.positions.forEach((p: { x: number; y: number }, i: number) => {
        const delay = this.clickInterval;
        totalDelay += delay;
        const d = totalDelay;
        setTimeout(() => {
          if (myGen !== this.solvingGen) return;
          const offsetX = (Math.random() - 0.5) * this.clickJitter * 2;
          const offsetY = (Math.random() - 0.5) * this.clickJitter * 2;
          this.clickCaptchaChar(bgEl, p.x * scaleX + offsetX, p.y * scaleY + offsetY);
        }, d);
      });

      setTimeout(() => {
        if (gen !== this.solvingGen) return;
        const confirmBtn = document.querySelector('.tencent-captcha-dy__verify-confirm-btn') as HTMLElement | null;
        if (confirmBtn && !confirmBtn.classList.contains('tencent-captcha-dy__verify-confirm-btn--disabled')) {
          confirmBtn.click();
        }
      }, totalDelay + 300);

      setTimeout(() => {
        if (gen !== this.solvingGen) return;
        const stillOpen = document.querySelector('.tencent-captcha-dy__verify-bg-img');
        if (stillOpen && this.activeCaptcha) {
          const refreshBtn = document.querySelector('.tencent-captcha-dy__footer-icon--refresh') as HTMLElement | null;
          if (refreshBtn) refreshBtn.click();
          setTimeout(() => this.autoSolveCaptcha(), 500);
        }
      }, totalDelay + 1300);
    } catch {
      if (this.activeCaptcha) {
        const refreshBtn = document.querySelector('.tencent-captcha-dy__footer-icon--refresh') as HTMLElement | null;
        if (refreshBtn) refreshBtn.click();
        setTimeout(() => this.autoSolveCaptcha(), 500);
      }
    }
  }

  private clickCaptchaChar(bgEl: HTMLElement, x: number, y: number): void {
    const rect = bgEl.getBoundingClientRect();
    bgEl.dispatchEvent(new MouseEvent('click', {
      clientX: rect.left + x,
      clientY: rect.top + y,
      bubbles: true,
      cancelable: true,
      view: window,
    }));
  }
}
