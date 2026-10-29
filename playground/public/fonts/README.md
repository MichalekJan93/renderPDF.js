# Preview fonts

Noto Sans Regular, Bold and Italic are static TrueType faces from
[notofonts/noto-fonts](https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSans).
Their original SIL Open Font License is preserved in `OFL.txt`.

The consumer supplies these exact programs for browser layout when the HTML requests
`Playground Sans` and for RenderPDF.js fallback when an HTML face is unavailable.
They are separate from the MIT-licensed application and the installed library.
No bold italic program is bundled; unmatched combinations are reported through
RenderPDF.js diagnostics or rejected by its strict font mismatch mode.
