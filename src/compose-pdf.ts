import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFSignature,
  PDFString,
} from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import type { PDFMetadata, RenderPDFResult, RenderProgress } from './api-types.js';
import { RenderPDFError, throwIfAborted } from './diagnostics.js';
import { applyPDFMetadata, resolveMetadata } from './export-options.js';
import { withCancellation } from './prepare.js';
import { createProgressReporter } from './progress.js';
import { createResult } from './result.js';
import { validatePDFInput, type PDFInputBudget } from './pdf-input.js';

/** An existing PDF or an immutable export result; URLs are fetched by the application. */
export type PDFSource = Blob | ArrayBuffer | Uint8Array | Pick<RenderPDFResult, 'toUint8Array'>;

/** Shared metadata and cooperative cancellation for native page composition. */
export interface PDFCompositionOptions {
  /** Properties of the new document; source document metadata is not merged. */
  metadata?: PDFMetadata;
  /** Cancel between loading, page copying and serialization stages. */
  signal?: AbortSignal;
  /** Frozen stage-local counters, using preparing/resources/pages/saving/complete. */
  onProgress?: (progress: RenderProgress) => void;
  /** Flatten ordinary prepared AcroForm fields before copying pages; signed and XFA files still fail. */
  flattenForms?: boolean;
}

/** Capture mutable sources immediately; delayed readers retain only immutable owners. */
type OwnedSource = Uint8Array | Blob | (() => Promise<Uint8Array>);

/** Page destinations are rewritten after every selected page has its final reference. */
interface InternalLink {
  annotation: number;
  target: number;
  action: boolean;
}

/** Explicit limits bound allocation and avoid an unexpectedly huge browser operation. */
const MAX_PAGES = 1_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Reject malformed runtime settings before any asynchronous reading starts. */
function resolveOptions(options: PDFCompositionOptions) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'PDF composition options must be an object.');
  }
  const { signal, onProgress, flattenForms = false } = options;
  if (typeof flattenForms !== 'boolean') {
    throw new RenderPDFError('INVALID_OPTIONS', 'flattenForms must be a boolean.');
  }
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new RenderPDFError('INVALID_OPTIONS', 'onProgress must be a function.');
  }
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new RenderPDFError('INVALID_OPTIONS', 'signal must be an AbortSignal.');
  }
  throwIfAborted(signal);
  return { signal, onProgress, flattenForms, metadata: resolveMetadata(options.metadata) };
}

/** Validate file size before allocating a copy or reading an immutable Blob. */
function assertSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SOURCE_BYTES) {
    throw new RenderPDFError('INVALID_SOURCE', 'Each source PDF must contain 1 byte to 128 MiB.');
  }
}

/** Own all caller bytes before the operation reaches its first await. */
function ownSources(sources: readonly PDFSource[]): OwnedSource[] {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_PAGES) {
    throw new RenderPDFError('INVALID_SOURCE', 'Provide between 1 and 1,000 source PDFs.');
  }
  let total = 0;
  return Array.from(sources, (source): OwnedSource => {
    if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
      assertSize(source.byteLength);
      total += source.byteLength;
      if (total > MAX_TOTAL_BYTES) {
        throw new RenderPDFError('INVALID_SOURCE', 'Combined source PDFs must not exceed 256 MiB.');
      }
      return Uint8Array.from(source instanceof Uint8Array ? source : new Uint8Array(source));
    }
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      assertSize(source.size);
      total += source.size;
      if (total > MAX_TOTAL_BYTES) {
        throw new RenderPDFError('INVALID_SOURCE', 'Combined source PDFs must not exceed 256 MiB.');
      }
      return source;
    }
    if (
      source &&
      typeof source === 'object' &&
      'toUint8Array' in source &&
      typeof source.toUint8Array === 'function'
    ) {
      const read = source.toUint8Array.bind(source);
      return async () => {
        const bytes: unknown = await read();
        if (!(bytes instanceof Uint8Array)) {
          throw new RenderPDFError(
            'INVALID_SOURCE',
            'The PDF result must return Uint8Array bytes.',
          );
        }
        assertSize(bytes.byteLength);
        return Uint8Array.from(bytes);
      };
    }
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'Provide PDF bytes, a File/Blob or a PDF export result.',
    );
  });
}

