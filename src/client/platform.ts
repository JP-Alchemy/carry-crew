// Portal SDK bridge. CrazyGames and Poki inject their SDKs; everywhere else these are harmless no-ops.
// Ads never interrupt gameplay: only between courses, and rewarded ads are always optional.

interface CrazySDK {
  init?: () => Promise<void>;
  game: { gameplayStart(): void; gameplayStop(): void; happytime(): void; loadingStart?(): void; loadingStop?(): void };
  ad: { requestAd(type: 'midgame' | 'rewarded', cb: { adFinished?: () => void; adError?: (e: unknown) => void; adStarted?: () => void }): void };
}
interface PokiSDKT {
  init(): Promise<void>;
  gameplayStart(): void;
  gameplayStop(): void;
  commercialBreak(): Promise<void>;
  rewardedBreak(): Promise<boolean>;
  gameLoadingFinished?(): void;
}

declare global {
  interface Window {
    CrazyGames?: { SDK: CrazySDK };
    PokiSDK?: PokiSDKT;
  }
}

export type PortalName = 'crazygames' | 'poki' | 'web';

class Platform {
  name: PortalName = 'web';
  private playing = false;

  async init() {
    try {
      if (window.CrazyGames?.SDK) {
        this.name = 'crazygames';
        await window.CrazyGames.SDK.init?.();
      } else if (window.PokiSDK) {
        this.name = 'poki';
        await window.PokiSDK.init();
      }
    } catch {
      this.name = 'web';
    }
  }

  loaded() {
    if (this.name === 'poki') window.PokiSDK?.gameLoadingFinished?.();
    if (this.name === 'crazygames') window.CrazyGames?.SDK.game.loadingStop?.();
  }

  gameplayStart() {
    if (this.playing) return;
    this.playing = true;
    if (this.name === 'crazygames') window.CrazyGames!.SDK.game.gameplayStart();
    if (this.name === 'poki') window.PokiSDK!.gameplayStart();
  }

  gameplayStop() {
    if (!this.playing) return;
    this.playing = false;
    if (this.name === 'crazygames') window.CrazyGames!.SDK.game.gameplayStop();
    if (this.name === 'poki') window.PokiSDK!.gameplayStop();
  }

  happyTime() {
    if (this.name === 'crazygames') window.CrazyGames!.SDK.game.happytime();
  }

  /** Short ad between courses. */
  async commercialBreak(): Promise<void> {
    if (this.name === 'poki') return window.PokiSDK!.commercialBreak().catch(() => undefined);
    if (this.name === 'crazygames')
      return new Promise((res) => window.CrazyGames!.SDK.ad.requestAd('midgame', { adFinished: () => res(), adError: () => res() }));
  }

  /** Optional rewarded ad. Resolves true if the reward should be granted. */
  async rewardedBreak(): Promise<boolean> {
    if (this.name === 'poki') return window.PokiSDK!.rewardedBreak().catch(() => false);
    if (this.name === 'crazygames')
      return new Promise((res) => window.CrazyGames!.SDK.ad.requestAd('rewarded', { adFinished: () => res(true), adError: () => res(false) }));
    // Plain web build: no ad network, so the bonus is simply granted.
    return true;
  }
}

export const platform = new Platform();
