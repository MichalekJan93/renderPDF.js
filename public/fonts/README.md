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