/** Bound the actual page tree before backend recursion or cached page counts can traverse it. */
function validatePageTree(pdf: PDFDocument, signal?: AbortSignal): void {
  // Repeated nodes, including shared subtrees, must never multiply backend traversal work.
  const visited = new Set<PDFDict>();
  const root = pdf.catalog.lookup(PDFName.of('Pages'), PDFDict);

  /** Count each real leaf once and verify its declared ownership and subtree count.
   * @param node Current page-tree dictionary, resolved through the donor context.
   * @param parent Actual containing Pages dictionary; absent only for the root.
   * @param depth Bounded tree edges from the root, independent of encoded-object nesting.
   */
  function visit(node: PDFDict, parent: PDFDict | undefined, depth: number): number {
    throwIfAborted(signal);
    if (depth > 64 || visited.has(node)) {
      throw new RenderPDFError(
        'INVALID_SOURCE',
        'PDF page tree must be unique, acyclic and at most 64 levels deep.',
      );
    }
    visited.add(node);
    // Matching Parent references also prevents cycles during inherited-resource lookup.
    const owner = node.lookupMaybe(PDFName.of('Parent'), PDFDict);
    if (parent ? owner !== parent : owner !== undefined) {
      throw new RenderPDFError('INVALID_SOURCE', 'PDF page tree has an invalid Parent reference.');
    }
    const type = node.get(PDFName.of('Type'))?.toString();
    if (type === '/Page') {
      if (node.has(PDFName.of('Kids'))) {
        throw new RenderPDFError('INVALID_SOURCE', 'A PDF page leaf cannot contain Kids.');
      }
      return 1;
    }
    if (type !== '/Pages') {
      throw new RenderPDFError(
        'INVALID_SOURCE',
        'PDF page tree must contain Pages branches and Page leaves.',
      );
    }
    // A valid tree with at most 1,000 leaves never needs a branch wider than that limit.
    const children = node.lookup(PDFName.of('Kids'), PDFArray);
    if (children.size() === 0 || children.size() > MAX_PAGES) {
      throw new RenderPDFError(
        'INVALID_SOURCE',
        'PDF page-tree branches must contain 1 to 1,000 children.',
      );
    }
    let pages = 0;
    for (let index = 0; index < children.size(); index += 1) {
      const reference = children.get(index);
      if (!(reference instanceof PDFRef)) {
        throw new RenderPDFError(
          'INVALID_SOURCE',
          'PDF page-tree children must be indirect references.',
        );
      }
      pages += visit(pdf.context.lookup(reference, PDFDict), node, depth + 1);
      if (pages > MAX_PAGES) {
        throw new RenderPDFError(
          'INVALID_SOURCE',
          'Each source PDF must contain 1 to 1,000 pages.',
        );
      }
    }
    const declared = node.lookup(PDFName.of('Count'), PDFNumber).asNumber();
    if (declared !== pages) {
      throw new RenderPDFError('INVALID_SOURCE', 'PDF page-tree Count disagrees with its leaves.');
    }
    return pages;
  }

  visit(root, undefined, 0);
}

