# Encryptor System

A local web tool that scrambles the text inside a document and puts it back exactly as it was.

Upload a `.txt`, `.pdf`, `.docx`, `.md` or `.csv`, press **Encrypt**, download the result, then
upload that file again and press **Decrypt**. Files are processed in memory and never written to
disk by the server.

## Running it

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

## The cipher

Letters are replaced by their number, with no padding and no separator:

| | range | example |
|---|---|---|
| small letters | `z`=1 … `a`=26 | `h` → `19` |
| big letters | `A`=1 … `Z`=26 | `T` → `20` |

So `Rounder` → `181261323229`, and `to` → `712`.

Punctuation uses a bracketed code: `!`=a, `^`=b, `@`=c, `#`=d, `$`=e, `%`=f, `&`=g, `*`=h,
`(`/`) `=i, `:`=j, `;`=k, `'`=l, `"`=m, `\`/`/`=n, `|`=o, `-`=p, `{`/`}`=q, `.`=r, `=`=s, `+`=t,
`_`=v, `[`/`]`=w, `~`=x, `?`=y, `` ` ``=z, `<`=0, `=`=1, `,`=2.

Digits swap to symbols: `1`=`)`, `2`=`(`, `3`=`*`, `4`=`&`, `5`=`^`, `6`=`%`, `7`=`$`, `8`=`#`,
`9`=`@`, `0`=`!`. Whitespace is left alone.

Four codes are deliberately shared by two characters (`i`, `n`, `q`, `w`), and both letter tables
cover `1`–`26`, so the digits on their own cannot say which case a letter was or where one value
stops. Three short notes are therefore stored in the PDF's document info dict and are never drawn:

| key | holds |
|---|---|
| `EncryptorLayer` | `cipher` or `plain`, tells a later pass which direction to read |
| `EncryptorCase` | one character per letter (`u` small, `U` big) |
| `EncryptorWidth` | how many digits each of those letters consumed |
| `EncryptorAmb` | one bit per shared-code character |
| `EncryptorFonts` | local font files used, so redraws keep the original faces |

## How PDFs are handled

`pdf-lib` cannot edit text in place, so each page is rebuilt:

1. the page is rendered to a bitmap at 3× with `pdfjs-dist`
2. the original text is erased with the surrounding background colour
3. the transformed text is redrawn in the document's own fonts, fitted to the original run width
4. an invisible text layer (`Tr 3`) carrying an ASCII copy of the page text is added, one
   `Tj` per run scaled with `Tz`

The layer is what a later pass reads back. Splitting a run into several show-text operations lets
`pdfjs` cut cipher tokens in half, so each run is written as a single operation.

**Round trip is exact.** Verified against `DSA-P3.pdf` (8 pages, 687 runs):

```
encrypted layer decrypts to original : 687/687 exact
decrypted layer equals original      : 687/687 exact
full text identical                  : true
plaintext present in encrypted file  : false
```

Page images are not byte-identical to the original — the pipeline rasterises and redraws, so
compare extracted text rather than file hashes. Visual difference sits at the measured floor for
this approach, about 1.7% of pixels.

## UI

Black and orange. The drop zone grows a rotating dashed ring while a file is over it and refuses
unsupported types with a shake. Buttons ripple from the pointer on press, sweep on hover, and show
a spinner while busy. Honours `prefers-reduced-motion`, and the drop zone is keyboard reachable.

## Layout

```
index.js          express app, cipher, and the PDF rebuild pipeline
views/index.ejs   markup
public/style.css  theme and animation
public/script.js  drag & drop, uploads, download
```