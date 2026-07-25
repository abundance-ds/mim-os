---
id: references
title: references
order: 7
sources:
  - src/main/tools/references.ts
  - src/main/export/citations.ts
  - src/renderer/services/citationHealth.ts
  - src/renderer/components/editor/codemirror/citations.js
  - docs/export.md
verified: bf1358ebd68b1348a9fd85c6576c5b71e5f11880
---

# references

Mim resolves citations in your documents against a BibTeX library in the workspace. You write citation keys while drafting. Mim completes them, checks them against your bibliography as you work, and formats them on export.

## Your bibliography

Your bibliography is a `.bib` file inside the workspace. By default Mim looks for `references/references.bib`. You can point it elsewhere by setting the bibliography path in workspace settings, or by adding a `bibliography:` field to a document's YAML frontmatter:

```yaml
---
bibliography: path/to/library.bib
---
```

When a document contains citations, Mim searches for the best-matching `.bib` file in a fixed priority order: the document's frontmatter `bibliography` field, the saved Project setting, the default path, then a broader scan of `.bib` files near the document, in a `references/` folder, at the Project root, and inside Team Files at `.mim/team/files/`. The first file found is used automatically. If Mim selects a bibliography through this search, it persists the choice as the Project setting so subsequent documents resolve the same way.

## Citing while writing

Citations use Pandoc-style syntax. Prefix a citation key with `@` for an inline reference, or wrap it in brackets for a parenthetical group:

```markdown
@Smith2020 found that ...
Recent work [@Smith2020] confirms ...
Multiple sources support this [@Smith2020; @Jones2021].
```

Only bracketed citations (`[@key]`) are resolved during export. A bare `@key` is highlighted in the editor but stays as written in the exported document.

As you type `@` followed by any characters, the editor opens a completion menu. Completions match against the full entry — key, author, title, year, venue, DOI, and every other BibTeX field — so typing a fragment of an author's name or a title word is enough to find the right reference. Each completion row shows the citation key, the title, and a side panel with author, year, and venue. Press <kbd>Tab</kbd> or <kbd>Enter</kbd> to accept. If you began with `[@`, the closing bracket is inserted for you.

When a References app is installed, the completion menu also offers an "Add & cite" action for DOIs: type `[@10.1038/...` and select the option to resolve the DOI into your library and insert the citation key in one step.

Hovering over a citation key shows a tooltip with the reference's title, author, year, and venue. If the entry has a linked PDF (via the BibTeX `file` field), the tooltip includes an "Open PDF" button that opens it in the editor.

## Citation health

The editor status bar shows a citation indicator whenever the current document contains citations. It displays the total number of citations when all keys resolve, or the count of missing citations when any are unresolved. Clicking this indicator opens a popover listing every citation in the document: resolved entries show their title and metadata, unresolved entries appear at the top marked as not found. Clicking any entry in the popover jumps to its next occurrence in the document.

In the editor itself, citation keys are highlighted. Resolved keys appear in the accent color. Unresolved keys — those not found in the active bibliography — receive a wavy red underline. Duplicate keys (the same citation key defined more than once in the `.bib` file) receive a wavy amber underline.

The popover also shows a "Change bibliography" section listing every `.bib` file Mim discovered in the workspace. Each candidate displays its path, its source category, and how many of the document's citations it can resolve. Selecting a candidate switches the active bibliography.

## Export

When you export a document to PDF or DOCX, citations are resolved through citeproc and rendered as formatted inline labels with a bibliography appended at the end. The export dialog shows a citation style selector when the document contains `[@` citations. Three built-in styles are available:

::: rows
- APA — author-date parenthetical, alphabetical bibliography.
- Chicago — Chicago author-date, alphabetical bibliography.
- IEEE — numeric brackets, bibliography in order of first citation.
:::

You can also supply a workspace-relative `.csl` file for any Citation Style Language definition. Pass it as the `citation_style` parameter through the export tools (`export.pdf`, `export.docx`).

If a citation key is not found in the bibliography, it stays as written in the exported document and is reported as an error after export.

::: note
The export dialog also has a "Choose .bib" button so you can select or change the bibliography file before exporting.
:::

## Importing references

You can edit your `.bib` file directly — it is a standard BibTeX file, and Mim rereads it the next time citation data is needed. Mim also supports importing a `.bib` file as a document: the import converts each entry into a readable markdown listing with its key, type, authors, title, year, and other fields.

An optional Team or Project app can add DOI capture and a managed reference library. Open **Settings > Apps & agents** to review the apps available in the current Mim installation.

::: under-the-hood
The citation pipeline lives in `citations.ts`. BibTeX is parsed into `BibEntry` objects, projected to CSL-JSON, and processed by citeproc for the chosen style. Inline `[@key]` groups are replaced with formatted labels (author-year or numeric), and a bibliography of renderer-neutral runs (`{ text, italic }`) is produced for both the HTML/PDF and DOCX renderers to consume directly.

The agent has three reference tools: `references.readBib` reads the workspace bibliography and returns citation rows, `references.resolveBibliography` resolves the active bibliography for a document using the same priority order the editor uses, and `references.setBibliographyPath` sets the workspace bibliography path.
:::