/** Bound AcroForm ownership before backend field enumeration recursively follows Kids/Parent. */
function validateFormTree(pdf: PDFDocument, form: PDFDict, signal?: AbortSignal): void {
  // Field/widget dictionaries must appear once even when their serialized references are shared.
  const visited = new Set<PDFDict>();

  /** Inspect one field or widget without constructing backend form wrappers.
   * @param node Current field/widget dictionary resolved from one indirect reference.
   * @param parent Actual containing field; top-level Fields have no Parent.
   * @param depth Number of field ownership edges from the root Fields array.
   */
  function visit(node: PDFDict, parent: PDFDict | undefined, depth: number): void {
    throwIfAborted(signal);
    if (depth > 64 || visited.has(node) || visited.size >= 100_000) {
      throw new RenderPDFError(
        'INVALID_SOURCE',
        'PDF form tree exceeds its unique, acyclic ownership limits.',
      );
    }
    visited.add(node);
    const owner = node.lookupMaybe(PDFName.of('Parent'), PDFDict);
    if (parent ? owner !== parent : owner !== undefined) {
      throw new RenderPDFError('INVALID_SOURCE', 'PDF form tree has an invalid Parent reference.');
    }
    if (['A', 'AA', 'Next'].some((key) => node.has(PDFName.of(key)))) {
      throw new RenderPDFError('INVALID_SOURCE', 'PDF form actions cannot be flattened.');
    }
    const children = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (!children) return;
    for (let index = 0; index < children.size(); index += 1) {
      const reference = children.get(index);
      if (!(reference instanceof PDFRef)) {
        throw new RenderPDFError(
          'INVALID_SOURCE',
          'PDF form children must be indirect references.',
        );
      }
      visit(pdf.context.lookup(reference, PDFDict), node, depth + 1);
    }
  }

  const roots = form.lookupMaybe(PDFName.of('Fields'), PDFArray);
  for (let index = 0; index < (roots?.size() ?? 0); index += 1) {
    const reference = roots!.get(index);
    if (!(reference instanceof PDFRef)) {
      throw new RenderPDFError('INVALID_SOURCE', 'PDF form fields must be indirect references.');
    }
    visit(pdf.context.lookup(reference, PDFDict), undefined, 0);
  }
}

/** Reject active page/annotation actions before copying or flattening any donor objects. */
function assertSafeActions(pdf: PDFDocument): void {
  for (const page of pdf.getPages()) {
    if (page.node.has(PDFName.of('AA'))) {
      throw new RenderPDFError(
        'INVALID_SOURCE',
        'PDF page additional actions cannot be preserved.',
      );
    }
    const annotations = page.node.Annots();
    for (let index = 0; index < (annotations?.size() ?? 0); index += 1) {
      const annotation = annotations!.lookup(index, PDFDict);
      if (annotation.has(PDFName.of('AA')) || annotation.has(PDFName.of('Next'))) {
        throw new RenderPDFError(
          'INVALID_SOURCE',
          'PDF annotation additional/chained actions cannot be preserved.',
        );
      }
      const action = annotation.lookupMaybe(PDFName.of('A'), PDFDict);
      if (!action) continue;
      const actionType = action.get(PDFName.of('S'))?.toString();
      if (
        action.has(PDFName.of('Next')) ||
        action.has(PDFName.of('AA')) ||
        !['/URI', '/GoTo'].includes(actionType ?? '')
      ) {
        throw new RenderPDFError(
          'INVALID_SOURCE',
          'This PDF annotation action cannot be preserved.',
        );
      }
      if (actionType === '/URI') {
        // PDF strings are decoded through public APIs; byte escapes cannot conceal an unsafe scheme.
        const value = pdf.context.lookup(action.get(PDFName.of('URI')));
        if (!(value instanceof PDFString) && !(value instanceof PDFHexString))
          throw new RenderPDFError(
            'INVALID_SOURCE',
            'PDF links require a literal or hexadecimal URI string.',
          );
        const text = value.decodeText();
        if (
          !text.trim() ||
          Array.from(text).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        )
          throw new RenderPDFError(
            'INVALID_SOURCE',
            'PDF links cannot contain control characters.',
          );
        let url: URL;
        try {
          url = new URL(text);
        } catch (cause) {
          throw new RenderPDFError(
            'INVALID_SOURCE',
            'PDF links require an absolute supported URI.',
            { cause },
          );
        }
        if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol))
          throw new RenderPDFError(
            'INVALID_SOURCE',
            'PDF links support HTTP, HTTPS, mailto and tel URIs only.',
          );
      }
    }
  }
}

