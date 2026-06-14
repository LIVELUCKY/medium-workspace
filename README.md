# Medium Workspace

**Live:** https://livelucky.github.io/medium-workspace/

A local-first editor for drafting Markdown and getting it cleanly into Medium.
Three panes: an article browser, a Markdown editor with an inline checker, and a
live Medium-styled preview.

## What it does

- **Copy for Medium** — copies the article as rich HTML. Images and tables that
  Medium can't fetch are swapped for numbered `⟦ … ⟧` markers, so the text lands
  formatted and you drop the visuals in at the markers.
- **Images panel** — copies each local image to the clipboard as a PNG so Medium
  uploads it natively on paste (the way screenshots work). No public hosting.
- **Tables panel** — Medium has no native tables, so each table is rendered to a
  clean PNG you paste in place.
- **Inline checker** — flags Markdown and Medium-conversion issues right next to
  the offending line in the editor gutter (unclosed fences, empty links/images,
  H4+ headings, footnotes, raw HTML, tables).
- **Format** — runs Prettier on the Markdown, fully client-side.
- **Two modes** — point it at a local folder of articles, or open the editor and
  paste Markdown directly (nothing is stored).

> **Note:** folder integration and image/table copy require running locally.
> The hosted version at the link above works in paste-and-edit mode only.

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
PORT=3131 npm run dev   # custom port
```

## Article folder structure (local mode)

Set an articles folder on first run. Each article lives in its own subfolder:

```
articles/
  my-post/
    my-post.medium.md
    hero.png
```

## Stack

Next.js 15 (App Router) · React 19 · react-markdown · Tailwind v4 · Prettier · sonner
