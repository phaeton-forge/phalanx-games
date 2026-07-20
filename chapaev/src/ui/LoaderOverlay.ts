/**
 * Startup loading overlay — an indeterminate spinner shown while the
 * AssetManager downloads all textures, HDR environment map, and audio files.
 *
 * Lives outside UIManager's Screen enum because it must be visible before
 * the game (and therefore the UIManager) is constructed.
 */
import { t } from '../i18n/i18n.ts';

export class LoaderOverlay {
  private readonly container: HTMLDivElement;
  private visible = false;

  constructor() {
    const root = document.getElementById('ui-root');

    this.container = document.createElement('div');
    this.container.className = 'loader-overlay';
    this.container.setAttribute('role', 'status');
    this.container.setAttribute('aria-live', 'polite');
    this.container.setAttribute('aria-label', t('common.loading'));

    const spinner = document.createElement('div');
    spinner.className = 'loader-spinner';

    const label = document.createElement('div');
    label.className = 'loader-label';
    label.textContent = t('common.loading');

    this.container.appendChild(spinner);
    this.container.appendChild(label);

    (root ?? document.body).appendChild(this.container);
  }

  /** Show the spinner overlay. */
  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.container.classList.add('loader-overlay--visible');
  }

  /** Hide the spinner overlay. */
  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.container.classList.remove('loader-overlay--visible');
  }

  /** Remove the overlay element from the DOM. */
  dispose(): void {
    this.container.remove();
  }
}