/** Inspect navigation without creating an AcroForm or modifying the donor document. */
function inspectLinks(pdf: PDFDocument): InternalLink[][] {
  assertSafeActions(pdf);
  const form = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (form?.has(PDFName.of('XFA')) || form?.lookupMaybe(PDFName.of('Fields'), PDFArray)?.size()) {
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'Interactive PDF forms must be flattened before page composition.',
    );
  }
  const pages = pdf.getPages();
  const references = new Map(pages.map((page, index) => [page.ref.toString(), index]));
  return pages.map((page) => {
    const links: InternalLink[] = [];
    const annotations = page.node.Annots();
    for (let index = 0; index < (annotations?.size() ?? 0); index += 1) {
      const annotation = annotations!.lookup(index, PDFDict);
      if (annotation.get(PDFName.of('Subtype'))?.toString() === '/Widget') {
        throw new RenderPDFError(
          'INVALID_SOURCE',
          'PDF widget annotations must be flattened first.',
        );
      }
      const action = annotation.lookupMaybe(PDFName.of('A'), PDFDict);
      const actionType = action?.get(PDFName.of('S'))?.toString();
      if (action && actionType !== '/URI' && actionType !== '/GoTo') {
        throw new RenderPDFError(
          'INVALID_SOURCE',
          'This PDF annotation action cannot be preserved.',
        );
      }
      const direct = annotation.get(PDFName.of('Dest'));
      const destination =
        direct ?? (actionType === '/GoTo' ? action!.get(PDFName.of('D')) : undefined);
      if (destination) {
        const array = pdf.context.lookup(destination);
        const targetRef = array instanceof PDFArray ? array.get(0) : undefined;
        const target =
          targetRef instanceof PDFRef ? references.get(targetRef.toString()) : undefined;
        if (target === undefined) {
          throw new RenderPDFError(
            'INVALID_SOURCE',
            'Named or invalid PDF link destinations cannot be preserved during page composition.',
          );
        }
        links.push({ annotation: index, target, action: direct === undefined });
      }
    }
    return links;
  });
}

/** Load strictly and leave encryption handling to the parser's rejecting default. */
async function loadSource(
  bytes: Uint8Array,
  signal?: AbortSignal,
  flattenForms = false,
  budget?: PDFInputBudget,
) {
  try {
    // Reject structural allocation hazards before the backend performs eager object/xref inflation.
    await validatePDFInput(bytes, signal, budget);
    const pdf = await withCancellation(
      PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }),
      signal,
    );
    validatePageTree(pdf, signal);
    const count = pdf.getPageCount();
    if (count === 0 || count > MAX_PAGES) {
      throw new RenderPDFError('INVALID_SOURCE', 'Each source PDF must contain 1 to 1,000 pages.');
    }
    // Flattening must not silently remove actions that the source policy otherwise rejects.
    assertSafeActions(pdf);
    if (flattenForms) {
      // Flatten only fields whose existing appearances can become ordinary page paint.
      const form = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
      if (form?.has(PDFName.of('XFA'))) {
        throw new RenderPDFError(
          'INVALID_SOURCE',
          'XFA forms cannot be flattened for composition.',
        );
      }
      if (form?.lookupMaybe(PDFName.of('Fields'), PDFArray)?.size()) {
        validateFormTree(pdf, form, signal);
        if (
          pdf
            .getForm()
            .getFields()
            .some((field) => field instanceof PDFSignature)
        ) {
          throw new RenderPDFError(
            'INVALID_SOURCE',
            'Signed PDF forms cannot be flattened for composition.',
          );
        }
        pdf.getForm().flatten({ updateFieldAppearances: false });
        // pdf-lib can retain deleted widget references after flattening.
        for (const page of pdf.getPages()) {
          const annotations = page.node.Annots();
          if (!annotations) continue;
          for (let index = annotations.size() - 1; index >= 0; index -= 1) {
            if (!pdf.context.lookup(annotations.get(index))) annotations.remove(index);
          }
        }
      }
    }
    return { pdf, links: inspectLinks(pdf) };
  } catch (cause) {
    throwIfAborted(signal);
    if (cause instanceof RenderPDFError) throw cause;
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'The source PDF is malformed, encrypted or contains unsupported page structures.',
      { cause },
    );
  }
}

