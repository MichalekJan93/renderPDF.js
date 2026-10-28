import { RenderPDFError, throwIfAborted } from './diagnostics.js';
import { computedStyle, isHtmlElement, isHtmlTag, isShadowRoot } from './dom.js';

/** Wait for one browser stage while releasing the cancellation listener on every outcome. */
export async function withCancellation<T>(
  /** Work whose underlying browser API may not itself accept an AbortSignal. */
  pending: Promise<T>,
  /** Optional application cancellation. */
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    /** Reject promptly while allowing the underlying read-only browser work to settle. */
    const abort = () => reject(new DOMException('PDF rendering was cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Observe caller ownership throughout preparation, capture and asynchronous PDF writing. */
export function prepareSource(
  /** Connected browser element; a live source is measured without cloning application state. */
  root: HTMLElement,
  /** Optional cancellation for fonts and image preparation. */
  signal?: AbortSignal,
  /** Full CSSOM verification, or faster mutation-only checks with weaker guarantees. */
  verifySource: 'full' | 'mutations' = 'full',
) {
  throwIfAborted(signal);
  if (!root || !isHtmlElement(root) || !root.isConnected || !root.ownerDocument.defaultView) {
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'Provide a connected HTMLElement in a live browser document.',
    );
  }
  if (verifySource !== 'full' && verifySource !== 'mutations') {
    throw new RenderPDFError('INVALID_OPTIONS', 'Source verification must be full or mutations.');
  }
  // All browser APIs must belong to the source realm, including a same-origin iframe.
  const sourceDocument = root.ownerDocument;
  const sourceWindow = sourceDocument.defaultView!;
  // Mutation monitoring begins synchronously, before the public async call yields to its caller.
  let changed = false;
  // The fingerprint is set after resource readiness, when normal font/image layout has settled.
  let fingerprint: string | undefined;
  // Repeated CSS names/values share an exact identifier for this export, never a cached DOM read.
  const identifiers = new Map<string, number>();
  // Source changes, ancestor attributes and stylesheets can invalidate browser coordinates.
  const observer = new sourceWindow.MutationObserver(() => {
    changed = true;
  });
  // Ancestors can change clipping, opacity or transforms through CSSOM without a DOM edit.
  const ancestors: Element[] = [];
  observer.observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
  // Walk through a shadow host as well as ordinary ancestors; source styles may be inherited.
  let ancestor: Element | null = root.parentElement;
  // A detached shadow parent is represented by its host rather than parentElement.
  const tree = root.getRootNode();
  if (isShadowRoot(tree)) {
    observer.observe(tree, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    ancestor ??= tree.host;
  }
  while (ancestor) {
    ancestors.push(ancestor);
    observer.observe(ancestor, { attributes: true });
    ancestor =
      ancestor.parentElement ??
      (isShadowRoot(ancestor.getRootNode()) ? (ancestor.getRootNode() as ShadowRoot).host : null);
  }
  observer.observe(sourceDocument.head, {
    subtree: true,
    attributes: true,
    childList: true,
    characterData: true,
  });
  // CSSOM lists the same browser-supported properties first, followed by element-specific custom names.
  // Cache only those fixed names; every computed value is still read again at each assertion.
  const standardProperties =
    verifySource === 'full'
      ? Array.from(computedStyle(sourceDocument.documentElement)).filter(
          (property) => !property.startsWith('--'),
        )
      : [];

  /** Capture computed styles and root-relative geometry, including CSSOM-only stylesheet edits. */
  function currentFingerprint(): string {
    // Stream exact value identifiers into two checksums without retaining every element's CSS.
    let primary = 2166136261;
    // The second accumulator makes accidental equality of distinct style states less likely.
    let secondary = 5381;

    /** Intern complete CSSOM values once instead of hashing their characters millions of times. */
    function append(
      /** Computed value or coordinate fragment participating in the stable-state check. */
      value: string,
    ): void {
      // Keep the dictionary across assertions so any changed name or value keeps a distinct identity.
      let identifier = identifiers.get(value);
      if (identifier === undefined) {
        identifier = identifiers.size + 1;
        identifiers.set(value, identifier);
      }
      primary = Math.imul(primary ^ identifier, 16777619);
      secondary = Math.imul(secondary, 33) ^ identifier;
    }

    /** Include computed paint inputs, omitting the declarations of nonexistent pseudo boxes. */
    function appendStyle(
      /** Element whose inherited or local paint can affect the source. */
      element: Element,
      /** Optional generated-content box. */
      pseudo?: string,
    ): void {
      // CSSOM rule edits do not create MutationObserver records, so inspect their computed effect.
      const style = computedStyle(element, pseudo);
      append(pseudo ?? 'element');
      if (pseudo) {
        append(style.content);
        if (style.content === 'none' || style.content === 'normal') return;
      }
      // Native indexed access also recomputes the property count; avoid it for the fixed prefix.
      const length = style.length;
      // Empty/partial declaration lists retain native enumeration instead of assuming a full schema.
      const properties = length >= standardProperties.length ? standardProperties : [];
      // Fixed property positions already identify their names; retain counts and dynamic names explicitly.
      append(String(length));
      for (let index = 0; index < length; index += 1) {
        // Preserve all standard and custom property names, including changes with equal counts.
        const property = properties[index] ?? style[index]!;
        if (index >= properties.length) append(property);
        append(style.getPropertyValue(property));
      }
    }

    // Absolute viewport position can change on scrolling without altering source coordinates.
    const origin = root.getBoundingClientRect();
    // Surrounding opacity/transforms and inherited typography must stay consistent too.
    for (const element of ancestors) appendStyle(element);
    for (const element of [root, ...root.querySelectorAll('*')]) {
      // Generated backgrounds and text can affect local raster captures without source mutation.
      appendStyle(element);
      appendStyle(element, '::before');
      appendStyle(element, '::after');
      // Measured relative geometry also detects layout shifts caused by external application UI.
      const bounds = element.getBoundingClientRect();
      append(`${bounds.x - origin.x},${bounds.y - origin.y},${bounds.width},${bounds.height}`);
    }
    return `${primary >>> 0}:${secondary >>> 0}`;
  }

  /** Reject changed ownership instead of producing PDF text and pixels from different source states. */
  function assertUnchanged(): void {
    throwIfAborted(signal);
    if (observer.takeRecords().length) changed = true;
    if (
      !root.isConnected ||
      changed ||
      (verifySource === 'full' && fingerprint !== undefined && currentFingerprint() !== fingerprint)
    ) {
      throw new RenderPDFError(
        'SOURCE_CHANGED',
        'The source or its styles changed during PDF rendering. Retry with a stable source.',
      );
    }
  }

  /** Record the state immediately after synchronous measurement, without an intervening await. */
  function captureBaseline(): void {
    assertUnchanged();
    // Running CSS animations produce time-dependent pixels even when no DOM mutation occurs.
    if (
      [
        ...root.getAnimations({ subtree: true }),
        ...ancestors.flatMap((element) => element.getAnimations()),
      ].some((animation) => animation.playState === 'running')
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Pause source animations before rendering a PDF.',
      );
    }
    // Synchronous measurement and this baseline observe one browser state in the same task.
    if (verifySource === 'full') fingerprint = currentFingerprint();
  }

  /** Settle browser resources once, without modifying source markup or dimensions. */
  async function ready(): Promise<void> {
    await withCancellation(sourceDocument.fonts.ready, signal);
    try {
      await withCancellation(
        Promise.all(
          [...root.querySelectorAll('img'), ...(isHtmlTag(root, 'img') ? [root] : [])].map(
            /** decode() also waits for a pending same-origin or CORS image request. */
            (image) => image.decode(),
          ),
        ),
        signal,
      );
    } catch (cause) {
      throwIfAborted(signal);
      throw new RenderPDFError('RESOURCE_LOAD_FAILED', 'A source image could not be decoded.', {
        cause,
      });
    }
    assertUnchanged();
  }

  return { ready, captureBaseline, assertUnchanged, dispose: () => observer.disconnect() };
}
