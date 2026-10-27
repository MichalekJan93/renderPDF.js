// Physical A4 width is 595.28pt; two 24px margins leave this rounded-down CSS-pixel source width.
export const contentWidthPx = 745.7;
// One application-owned family binds preview layout to the same explicit PDF font programs.
export const previewFamily = 'Playground Sans';

/** Discard document font programs because the preview explicitly uses its own registered faces.
 * @param css Inert stylesheet text whose remaining declarations must still pass resource checks.
 */
function omitDocumentFonts(css: string): string {
  if (/@import\b|\\/i.test(css)) {
    throw new Error('Externí zdroje a escapované deklarace v CSS nejsou v tomto náhledu povolené.');
  }
  // Native CSS parsing handles rule boundaries, quoted strings and nested grouping rules.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);

  /** Delete backwards so each removal leaves all remaining rule indexes valid.
   * @param owner Inert stylesheet or conditional group containing authored rules.
   */
  function removeFontRules(owner: CSSStyleSheet | CSSGroupingRule): void {
    for (let index = owner.cssRules.length - 1; index >= 0; index -= 1) {
      // Font declarations are never attached, so their local/URL sources cannot be loaded.
      const rule = owner.cssRules[index];
      if (rule instanceof CSSFontFaceRule) owner.deleteRule(index);
      else if (rule instanceof CSSGroupingRule) removeFontRules(rule);
    }
  }
  removeFontRules(sheet);
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
}

/** Reject active content and resource dependencies before a fragment enters the live document.
 * @param root Inert parsed document or template content to inspect.
 */
function assertStaticHtml(root: ParentNode): void {
  if (
    root.querySelector(
      'script, iframe, frame, object, embed, form, input, button, link, base, audio, video, source, track, svg, math, template, meta[http-equiv]:not([http-equiv="content-type" i]):not([http-equiv="content-language" i])',
    )
  ) {
    throw new Error('Vložte statické HTML bez skriptů, formulářů a vložených dokumentů.');
  }
  // Normalize only inert copies; the editor retains every original declaration for the caller.
  for (const style of root.querySelectorAll('style')) {
    style.textContent = omitDocumentFonts(style.textContent);
  }
  // Both style elements and inline declarations must be independent of external resources.
  const css = [
    ...Array.from(root.querySelectorAll('style'), (element) => element.textContent),
    ...Array.from(root.querySelectorAll('[style]'), (element) => element.getAttribute('style')),
  ].join('\n');
  if (/@import\b|@font-face\b|(?:url|(?:-webkit-)?image-set)\s*\(|\\/i.test(css)) {
    throw new Error('Externí zdroje a vlastní fonty v CSS nejsou v tomto náhledu povolené.');
  }
  for (const element of root.querySelectorAll('*')) {
    // Image sources become inline bitmaps or missing-asset placeholders before live adoption.
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name)) throw new Error('HTML nesmí obsahovat obsluhy událostí.');
      if (
        /^(?:src|srcset|srcdoc|poster|background|href|xlink:href|action|formaction)$/i.test(
          attribute.name,
        ) &&
        !(element.tagName === 'IMG' && attribute.name === 'src')
      ) {
        throw new Error('Externí zdroje nejsou povolené. Obrázky vložte jako data PNG nebo JPEG.');
      }
    }
  }
}

/** Translate document selectors through the browser CSS parser into isolated preview wrappers.
 * @param css Validated CSS whose rules must not reach the surrounding application.
 */
