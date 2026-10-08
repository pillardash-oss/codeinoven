/** Shared generation and delivery contract for requested media and inline output. */
export const ARTIFACT_CAPABILITY_NAME = 'cio-artifact'
export const ARTIFACT_CAPABILITY_SUMMARY =
  'Generate requested images, audio, video and explicit HTML/SVG artifacts, then render them in the conversation by default. Website, prototype and project implementation work use task-specific capabilities.'

export const ARTIFACT_CAPABILITY_DOCS = `---
name: cio-artifact
description: Generate requested media and render it inline by default, including images, graphics, audio and video. Also handles explicit HTML/SVG artifacts. Website and prototype implementation use task-specific capabilities.
---

# Inline artifacts

## Trigger

Use when the user asks to generate or edit a standalone image, graphic, illustration, audio clip, soundtrack or video, or explicitly requests an inline, HTML or SVG artifact. Inline delivery is the default for these requested assets; the user does not need to say "artifact" or "inline". For example, "Generate an image for me, I want a nice social media meta image for this app" activates this skill. Follow-up edits stay in scope. Honor an explicit destination or request not to display the output inline.

A request to build a website, implement a project feature or design a prototype does not activate this skill merely because that work includes media. Use task-specific capabilities such as cio:design for interfaces and cio:video for compositions, then use the artifact render operation for a standalone media deliverable requested in the conversation.

## Generate, then render

1. Preserve the requested medium. An image request needs a bitmap image, audio needs an audio file and video needs a playable video file. Never substitute HTML, SVG or prose for requested generated media without agreement.
2. Use an available direct generation tool for the medium. Do not search for Design or require its craft assignment when this harness already provides the generator. If no generator is callable, search app-managed utilities for the specific generation capability and activate a relevant result. A missing Design assignment does not mean every generator is unavailable. Respect the credentials and model requirements of the generator actually used. Never invent tools or claim success after an error.
3. Save or copy the actual generated file into the authorized thread workspace. Honor the destination the user named. Use the workspace directory supplied in the turn instructions; project scratch artifacts go under .cio/work/<feature>/ or .cio/tmp/. Download remote generator output through an available media save capability before rendering it. The render tool accepts local paths, not remote URLs or base64 payloads.
4. Call cio_util_use with utility_id "cio:artifact", operation "render", input { "path": "<actual local file>" }. Absolute and workspace-relative paths are accepted inside the thread workspace. Repeat for multiple files in the requested order. The app validates the file, persists its conversation entry and renders it inline. Do not author Markdown image links, media tags, base64 strings or artifact fences to make the render happen. The tool reply reports rendered: true and the conversation message ID. Report failure accurately if the tool rejects the file.

## File formats

Images: PNG, JPEG, WebP, GIF, AVIF. Audio: MP3, WAV, OGG, M4A, FLAC. Video: MP4, WebM, MOV. Playback depends on the runtime's codec support; prefer MP4/WebM and MP3/WAV. HTML: .html or .htm. SVG: .svg. An extension must match the actual generated format.

## HTML and SVG authoring

Write a complete self-contained document smaller than 64000 UTF-8 bytes. Inline styles are allowed; scripts and external URLs are not. The app owns sanitization, preview selection, theme updates and fullscreen display. These are static previews; executable websites belong in the design/browser workflow.

Use live tokens from src/renderer/app.css by default: var(--color-app), var(--color-surface), var(--color-elevated), var(--color-foreground), var(--color-muted), var(--color-border), var(--color-primary), var(--color-on-primary), and semantic status colors. Use var(--font-app) and var(--font-mono), inherit base font size/weight, and use rem for typography and spacing. SVG fills/strokes can use tokens; text can use currentColor. Do not redefine app tokens or hardcode a light/dark palette. Use different colors or typography only when the user requests them. Raster image/video pixels cannot react to CSS theme changes.

Generation and presentation are separate responsibilities. The model creates the asset and supplies its path. The app renders it. Do not open a browser tab as a substitute for inline delivery.
`
