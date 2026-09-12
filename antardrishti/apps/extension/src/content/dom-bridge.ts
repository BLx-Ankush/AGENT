/**
 * ANTARDRISHTI — DOM Bridge
 *
 * Collects DOM and reconstructed accessibility semantics from the page.
 * Does NOT claim native accessibility tree access — reconstructs
 * accessibility-like semantics from DOM and ARIA.
 *
 * Phase 1: basic viewport info + element discovery
 * Phase 2: full harvest with sensitivity hints, forms, frames
 */

// ── Types ────────────────────────────────────────────────────

export interface ViewportInfo {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
  zoom: number;
  documentTitle: string;
  origin: string;
  url: string;
}

export interface BasicNodeInfo {
  id: string;
  tag: string;
  role: string;
  name: string;
  bbox: { x: number; y: number; width: number; height: number };
  isVisible: boolean;
  isInteractive: boolean;
  inputType?: string;
  autocomplete?: string;
}

// ── DOM Bridge ───────────────────────────────────────────────

export class DomBridge {
  private nodeCounter = 0;

  /** Collect a snapshot of visible DOM elements. */
  collectSnapshot(): BasicNodeInfo[] {
    const nodes: BasicNodeInfo[] = [];
    this.nodeCounter = 0;

    const selector =
      'a, button, input, select, textarea, [role], [tabindex], ' +
      'label, img, h1, h2, h3, h4, h5, h6, canvas, svg';

    for (const el of document.querySelectorAll(selector)) {
      if (!(el instanceof HTMLElement)) continue;

      const rect = el.getBoundingClientRect();

      // Skip invisible / off-viewport
      if (
        rect.width < 1 ||
        rect.height < 1 ||
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      )
        continue;

      const style = getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        parseFloat(style.opacity) === 0
      )
        continue;

      nodes.push({
        id: `node-${++this.nodeCounter}`,
        tag: el.tagName.toLowerCase(),
        role: this.inferRole(el),
        name: this.computeAccessibleName(el),
        bbox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        isVisible: true,
        isInteractive: this.isInteractiveElement(el),
        inputType:
          el instanceof HTMLInputElement ? el.type : undefined,
        autocomplete:
          el instanceof HTMLInputElement
            ? el.autocomplete || undefined
            : undefined,
      });
    }

    return nodes;
  }

  /** Get current viewport information. */
  getViewportInfo(): ViewportInfo {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
      zoom: 1,
      documentTitle: document.title,
      origin: window.location.origin,
      url: window.location.href,
    };
  }

  // ── Role inference (reconstructed, not native a11y tree) ──

  private inferRole(el: HTMLElement): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a':
        return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button':
        return 'button';
      case 'input': {
        const t = (el as HTMLInputElement).type;
        if (t === 'submit' || t === 'button' || t === 'reset')
          return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'slider';
        if (t === 'search') return 'searchbox';
        return 'textbox';
      }
      case 'select':
        return 'combobox';
      case 'textarea':
        return 'textbox';
      case 'img':
        return 'img';
      case 'canvas':
        return 'img'; // visual content
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'header':
        return 'banner';
      case 'footer':
        return 'contentinfo';
      case 'aside':
        return 'complementary';
      case 'form':
        return 'form';
      case 'table':
        return 'table';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'ul':
      case 'ol':
        return 'list';
      case 'li':
        return 'listitem';
      case 'dialog':
        return 'dialog';
      default:
        return 'generic';
    }
  }

  // ── Accessible name computation (simplified) ──────────────

  private computeAccessibleName(el: HTMLElement): string {
    // aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    // aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() || '')
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    // Label association
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      if (el.id) {
        const label = document.querySelector(
          `label[for="${CSS.escape(el.id)}"]`,
        );
        if (label) return label.textContent?.trim() || '';
      }
      const parentLabel = el.closest('label');
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll('input, select, textarea')
          .forEach((c) => c.remove());
        const text = clone.textContent?.trim();
        if (text) return text;
      }
      if ('placeholder' in el && el.placeholder) return el.placeholder;
    }

    // title
    const title = el.getAttribute('title');
    if (title) return title.trim();

    // alt (images)
    if (el instanceof HTMLImageElement && el.alt) return el.alt.trim();

    // Text content
    const text = el.textContent?.trim();
    if (text && text.length <= 200) return text;

    return '';
  }

  private isInteractiveElement(el: HTMLElement): boolean {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea'].includes(tag))
      return true;
    if (
      el.hasAttribute('tabindex') &&
      el.getAttribute('tabindex') !== '-1'
    )
      return true;
    if (el.getAttribute('role') === 'button') return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }
}