/** Read one owned source without depending on browser document state. */
async function readSource(source: OwnedSource, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  try {
    return typeof source === 'function'
      ? await withCancellation(source(), signal)
      : source instanceof Uint8Array
        ? source
        : new Uint8Array(await withCancellation(source.arrayBuffer(), signal));
  } catch (cause) {
    throwIfAborted(signal);
    if (cause instanceof RenderPDFError) throw cause;
    throw new RenderPDFError('INVALID_SOURCE', 'The source PDF bytes could not be read.', {
      cause,
    });
  }
}

/** Share strict PDF input loading with the document builder; not a public entry-point export. */
export async function loadPDFSource(source: PDFSource, signal?: AbortSignal): Promise<PDFDocument> {
  throwIfAborted(signal);
  const owned = ownSources([source])[0]!;
  return (await loadSource(await readSource(owned, signal), signal)).pdf;
}

/** Update page ownership and local link references after native copying. */
function rewriteAnnotations(
  page: PDFPage,
  links: readonly InternalLink[],
  targets: ReadonlyMap<number, PDFPage>,
  sourceIndex: number,
): void {
  const originals = page.node.Annots();
  if (!originals) return;
  // copyPages shares nested resources when a donor page is repeated; ownership and destinations cannot be shared.
  const context = page.doc.context;
  const annotations = context.obj([]);
  for (let index = 0; index < originals.size(); index += 1) {
    const annotation = originals.lookup(index, PDFDict).clone(context);
    annotation.set(PDFName.of('P'), page.ref);
    const destination = annotation.lookupMaybe(PDFName.of('Dest'), PDFArray);
    if (destination) annotation.set(PDFName.of('Dest'), destination.clone(context));
    const action = annotation.lookupMaybe(PDFName.of('A'), PDFDict);
    if (action) {
      const ownedAction = action.clone(context);
      if (action.get(PDFName.of('S'))?.toString() === '/GoTo') {
        ownedAction.set(PDFName.of('D'), action.lookup(PDFName.of('D'), PDFArray).clone(context));
      }
      annotation.set(PDFName.of('A'), ownedAction);
    }
    annotations.push(context.register(annotation));
  }
  page.node.set(PDFName.of('Annots'), annotations);
  for (const link of links) {
    const annotation = annotations!.lookup(link.annotation, PDFDict);
    const dictionary = link.action ? annotation.lookup(PDFName.of('A'), PDFDict) : annotation;
    const destination = dictionary.lookup(PDFName.of(link.action ? 'D' : 'Dest'), PDFArray);
    destination.set(0, link.target === sourceIndex ? page.ref : targets.get(link.target)!.ref);
  }
}

