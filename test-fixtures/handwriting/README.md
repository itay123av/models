# Hand-drawn automata test fixtures

These files are external test fixtures only. They are not application assets.

## `fa-handdrawn-sample-cc-by-nc-nd-4.0.jpg`

- Purpose: real hand-drawn finite-automaton image; five states, initial/final
  markers, loops, curved transitions, and handwritten labels.
- Dimensions: 647 x 358 pixels.
- Source: Figure 5, "Example image from hand-drawn finite automata dataset FA",
  in Agrawal, Kantipudi, and Jagtap, *Enhancing hand-drawn diagram recognition
  through the integration of machine learning and deep learning techniques*,
  Scientific Reports 15, 17311 (2025).
- Article: https://pmc.ncbi.nlm.nih.gov/articles/PMC12089597/
- DOI: https://doi.org/10.1038/s41598-025-01823-4
- Direct image: https://cdn.ncbi.nlm.nih.gov/pmc/blobs/04c5/12089597/bdd47df545ce/41598_2025_1823_Fig5_HTML.jpg
- License: CC BY-NC-ND 4.0, as stated for the article and its figures when no
  separate credit line is present:
  https://creativecommons.org/licenses/by-nc-nd/4.0/
- Attribution: Vanita Agrawal, MVV Prasad Kantipudi, and Jayant Jagtap.
- Modification status: unmodified publisher image.
- Restriction: non-commercial use only; do not publish modified versions.
- Important provenance note: the upstream GitHub mirror says the complete FA
  dataset has no license. Only this unmodified, article-published figure is kept
  here under the article's stated license. Do not download or redistribute other
  FA dataset files from that mirror without separate permission.
- SHA-256: `ECEA2AB2F3EF2BB8ED0A90B1F44BE444B2C9C93235D2E42CDC3B45E8E571CED1`

## `pda-palindrome-cc0.png`

- Purpose: pushdown-automaton state diagram for even-length binary palindromes;
  includes stack initialization, push/pop rules, loops, and accepting states.
- Dimensions: 403 x 227 pixels.
- Source page: https://commons.wikimedia.org/wiki/File:Palindrom_pushdown_automaton.png
- Direct file redirect: https://commons.wikimedia.org/wiki/Special:Redirect/file/Palindrom_pushdown_automaton.png
- Author: Wikimedia Commons user `gran`.
- License: CC0 1.0 Universal Public Domain Dedication:
  https://creativecommons.org/publicdomain/zero/1.0/
- Modification status: unmodified original.
- Note: this is a clean digital diagram, not a handwritten sample; it is included
  to exercise PDA transition notation with unambiguous legal reuse terms.
- SHA-256: `31278D77ADB10D8E6B37EAA7C5DCB71FF7FC2B2D7BAB7C6E180EB793BB849658`

## `pda-palindrome-cc0-rotated-low-contrast.jpg`

- Purpose: robustness fixture for a mildly rotated, faded, warm-paper photo.
- Dimensions: 493 x 317 pixels.
- Source and author: derivative of `pda-palindrome-cc0.png` above.
- License: CC0 1.0; the source permits unrestricted modification and reuse.
- Changes: rotated 7.5 degrees, placed on an off-white canvas, reduced to 48%
  opacity, and JPEG-encoded at quality 72.
- SHA-256: `4BE7A4BEF120F7953E29E8C27BF1A07080692AC4DA99F2AB41EF653012445033`
