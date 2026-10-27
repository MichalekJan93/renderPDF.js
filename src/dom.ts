import { RenderPDFError } from './diagnostics.js';

/** Read computed CSS through the window that actually laid out the source element. */
export function computedStyle(element: Element, pseudo?: string): CSSStyleDeclaration {
  const view = element.ownerDocument.defaultView;
  if (!view) throw new RenderPDFError('INVALID_SOURCE', 'The source document has no live window.');
  return view.getComputedStyle(element, pseudo);
}

/** Recognize HTML nodes across same-origin iframe JavaScript realms. */
export function isHtmlElement(node: Node): node is HTMLElement {
  return node.nodeType === 1 && (node as Element).namespaceURI === 'http://www.w3.org/1999/xhtml';
}

/** Recognize one native HTML tag without relying on the caller window's constructor. */
export function isHtmlTag<K extends keyof HTMLElementTagNameMap>(
  node: Node,
  tag: K,
): node is HTMLElementTagNameMap[K] {
  return isHtmlElement(node) && node.localName === tag;
}

/** A shadow tree may belong to another window, so identify its DOM shape directly. */
export function isShadowRoot(node: Node): node is ShadowRoot {
  return node.nodeType === 11 && 'host' in node;
}
