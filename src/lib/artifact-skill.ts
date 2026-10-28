import { APP_DESIGN_TOKEN_CATALOG } from './design-tokens'
import { previewExtensionsForKind } from './preview-types'

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

Vector work is authored here, not generated elsewhere. A logo, wordmark, logotype, monogram, icon, emblem, crest, badge, poster, banner or diagram is a document you write yourself as an SVG file, so no image generator is involved and none should be searched for, installed or offered. Only a request for photographic or painterly bitmap artwork needs a generator.

A request to build a website, implement a project feature or design a prototype does not activate this skill merely because that work includes media. Use task-specific capabilities such as cio:design for interfaces and cio:video for compositions, then use the artifact render operation for a standalone media deliverable requested in the conversation.

## Generate, then render

1. Preserve the requested medium. An image request needs a bitmap image, audio needs an audio file and video needs a playable video file. Never substitute HTML, SVG or prose for requested generated media without agreement. Vector and graphic work is the exception in the other direction: a logo, wordmark, icon, emblem, badge, poster or diagram is authored as SVG by you, and submitting a bitmap for it loses the scalability the request implies.
2. Use an available direct generation tool for the medium. Do not search for Design or require its craft assignment when this harness already provides the generator. Vector work needs no generator at all: write the SVG. When a bitmap generator genuinely is not callable, search app-managed utilities for the specific generation capability and activate a relevant result. A missing Design assignment does not mean every generator is unavailable. Respect the credentials and model requirements of the generator actually used. Never invent tools or claim success after an error.
3. Save or copy the actual generated file into the authorized thread workspace. Honor the destination the user named. Use the workspace directory supplied in the turn instructions; project scratch artifacts go under .cio/work/<feature>/ or .cio/tmp/. Download remote generator output through an available media save capability before rendering it. The render tool accepts local paths, not remote URLs or base64 payloads.
4. Call cio_util_use with utility_id "cio:artifact", operation "render", input { "path": "<actual local file>" }. Absolute and workspace-relative paths are accepted inside the thread workspace. Repeat for multiple files in the requested order. The app validates the file, persists its conversation entry and renders it inline. Do not author Markdown image links, media tags, base64 strings or artifact fences to make the render happen. The tool reply reports rendered: true and the conversation message ID. Report failure accurately if the tool rejects the file.

## File formats

Images: ${previewExtensionsForKind('image')}. Audio: ${previewExtensionsForKind('audio')}. Video: ${previewExtensionsForKind('video')}. The list comes from src/lib/preview-types.ts, the table the serving and publishing gates read, so it cannot fall out of step with what the app accepts. Playback depends on the runtime's codec support; prefer MP4/WebM and MP3/WAV. HTML: .html or .htm. SVG: .svg. An extension must match the actual generated format.

## HTML and SVG authoring

Write a complete self-contained document smaller than 64000 UTF-8 bytes. Inline styles are allowed; scripts and external URLs are not. The app owns sanitization, preview selection, theme updates and fullscreen display. These are static previews; executable websites belong in the design/browser workflow.

Compose from the app's own tokens rather than a palette of your own. Every token below is read from src/renderer/app.css and is live inside the artifact, so var(--color-surface) follows the app's active theme and a redesign of the app reaches a new artifact without being rewritten. Use the token names, never raw hex values, use rem for typography and spacing, and use a different palette or typeface only when the user asks for one.

An SVG artifact composes the same way: fills and strokes can use the tokens, and text can use currentColor. Raster pixels cannot react to a theme change, so an asset that has to follow the theme is authored as HTML or SVG.

${APP_DESIGN_TOKEN_CATALOG}

The app's own rules for interactive elements apply inside the artifact too, so a button, input, select or dialog you author is shaped exactly the way the app shapes its own, whatever corner or focus treatment the app uses today.

## Where the artifact is drawn

The artifact is drawn flush in the conversation, inside the app's reading column: a max-w-3xl column (48rem of content) with 1.5rem gutters, and narrower than that when the window is small or the context rail is docked beside it. The same artifact can be opened full screen by the reader. Design for both without knowing the exact pixel width: percentage and fluid widths, max-width: 100% on media, flex or grid that wraps, clamp() for type that has to scale, and no fixed page width and no viewport units that assume a browser window.

The document's own html and body margin and padding are dropped in the conversation, because the message column already owns the gutter, so a page that opens with its own outer card or frame reads as a second box inside the message. Put any inset you want on your own wrappers, and open with the content itself.

Generation and presentation are separate responsibilities. The model creates the asset and supplies its path. The app renders it. Do not open a browser tab as a substitute for inline delivery.
`
