# DOCX Review Workflow

Status: implemented as a Team-owned app plus main-process DOCX infrastructure.
The current company app lives at `mim-team/apps/docx-review/` with its own
tests. Another Team or Project may own a separate implementation; the app is
not bundled in core.

The package owns the review orchestration and UI. The Electron main process owns
workspace-safe file access, model key resolution, and Word/Open XML operations.
The original DOCX is never modified.

## Source Map

App-layer paths below are relative to a Team repository; `src/`, `sidecar/`,
and `scripts/` paths are in this repo.

| Layer | Source | Role |
|---|---|---|
| App manifest | `apps/docx-review/package.json` | Declares UI, backend, workspace read/write, AI, and reference-search HTTP permissions. |
| App UI | `apps/docx-review/ui/index.html` | File picker, submit state, real-signal processing panel, report/document result view, comment rail. |
| App backend | `apps/docx-review/backend/index.mjs` | Gatekeeper, reviewer agents, reference search, reconciliation handoff, report write, HTML anchoring, DOCX annotation. |
| App skill | `apps/docx-review/skills/docx-peer-review/SKILL.md` | Chat-facing instructions for starting a review job. |
| Guidance library | `apps/docx-review/guidance/` | Statistics, reporting-standard, and argumentation chapters loaded by reviewer tools. |
| Package runtime | `src/main/packages/packageRuntime.ts` | Provides `ctx.ai`, `ctx.documents.docx`, package data, progress, abort, audit, and tool calls. |
| Document tools | `src/main/tools/documents.ts` | Registers `documents.docx.*` tools with workspace path checks. |
| DOCX reader | `src/main/docx/reader.ts` | Mammoth DOCX to HTML/Markdown/image extraction; supported PNG/JPEG/WEBP images downscale to a 1568px long edge via Sharp with original-byte fallback, unsupported images convert to PNG when possible. |
| DOCX writer wrapper | `src/main/docx/writer.ts` | Converts annotate/comment/validate calls into sidecar requests. |
| Sidecar runner | `src/main/docx/worker.ts` | Locates and executes the Open XML worker binary; exposes worker availability preflight. |
| Open XML worker | `sidecar/docx-worker/DocxWorker/` | .NET 8 `DocumentFormat.OpenXml` worker for comments, replies, resolution, tracked insertions/deletions. |
| Worker build | `scripts/build-docx-worker.mjs` | Publishes the worker and copies it to `resources/docx-worker/{platform}-{arch}/docx-worker`. |

## UI Contract

The package view intentionally exposes only the old user-level workflow:

1. Choose a `.docx` file through the native file picker.
2. Select a compatible review model from the app model registry.
3. Optionally add notes to the review agents.
4. Submit for review.
5. Watch the real-signal processing panel while the package job runs.
6. Read the report, marked manuscript HTML, and inline comment rail.
7. Open the generated markdown report from the editor.

The model selector is a real list populated from `ai.registry` and
`ai.keyStatus` through the package SDK. The backend validates the selected
`modelId` against the same registry and rejects unknown or non-tool-capable
models before review calls.
`reviewNotes` is optional free text. When provided, it is prepended to the
technical, editorial, reference, reconciler, and summary prompts.
There is no free-text model-id field, author field, max-comments field,
gatekeeper toggle, or workspace scan button. Those are implementation defaults,
not user choices in this workflow.

If the chosen file is outside the workspace, `documents.pickReviewFile` copies
it into `inputs/` and returns the workspace-relative path. The job input stays:

```json
{ "path": "inputs/manuscript.docx", "reviewNotes": "Focus on the statistical model assumptions." }
```

## Runtime Architecture

```txt
Package UI or chat package tool
  -> package.jobs.start(reviewDocx, { path, modelId, reviewNotes })
  -> PackageJobRunner persists run + streams progress
  -> packages/docx-review/backend/index.mjs
     -> ctx.tools.call(ai.registry) selected model validation
     -> ctx.documents.docx.workerStatus()
     -> ctx.documents.docx.extract(path)
     -> ctx.ai.callModel(selected review model) gatekeeper
     -> ctx.ai.callModel(selected review model) tool-loop reviewers
     -> ctx.ai.callModel(selected review model) batched reconciler
     -> ctx.ai.callModel(selected review model) compact summary writer
     -> ctx.tools.call(fs.write) markdown report
     -> ctx.documents.docx.annotate(...) reviewed DOCX copy
```

The DOCX worker is checked before model calls. If the binary is missing, the job
fails immediately with the build fix instead of spending tokens and failing at
the final Word-writing stage.

## Workflow Stages

1. Worker preflight
   - `documents.docx.workerStatus` confirms the Open XML sidecar is available.
   - Build with `npm run docx-worker:build` or set `DOCX_WORKER_PATH`.

2. Extraction
   - `documents.docx.extract` reads the DOCX with Mammoth.
   - Output includes display HTML, Markdown for reviewers, plain text slice,
     and embedded images.
   - Table HTML is rendered into aligned GFM pipe tables for reviewer markdown;
     prompts tell reviewers to anchor table comments on single cell text.
   - Supported embedded images are downscaled before base64 insertion. Unsupported
     image formats are converted to PNG through Sharp when possible; failed
     unsupported conversions are omitted rather than passed to the model.