/** Reuse validated native page copying and local navigation in the document builder. */
export async function appendPDFPages(
  target: PDFDocument,
  donor: PDFDocument,
  pageNumbers?: readonly number[],
  signal?: AbortSignal,
): Promise<readonly PDFPage[]> {
  throwIfAborted(signal);
  // Direct internal callers may supply a document that did not pass loadSource.
  validatePageTree(donor, signal);
  if (pageNumbers !== undefined && !Array.isArray(pageNumbers)) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'pageNumbers must be an array of one-based numbers.',
    );
  }
  const selected =
    pageNumbers === undefined
      ? donor.getPageIndices()
      : Array.from(pageNumbers, (page) => page - 1);
  if (
    selected.length === 0 ||
    target.getPageCount() + selected.length > MAX_PAGES ||
    selected.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= donor.getPageCount(),
    )
  ) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Select valid one-based pages within the 1,000-page limit.',
    );
  }
  const links = inspectLinks(donor);
  const available = new Set(selected);
  for (const index of selected) {
    if (links[index]!.some((link) => !available.has(link.target))) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'A selected page links to a page absent from its output document.',
      );
    }
  }
  // The target is caller-owned: finish this mutation before reporting cancellation.
  const pages = await target.copyPages(donor, selected);
  throwIfAborted(signal);
  const targets = new Map<number, PDFPage>();
  for (const [offset, index] of selected.entries()) {
    const page = pages[offset]!;
    target.addPage(page);
    if (!targets.has(index)) targets.set(index, page);
  }
  for (const [offset, index] of selected.entries())
    rewriteAnnotations(pages[offset]!, links[index]!, targets, index);
  return Object.freeze(pages);
}