function isolatedCss(css: string): string {
  // Constructable stylesheets parse rules without attaching them to a browsing document.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);

  /** Preserve grouping rules while mapping HTML/BODY type selectors to their matching wrappers.
   * @param rules Browser-parsed rules, including media/supports groups.
   */
  function mapRules(rules: CSSRuleList): void {
    for (const rule of rules) {
      // Scope headers can target the shadow host even when nested selectors are harmless.
      if (/^@scope\b/i.test(rule.cssText)) {
        throw new Error('Pravidla CSS @scope nejsou v tomto izolovaném náhledu podporovaná.');
      }
      if (rule instanceof CSSStyleRule) {
        rule.selectorText = rule.selectorText.replace(
          /(\[(?:[^\]"']|"[^"]*"|'[^']*')*\]|"[^"]*"|'[^']*')|(:root\b)|(^|[\s>+~,(])(html|body)(?=[\s.#:[>+~),]|$)|(:(?:host|host-context)\b|::(?:slotted|part)\b)/gi,
          // Quoted/attribute literals are opaque; only document selectors and shadow escapes change.
          (
            match: string,
            literal: string | undefined,
            rootSelector: string | undefined,
            prefix: string | undefined,
            tag: string | undefined,
            shadowEscape: string | undefined,
          ) => {
            if (literal) return literal;
            if (shadowEscape) {
              throw new Error('CSS náhledu nesmí měnit okolní aplikaci pomocí shadow selektorů.');
            }
            if (rootSelector) return '[data-preview-html]';
            return tag ? `${prefix ?? ''}[data-preview-${tag.toLowerCase()}]` : match;
          },
        );
      }
      if (rule instanceof CSSGroupingRule) mapRules(rule.cssRules);
    }
  }
  mapRules(sheet.cssRules);
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
}

/** Build one isolated, connected-ready browser layout for both the visible preview and PDF.
 * @param html Full static document or HTML fragment supplied by the textarea.
 */
export function createPreview(html: string): {
  container: HTMLElement;
  source: HTMLElement;
  /** Missing assets stay visible in the preview but prevent an incomplete PDF export. */
  exportIssues: readonly string[];
} {
  if (!html.trim()) throw new Error('HTML je prázdné. Nejprve vložte dokument.');
  // Template contents do not fetch image/iframe resources while the initial boundary is inspected.
  const inert = document.createElement('template');
  inert.innerHTML = html;
  assertStaticHtml(inert.content);
  // A second inert parse preserves full-document body attributes after resource validation.
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  assertStaticHtml(parsed);
  // Informational metadata never paints, even when legacy markup places it inside the body.
  for (const metadata of parsed.querySelectorAll('meta')) metadata.remove();
  // Pasted HTML does not carry relative files; placeholders expose missing assets without fetching them.
  const exportIssues: string[] = [];
  for (const image of parsed.querySelectorAll('img')) {
    // Only the converter's supported self-contained bitmap formats can become exportable source images.
    const imageSource = image.getAttribute('src') ?? '';
    if (/^data:image\/(?:png|jpeg);base64,/i.test(imageSource)) continue;
    // Bound labels keep large unsupported data URLs readable while retaining the original textarea value.
    const label = imageSource ? imageSource.slice(0, 160) : 'bez zdroje';
    const placeholder = document.createElement('div');
    placeholder.dataset.previewMissingImage = '';
    placeholder.textContent = `Nedostupný obrázek: ${label}`;
    Object.assign(placeholder.style, {
      padding: '12px',
      border: '1px dashed #a77b27',
      background: '#fff7df',
      color: '#674817',
      overflowWrap: 'anywhere',
    });
    image.replaceWith(placeholder);
    exportIssues.push(
      `Obrázek ${label} není dostupný. Pro PDF vložte jeho src jako PNG/JPEG data URL.`,
    );
  }
  // Styles remain siblings of the exported source, rather than unsupported paintable descendants.
  const authoredStyles = Array.from(parsed.querySelectorAll('style'));
  const styles = document.createElement('style');
  styles.textContent =
    `
    [data-preview-html] { all: initial; display: block; width: ${contentWidthPx}px; }
    [data-preview-body] { padding: 8px; background: white; color: black; font: 16px/normal '${previewFamily}'; }
  ` + isolatedCss(authoredStyles.map((style) => style.textContent).join('\n'));
  for (const style of authoredStyles) style.remove();
  // Separate wrappers retain common html/body selectors without exporting unsupported tag names.
  const container = document.createElement('div');
  const documentRoot = document.createElement('div');
  const source = document.createElement('div');
  for (const attribute of parsed.documentElement.attributes) {
    documentRoot.setAttribute(attribute.name, attribute.value);
  }
  for (const attribute of parsed.body.attributes)
    source.setAttribute(attribute.name, attribute.value);
  documentRoot.dataset.previewHtml = '';
  source.dataset.previewBody = '';
  source.append(...Array.from(parsed.body.childNodes));
  Object.assign(source.style, {
    display: 'flow-root',
    boxSizing: 'border-box',
    width: `${contentWidthPx}px`,
    margin: '0',
  });
  // Font substitution is deliberate and disclosed in the UI; never pair system layout with other bytes.
  for (const element of [source, ...source.querySelectorAll<HTMLElement>('*')]) {
    element.style.setProperty('font-family', previewFamily, 'important');
  }
  documentRoot.append(source);
  documentRoot.inert = true;
  container.append(styles, documentRoot);
  return { container, source, exportIssues };
}
