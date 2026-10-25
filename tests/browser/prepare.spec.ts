import { expect, test } from '@playwright/test';

test('source guards retain complete CSSOM state across repeated stable checks', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/invoice.html');
  // Exercise source ownership directly without allocating unrelated PDF font programs.
  const evidence = await page.evaluate(async () => {
    // Vite loads the same preparation stage used by the public rendering pipeline.
    const modulePath = '/src/prepare.ts';
    // Keep browser imports checked against the actual internal module contract.
    const { prepareSource } = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import('../../src/prepare');
    // A synthetic flex sibling can change source geometry without editing the observed subtree.
    document.body.innerHTML =
      '<div id="guard-wrapper"><div id="guard-sibling"></div><main id="guard-source"><span>Český stabilní text.</span></main></div>';
    // CSSOM changes deliberately leave the stylesheet's DOM text node untouched.
    const style = document.createElement('style');
    style.textContent = `
      #guard-source { flex: 1; min-width: 0; height: 80px; }
      #guard-source::before { content: ""; display: block; width: 8px; height: 4px; }
      #guard-sibling { flex: none; width: 40px; height: 20px; }
      #guard-wrapper { display: flex; width: 400px; height: 80px; }
    `;
    document.head.append(style);
    // These live rules permit value swaps and property-name changes without DOM mutations.
    const sourceRule = style.sheet!.cssRules[0] as CSSStyleRule;
    // Existing generated content must participate even when no DOM child represents it.
    const pseudoRule = style.sheet!.cssRules[1] as CSSStyleRule;
    // The sibling is outside the source and is not one of its observed ancestors.
    const siblingRule = style.sheet!.cssRules[2] as CSSStyleRule;
    // All independent cases start from the same computed values and property names.
    const baseSourceCss =
      'flex: 1; min-width: 0; height: 80px; color: rgb(12, 34, 56); background-color: rgb(65, 43, 21); --first: alpha; --second: beta;';
    // The connected source remains unchanged except for the deliberate CSSOM effect under test.
    const source = document.querySelector<HTMLElement>('#guard-source')!;
    // Reusing values already present in the baseline detects incorrect interning or order handling.
    const cases = [
      {
        label: 'standard value swap',
        change: () => {
          sourceRule.style.color = 'rgb(65, 43, 21)';
          sourceRule.style.backgroundColor = 'rgb(12, 34, 56)';
        },
      },
      {
        label: 'custom value swap',
        change: () => {
          sourceRule.style.setProperty('--first', 'beta');
          sourceRule.style.setProperty('--second', 'alpha');
        },
      },
      {
        label: 'custom property addition',
        change: () => sourceRule.style.setProperty('--third', 'alpha'),
      },
      {
        label: 'custom property removal',
        change: () => sourceRule.style.removeProperty('--first'),
      },
      {
        label: 'custom property rename',
        change: () => {
          sourceRule.style.removeProperty('--first');
          sourceRule.style.setProperty('--renamed', 'alpha');
        },
      },
      {
        label: 'pseudo value swap',
        change: () => {
          pseudoRule.style.width = '4px';
          pseudoRule.style.height = '8px';
        },
      },
      {
        label: 'external sibling geometry',
        change: () => {
          siblingRule.style.width = '80px';
        },
      },
    ];
    // Structured outcomes expose the failed invariant without relying on timing thresholds.
    const outcomes: {
      label: string;
      mutationRecords: number;
      sourceChanged: boolean;
      propertyCountBefore: number;
      propertyCountAfter: number;
      widthBefore: number;
      widthAfter: number;
    }[] = [];
    // Independent cases exercise the same guard repeatedly before and after its deliberate edit.
    for (const scenario of cases) {
      sourceRule.style.cssText = baseSourceCss;
      pseudoRule.style.cssText = 'content: ""; display: block; width: 8px; height: 4px;';
      siblingRule.style.width = '40px';
      // The independent observer proves these changes require computed-state detection.
      const observer = new MutationObserver(() => {});
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      // Each export owns one state map shared by readiness and all subsequent checks.
      const prepared = prepareSource(source);
      try {
        await prepared.ready();
        prepared.captureBaseline();
        prepared.assertUnchanged();
        prepared.assertUnchanged();
        // Retain counts to prove a rename is detected even when cardinality stays equal.
        const propertyCountBefore = getComputedStyle(source).length;
        // External sibling edits must affect actual source layout rather than only unused CSS.
        const widthBefore = source.getBoundingClientRect().width;
        scenario.change();
        // Read records synchronously before any observer callback could consume them.
        const mutationRecords = observer.takeRecords().length;
        // A stable-state rejection is the required result for every independent CSSOM edit.
        let sourceChanged = false;
        try {
          prepared.assertUnchanged();
        } catch (error) {
          sourceChanged =
            error instanceof Error && 'code' in error && error.code === 'SOURCE_CHANGED';
        }
        outcomes.push({
          label: scenario.label,
          mutationRecords,
          sourceChanged,
          propertyCountBefore,
          propertyCountAfter: getComputedStyle(source).length,
          widthBefore,
          widthAfter: source.getBoundingClientRect().width,
        });
        // Newly encountered values must not invalidate the retained IDs of the original state.
        sourceRule.style.cssText = baseSourceCss;
        pseudoRule.style.cssText = 'content: ""; display: block; width: 8px; height: 4px;';
        siblingRule.style.width = '40px';
        prepared.assertUnchanged();
      } finally {
        prepared.dispose();
        observer.disconnect();
      }
    }
    return outcomes;
  });
  // Each label identifies the CSSOM change whose state check must reject independently.
  for (const outcome of evidence) {
    expect(outcome.mutationRecords, outcome.label).toBe(0);
    expect(outcome.sourceChanged, outcome.label).toBe(true);
  }
  // A property-name change cannot hide behind an unchanged declaration count.
  const renamed = evidence.find((outcome) => outcome.label === 'custom property rename')!;
  expect(renamed.propertyCountAfter).toBe(renamed.propertyCountBefore);
  // The external layout case must exercise a measurable geometry change.
  const external = evidence.find((outcome) => outcome.label === 'external sibling geometry')!;
  expect(external.widthAfter).toBeLessThan(external.widthBefore);
});