/** Share input ownership, validation and native copying across merge, extract and split. */
async function compose(
  sources: readonly PDFSource[],
  selection: readonly number[] | undefined,
  split: boolean,
  options: PDFCompositionOptions,
): Promise<readonly RenderPDFResult[]> {
  const { signal, onProgress, flattenForms, metadata } = resolveOptions(options);
  if (selection !== undefined && (selection.length === 0 || selection.length > MAX_PAGES)) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Select 1 to 1,000 one-based integer page numbers.',
    );
  }
  const chosen = selection === undefined ? undefined : Array.from(selection);
  if (
    chosen &&
    (chosen.length === 0 ||
      chosen.length > MAX_PAGES ||
      chosen.some((page) => !Number.isSafeInteger(page) || page < 1))
  ) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Select 1 to 1,000 one-based integer page numbers.',
    );
  }
  const owned = ownSources(sources);
  const progress = createProgressReporter(onProgress, signal);
  const report = progress.report;
  try {
    if (report) await report({ stage: 'preparing', completed: 0, total: owned.length });
    const loaded: Awaited<ReturnType<typeof loadSource>>[] = [];
    // Every source shares one preflight budget, so many small donors cannot multiply structural limits.
    const inputBudget: PDFInputBudget = {
      decodedStructuralBytes: 0,
      objectCount: 0,
      tokenCount: 0,
    };
    let totalBytes = 0;
    let plannedPages = 0;
    for (const [index, source] of owned.entries()) {
      throwIfAborted(signal);
      const bytes = await readSource(source, signal);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new RenderPDFError('INVALID_SOURCE', 'Combined source PDFs must not exceed 256 MiB.');
      }
      const donor = await loadSource(bytes, signal, flattenForms, inputBudget);
      plannedPages += chosen?.length ?? donor.pdf.getPageCount();
      if (plannedPages > MAX_PAGES) {
        throw new RenderPDFError(
          'INVALID_OPTIONS',
          'A composition may produce at most 1,000 pages.',
        );
      }
      loaded.push(donor);
      if (report) await report({ stage: 'preparing', completed: index + 1, total: owned.length });
    }
    const plans = loaded.map((source) => ({
      ...source,
      indices: chosen ? chosen.map((page) => page - 1) : source.pdf.getPageIndices(),
    }));
    const totalPages = plans.reduce((sum, plan) => sum + plan.indices.length, 0);
    if (totalPages > MAX_PAGES) {
      throw new RenderPDFError('INVALID_OPTIONS', 'A composition may produce at most 1,000 pages.');
    }
    for (const plan of plans) {
      const selected = new Set(plan.indices);
      for (const index of plan.indices) {
        if (index >= plan.pdf.getPageCount()) {
          throw new RenderPDFError(
            'INVALID_OPTIONS',
            'A selected page number exceeds the source PDF.',
          );
        }
        if (
          plan.links[index]!.some(
            (link) => !selected.has(link.target) || (split && link.target !== index),
          )
        ) {
          throw new RenderPDFError(
            'INVALID_OPTIONS',
            'A selected page links to a page absent from its output document.',
          );
        }
      }
    }
    const outputCount = split ? totalPages : 1;
    if (report) await report({ stage: 'resources', completed: 0, total: outputCount });
    const outputs: PDFDocument[] = [];
    for (let index = 0; index < outputCount; index += 1) {
      const output = await withCancellation(PDFDocument.create(), signal);
      applyPDFMetadata(output, metadata);
      outputs.push(output);
      if (report) await report({ stage: 'resources', completed: index + 1, total: outputCount });
    }
    if (report) await report({ stage: 'pages', completed: 0, total: totalPages });
    let completed = 0;
    for (const plan of plans) {
      throwIfAborted(signal);
      const target = outputs[0]!;
      const copies = split
        ? undefined
        : await withCancellation(target.copyPages(plan.pdf, plan.indices), signal);
      const targets = new Map<number, PDFPage>();
      const placed: { page: PDFPage; index: number }[] = [];
      for (const [offset, index] of plan.indices.entries()) {
        throwIfAborted(signal);
        const output = split ? outputs[completed]! : target;
        const page =
          copies?.[offset] ??
          (await withCancellation(output.copyPages(plan.pdf, [index]), signal))[0]!;
        output.addPage(page);
        if (!targets.has(index)) targets.set(index, page);
        if (split) rewriteAnnotations(page, plan.links[index]!, new Map([[index, page]]), index);
        else placed.push({ page, index });
        completed += 1;
        if (report) await report({ stage: 'pages', completed, total: totalPages });
      }
      for (const entry of placed)
        rewriteAnnotations(entry.page, plan.links[entry.index]!, targets, entry.index);
    }
    if (report) await report({ stage: 'saving', completed: 0, total: outputs.length });
    const results: RenderPDFResult[] = [];
    for (const [index, output] of outputs.entries()) {
      throwIfAborted(signal);
      const bytes = await withCancellation(output.save({ addDefaultPage: false }), signal);
      results.push(createResult(bytes, output.getPageCount(), []));
      if (report) await report({ stage: 'saving', completed: index + 1, total: outputs.length });
    }
    if (report) await report({ stage: 'complete', completed: 1, total: 1 });
    throwIfAborted(signal);
    return Object.freeze(results);
  } catch (error) {
    return progress.rethrow(
      error instanceof RenderPDFError
        ? error
        : new RenderPDFError('PDF_WRITE_FAILED', 'PDF pages could not be composed.', {
            cause: error,
          }),
    );
  }
}

/** Merge native pages in source order, preserving text, vectors, dimensions and rotation.
 * Interactive forms must be flattened. Document-level outlines, signatures and attachments are not copied.
 */
export async function mergePDFs(
  sources: readonly PDFSource[],
  options: PDFCompositionOptions = {},
): Promise<RenderPDFResult> {
  return (await compose(sources, undefined, false, options))[0]!;
}

/** Copy selected one-based pages in caller order; repeated numbers produce repeated pages. */
export async function extractPDFPages(
  source: PDFSource,
  pageNumbers: readonly number[],
  options: PDFCompositionOptions = {},
): Promise<RenderPDFResult> {
  if (!Array.isArray(pageNumbers)) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'pageNumbers must be an array of one-based numbers.',
    );
  }
  return (await compose([source], pageNumbers, false, options))[0]!;
}

/** Split into one PDF per page; cross-page links require a multi-page extraction instead. */
export async function splitPDF(
  source: PDFSource,
  options: PDFCompositionOptions = {},
): Promise<readonly RenderPDFResult[]> {
  return compose([source], undefined, true, options);
}