3. Gatekeeper
   - The selected review model checks whether the file is a reviewable
     research manuscript.
   - Non-reviewable documents return a failed review result with a reason.

4. Specialist reviewers
   - Technical Reviewer: statistics, methods, sample size, missing data,
     quantitative reporting, reproducibility.
   - Editorial Reviewer: argumentation, structure, reporting standards,
     citations, clarity.
   - Reference Checker: bibliography accuracy and citation coverage.
   - Optional `reviewNotes` are included in each specialist reviewer prompt.
   - Technical and Editorial reviewers receive image blocks; their paper budget
     subtracts `1600` tokens per image. Images are sent unless the high safety
     payload guard is hit, in which case omitted figure ids are recorded in
     technical notes and disclosed to the reviewer.

5. Reviewer tool loops
   - Technical and Editorial reviewers can call `getGuidance` to list/load
     guidance chapters.
   - They must call `submit_review`.
   - `submit_review` validates each `text_snippet` against the extracted
     manuscript. Invalid anchors are returned to the model so it can retry in
     the same tool loop.
   - The Reference Checker can call `search_references`, then must call
     `submit_citation_report`. Its comments use the same anchor repair loop.

6. Reconciler
   - The selected review model accounts for every raw reviewer comment exactly
     once, merging, keeping, or explicitly dropping it with a reason.
   - The model can only submit reconciliation decisions through the batched
     `decide_comments` tool. It receives the full raw-comment array, but submits
     an array of decisions in each tool call instead of one call per comment.
     Failed items are returned with reasons so the model repairs only the
     remaining ids.
   - Successful batches emit determinate progress from 72% to 88%. The summary
     is generated in a separate compact one-shot call from the reconciled
     comment list, then the markdown report is written next to the source file.

7. HTML anchoring
   - `anchorCommentsInHtml` deterministically maps accepted `text_snippet`
     values into Mammoth HTML and wraps matches in `<mark data-comment-id>`.
   - This is not an agent call. The repair opportunity is upstream in the
     reviewer tool loops and downstream in DOCX annotation.

8. DOCX annotation
   - Accepted comments become Open XML `add_comment` operations.
   - If Word anchoring fails for some comments, a small Sonnet tool loop asks
     for replacement exact anchor snippets and retries annotation.
   - If some comments still cannot be written into the DOCX, the HTML review
     and markdown report remain complete and the DOCX result carries a warning.

## Agent Hierarchy

```txt
reviewDocx package job
  Gatekeeper
  Specialist reviewers in parallel
    Technical Reviewer
      getGuidance(statistics)
      submit_review
    Editorial Reviewer
      getGuidance(reporting-standards, general)
      submit_review
    Reference Checker
      search_references(Crossref/OpenAlex)
      submit_citation_report
  Reconciler
    decide_comments
  Summary Writer
  DOCX Anchor Repairer
    submit_docx_anchor_repairs
```

The main package job is the orchestrator. The specialist reviewers are tool-loop
agents, not one-shot structured calls. Their accepted comments are merged,
deduplicated, numbered, rendered in HTML, and written into Word.

## Infrastructure Requirements

Runtime:

- Electron main process with package runtime enabled.
- Workspace path open and writable.
- Package server + `sdk/mim.js` for the iframe UI.
- Package permissions: workspace read/write, AI, and HTTP hosts for reference
  search.
- API keys in `~/.mim/keys.env` or the environment for the selected review
  model's provider (the file takes priority).

Document engine:

- `mammoth` for DOCX to HTML/Markdown extraction.
- `turndown` for HTML to Markdown conversion.
- `sharp` for embedded image downscaling and unsupported image conversion.
- .NET 8 SDK to build the worker during development.
- Built worker at `resources/docx-worker/{platform}-{arch}/docx-worker`, or
  `DOCX_WORKER_PATH` pointing to an executable.
- `DocumentFormat.OpenXml` inside the sidecar for native Word comment writing.

## Open XML Worker Protocol

The worker accepts JSON request files:

```json
{
  "command": "annotate",
  "inputPath": "/abs/source.docx",
  "outputPath": "/abs/source_reviewed.docx",
  "operations": [
    {
      "type": "add_comment",
      "anchorText": "exact text in the document",
      "commentText": "[1] Technical Reviewer (major)\n\nReview comment",
      "author": "Mim Review"
    }
  ]
}
```

Supported operations:

| Type | Purpose |
|---|---|
| `add_comment` | Add a Word comment anchored to matched text. |
| `reply_comment` | Add a threaded reply to an existing comment. |
| `resolve_comment` | Mark an existing comment resolved. |
| `tracked_insertion` | Add a tracked insertion around matched text. |
| `tracked_deletion` | Add a tracked deletion for matched text. |

## Known Limits

- The active package is DOCX-only. The old web upload accepted PDF too; PDF OCR
  is separate infrastructure and is not part of this DOCX package path.
- The Open XML writer still matches text within the Word XML body. Cross-paragraph
  anchors can fail. The package prompts table comments toward single cell text,
  retries failed anchors with repaired exact snippets, and degrades to complete
  HTML/markdown output if Word comments remain partially unwritable.
- The copied real-manuscript sidecar tests require private DOCX fixtures under
  `sidecar/docx-worker/testdata/`; portable sidecar tests exclude that class.
