# Test fonts

Noto Sans and Noto Serif static TrueType faces are bundled solely as test fixtures.
Browser layout, SVG raster capture, and the PDF writer use identical bytes.

Source: [notofonts/noto-fonts, hinted/ttf/NotoSans](https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSans).
The upstream SIL Open Font License is preserved in `OFL.txt`; it is separate from
the project's MIT license. Regular, Bold, and Italic are included. These assets
do not imply support for every script or an automatic system-font discovery API.

Noto Serif Regular comes from the same upstream repository at pinned revision
[`ffebf8c1ee449e544955a7e813c54f9b73848eac`](https://github.com/notofonts/noto-fonts/blob/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSerif/NotoSerif-Regular.ttf).
Its upstream SIL Open Font License is retained separately in `NotoSerif-OFL.txt`.
SHA-256 of the unmodified `NotoSerif-Regular.ttf` program:
`c8f669ceb2c9c60ccf55198b305e08a997ffca79a38cc7eeb551e643cbe66505`.
Fonts are excluded from the npm package allowlist.

Roboto Variable is a separate public test fixture for its default `wght=400`,
`wdth=100` instance. Source: [Google Fonts Roboto](https://github.com/google/fonts/blob/main/ofl/roboto/Roboto%5Bwdth,wght%5D.ttf).
Its SIL Open Font License is preserved in `ROBOTO-OFL.txt`.
SHA-256 of the unmodified `Roboto-Variable.ttf` program:
`d7598e12c5dbef095ff8272cfc55da0250bd07fbdecbac8a530b9b277872a134`.

Noto Sans Arabic Regular is an unmodified static TrueType fixture from
[notofonts/noto-fonts at `ffebf8c1`](https://github.com/notofonts/noto-fonts/blob/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSansArabic/NotoSansArabic-Regular.ttf).
The repository's `OFL.txt` is its SIL Open Font License. SHA-256 of
`NotoSansArabic-Regular.ttf`:
`ceea25b464a656dc3b26849bab9356740401af62aedf1bfa8b7f0d9b75925b1b`.

`RenderPDFHanTest-Regular.otf` is a modified, renamed test subset of the
[static Noto Sans CJK Simplified Chinese Regular font at `f8d1575`](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf).
The upstream 16,437,364-byte program has SHA-256
`2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`.
FontTools 4.56.0 retained the characters needed by the multilingual fixtures,
including Chinese prose, punctuation, and ASCII; the family, full, PostScript,
and CFF names were changed to `RenderPDF Han Test` as required for this modified
font. This 86,548-byte test subset is not a general-purpose Chinese font.
Its SHA-256 is
`453426386add284c0b74f3350972487be3bc42d73539747a9d454a2639af640f`.
The upstream SIL Open Font License is preserved in `NOTO-CJK-OFL.txt`.

`RenderPDFHanTraditionalTest-Regular.otf` is a second modified, renamed subset,
from the [static Noto Sans CJK Traditional Chinese Regular font at `f8d1575`](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf).
Its source program has SHA-256
`dce08bd4fd91aa8aa76ed8fea4b694c2dfb8550f67871e326843212ddbeb88b4`.
FontTools 4.56.0 retained only `繁體漢字。` and changed the family, full, PostScript,
and CFF names to `RenderPDF Han Traditional Test`. The 10,196-byte test subset
has SHA-256 `8b7952945e79fa5d0db26fa6b4189fb389c9d1930a51349208d78f2bd128aa76`.
It shares the upstream `NOTO-CJK-OFL.txt` license with the Simplified Chinese
fixture and is not a general-purpose Traditional Chinese font.
