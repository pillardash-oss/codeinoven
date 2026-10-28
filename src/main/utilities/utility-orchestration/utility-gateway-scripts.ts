import { authoredWorkCritiqueTool } from './authored-work-critique-tool'
import { designMotionTools } from '../../design/design-motion-tools'
import type {
  HarnessUtilityBinding,
  ResolvedUtility,
  UtilityDefinitionFor
} from '../../../lib/types'
import { GATEWAY_TOOLS, gatewayToolForModel, initialGatewayTools } from '../../../lib/gateway-tools'
import { workRootForKind, type WorkRoots } from '../../../lib/design/work-roots'
import { GATEWAY_UTILITY_ID_PREFIX } from '../../../lib/utility-ids'
import type { McpTool } from '../../agents/mcp-stdio-client'
import { videoStudioTools } from '../../video/video-studio-tools'

export const BRIDGE_SCRIPT_PATH = 'runtime/utility-gateway/bridge.mjs'

/**
 * The `generate` operation, shared by the design and video capabilities.
 *
 * One tool in two capabilities, because making an asset is the same act whether a
 * page or a composition needs it, and the model is the user's assignment either
 * way. It exists because the app had no way to produce media at all: a craft
 * could only staff a text completion, so an agent that needed a music bed had to
 * improvise one.
 */
export function generateMediaTool(roots: WorkRoots): McpTool {
  const designRoot = workRootForKind(roots, 'design')
  const videoRoot = workRootForKind(roots, 'video')
  return {
    name: 'generate',
    description: `Generate an image, a video clip or an audio file with the model the user assigned to that craft, and save it into the project as a file. The user names the model in Settings, Design, so never choose one yourself: a craft with no assigned model is refused and you should ask the user to assign one. Write the complete brief in prompt. Pass options only when the model needs a provider-specific field (an aspect ratio, a duration, and so on). The reply carries the project-relative path; reference it from the markup and preview to check it renders.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['image', 'video', 'audio'],
          description:
            'Which craft answers: an image, a video clip, or audio such as a music bed or a voice line.'
        },
        prompt: {
          type: 'string',
          description:
            'The complete brief for the generation model: the subject, the style, the mood, the framing, and every constraint, written as if to someone who has seen none of this work.'
        },
        prompt_field: {
          type: 'string',
          description:
            'Only when the model documents its prompt input under another name, such as "text". The prompt is sent under this field instead of "prompt", never under both.'
        },
        name: {
          type: 'string',
          description:
            'Optional file name without an extension, such as hero or music-bed. The model name is used when you omit it.'
        },
        directory: {
          type: 'string',
          description: `Project-relative folder to save into. Defaults to the folder of this thread's session (${videoRoot} for a video session, ${designRoot} otherwise), so name the design's or the composition's own folder when the asset belongs to one.`
        },
        options: {
          type: 'object',
          description:
            'Provider-specific input fields passed through as written, such as an aspect ratio or a duration. Only the fields the model documents.'
        }
      },
      required: ['kind', 'prompt'],
      additionalProperties: false
    }
  }
}

/**
 * Absolute cap on one gateway call, enforced by the bridge itself.
 *
 * The harness's own request timeout is the real lifetime bound, because it also sends
 * `notifications/cancelled` when it gives up, and the bridge aborts the named call on that
 * signal. This cap exists only so a client that never cancels cannot leave a call pending
 * forever, so it sits far above the longest legitimate app-side operation (a secret card
 * waiting on a human) and never cuts a live call short.
 */
export const GATEWAY_BRIDGE_CALL_CAP_MS = 15 * 60 * 1000

/** Environment variable the bridge reads its call cap from. */
export const GATEWAY_BRIDGE_CALL_CAP_ENV = 'CODEINOVEN_UTILITY_BRIDGE_CALL_CAP_MS'

/** Turn identity the app-owned gateway utility needs; UtilityTurnRequest satisfies it. */
export interface GatewayTurnContext {
  harnessId: string
  projectId: string
  threadId: string
}

/**
 * The page an operation works on.
 *
 * Shared by every browser tool so the wording of the choice exists once: the
 * agent's own offscreen page, or the page this conversation's thread browser is on.
 */
const PAGE_TARGET_FIELD = {
  type: 'string',
  enum: ['user', 'agent'],
  description:
    'Which page to work on: "agent" for a page you opened, "user" for the page this conversation\u2019s thread browser is on. Defaults to your own page when you have one, and to the thread browser\u2019s page otherwise.'
}

/** The element an action addresses, by the reference a snapshot reported. */
const REF_FIELD = {
  type: 'string',
  description:
    'The ref a snapshot reported for the element, such as "r12". Acts on exactly the element that was read; use it or selector.'
}

/** The element an action addresses, by CSS selector. */
const SELECTOR_FIELD = {
  type: 'string',
  description:
    'A CSS selector, including the unique selectors a snapshot reports. Use it or ref.'
}

export const BROWSER_UTILITY_TOOLS: McpTool[] = [
  {
    name: 'open',
    description:
      'Open an http(s) URL in a browser tab owned by this project and thread. The tab is mounted offscreen at a real viewport, so the page loads, runs and can be read even while the user views another project or thread. A page the user is on is never taken over by this: opening always makes a page of your own. Background is the default. Pass attention "focus" only when background interaction cannot accomplish the task.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        attention: {
          type: 'string',
          enum: ['focus', 'background'],
          description:
            'background (default) keeps the tab offscreen without interrupting the user; focus remains available when background interaction cannot accomplish the task.'
        }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'viewport',
    description:
      'Set the viewport this thread browser tab is laid out at while it runs offscreen, for checking responsive layouts. Give a preset or explicit width and height. A tab the user is currently viewing keeps the on-screen size and uses this viewport once it is offscreen again.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          enum: ['phone', 'phone-large', 'tablet', 'laptop', 'desktop']
        },
        width: { type: 'number' },
        height: { type: 'number' },
        page: {
          type: 'string',
          enum: ['user', 'agent'],
          description:
            'Which page to work on: "agent" for a page you opened, "user" for the page this conversation\u2019s thread browser is on. Defaults to your own page when you have one, and to the thread browser\u2019s page otherwise.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'snapshot',
    description:
      'Read the page: its title, URL, visible text, scroll position, and every element you could act on. Each element reports a ref (pass it back as ref), its unique CSS selector, its live value, checked state, disabled state and its box on screen, so you can see a form exactly as it stands before you fill it. The page this conversation\u2019s thread browser is on is readable with page "user"; the default reads your own page. Auto Review allows recognized browsing actions and asks before consequential or unknown ones: call the operation and let the app enforce approval rather than asking the user yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        interactiveOnly: {
          type: 'boolean',
          description:
            'Report only elements a person could act on (default true). Pass false to also see labels, images and canvases.'
        },
        maxElements: {
          type: 'number',
          description: 'Elements to report, up to 1000. Defaults to 300.'
        },
        text: {
          type: 'boolean',
          description: 'Pass false to leave the visible page text out when you only need the elements.'
        },
        maxText: {
          type: 'number',
          description: 'Characters of visible page text to report, up to 40000. Defaults to 20000.'
        },
        page: PAGE_TARGET_FIELD
      },
      additionalProperties: false
    }
  },
  {
    name: 'click',
    description:
      'Click an element as a pointer does: a real move, press and release through the browser\u2019s input pipeline, so hover, focus, caret and pointer handlers all run. Falls back to the element\u2019s own click only when a pointer cannot reach it, and says which happened (via "pointer" or "dom"). On the thread browser\u2019s page (page "user") the click is reviewed before it happens.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_FIELD,
        selector: SELECTOR_FIELD,
        clickCount: { type: 'number', description: '1 for a click, 2 for a double click.' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Held modifiers: shift, control, alt, meta.'
        },
        page: PAGE_TARGET_FIELD
      },
      additionalProperties: false
    }
  },
  {
    name: 'type',
    description:
      'Fill an input, textarea, or editable element, and report the value the page actually kept. This is what a framework-controlled form (React and friends) needs: it goes through the field\u2019s own value setter and emits beforeinput/input/change, so component state updates exactly as it does for a person. Replaces the value unless append is true. Pass submit true to press Enter afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_FIELD,
        selector: SELECTOR_FIELD,
        text: { type: 'string' },
        append: {
          type: 'boolean',
          description: 'Add to what is already in the field instead of replacing it.'
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter in the field after typing, without a separate press call.'
        },
        page: PAGE_TARGET_FIELD
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'press',
    description:
      'Press a key, or repeat one, through the browser\u2019s input pipeline so the page sees a trusted key. Focus the target first by passing its ref or selector; without one the press lands on whatever holds focus.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            'The key: Enter, Tab, Escape, Space, Backspace, Delete, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, F1 to F24, or one character.'
        },
        ref: REF_FIELD,
        selector: SELECTOR_FIELD,
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Held modifiers: shift, control, alt, meta.'
        },
        times: { type: 'number', description: 'Repeat count, up to 20. Defaults to 1.' },
        page: PAGE_TARGET_FIELD
      },
      required: ['key'],
      additionalProperties: false
    }
  },
  {
    name: 'select',
    description:
      'Choose an option of a select element by value, by visible label, or several at once for a multiple select, and report the selection the page kept. On an unmatched value the answer lists the options, so pick from what is actually there.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_FIELD,
        selector: SELECTOR_FIELD,
        value: { type: 'string', description: 'The option value, or its visible label.' },
        label: { type: 'string', description: 'The option\u2019s visible label.' },
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Several option values, for a multiple select.'
        },
        page: PAGE_TARGET_FIELD
      },
      additionalProperties: false
    }
  },
  {
    name: 'check',
    description:
      'Tick or untick a checkbox, radio, or role switch, and report the state the page kept.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_FIELD,
        selector: SELECTOR_FIELD,
        checked: { type: 'boolean', description: 'false to untick; defaults to true.' },
        page: PAGE_TARGET_FIELD
      },
      additionalProperties: false
    }
  },
  {
    name: 'mouse',
    description:
      'Move, hover, press, release, or click the pointer at a point in the page, through the browser\u2019s input pipeline, and leave a visible cursor where it acted so a screenshot shows it. Aim at an element with ref or selector, or at explicit x and y. A drag is the separate drag operation; use wheel with deltaY to scroll at a point.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'hover', 'click', 'down', 'up', 'wheel'],
          description: 'What the pointer does. Defaults to click.'
        },
        ref: REF_FIELD,
        selector: SELECTOR_FIELD,
        x: { type: 'number', description: 'Point x in page pixels, used when no element is named.' },
        y: { type: 'number', description: 'Point y in page pixels, used when no element is named.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clickCount: { type: 'number', description: '1 for a click, 2 for a double click.' },
        deltaX: { type: 'number', description: 'Horizontal wheel delta, for action "wheel".' },
        deltaY: { type: 'number', description: 'Vertical wheel delta, for action "wheel".' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Held modifiers: shift, control, alt, meta.'
        },
        page: PAGE_TARGET_FIELD
      },
      additionalProperties: false
    }
  },
  {
    name: 'drag',
    description:
      'Drag from one point to another through the browser\u2019s input pipeline, moving in steps so a slider, sortable list, canvas or drop target follows the same path a hand would. Give from and to as {ref} or {selector} or {x, y}.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'object', description: 'Start: {ref}, {selector}, or {x, y}.' },
        to: { type: 'object', description: 'End: {ref}, {selector}, or {x, y}.' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Held modifiers: shift, control, alt, meta.'
        },
        page: PAGE_TARGET_FIELD
      },
      required: ['from', 'to'],
      additionalProperties: false
    }
  },
  {
    name: 'scroll',
    description:
      'Scroll the page, bring an element into view, or jump to the top or bottom, and report where the page ended up. A container that scrolls on its own is scrolled by naming it with ref or selector.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_FIELD,
        selector: SELECTOR_FIELD,
        to: { type: 'string', enum: ['top', 'bottom'] },
        deltaX: { type: 'number', description: 'Horizontal distance in pixels.' },
        deltaY: { type: 'number', description: 'Vertical distance in pixels. Defaults to 600.' },
        page: PAGE_TARGET_FIELD
      },
      additionalProperties: false
    }
  },
  {
    name: 'wait',
    description:
      'Wait, in the page, until a condition holds or the time is up: an element appears, an element goes away, text appears, or the address changes. Reading state is easier than guessing with a fixed pause, and a timeout answers with what the page looked like rather than failing the call.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Wait for this element to be present and visible.' },
        gone: { type: 'boolean', description: 'With selector: wait for it to disappear.' },
        visible: { type: 'boolean', description: 'false with selector: wait for it to exist even if hidden.' },
        text: { type: 'string', description: 'Wait for this text to appear in the page.' },
        urlIncludes: { type: 'string', description: 'Wait for the address to contain this.' },
        timeoutMs: { type: 'number', description: 'Up to 30000. Defaults to 5000.' },
        page: PAGE_TARGET_FIELD
      },
      additionalProperties: false
    }
  },
  {
    name: 'evaluate',
    description:
      'Run an expression in the page and return its value. This is the escape hatch for what the element operations do not cover: reading state a snapshot does not describe, dispatching a page\u2019s own API, or measuring layout. It reaches the page exactly as its own script would, so it is reviewed before it runs on the page the user is on.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            'JavaScript evaluated in the page. The last expression\u2019s value is returned; a promise is awaited. Example: document.title'
        },
        page: PAGE_TARGET_FIELD
      },
      required: ['expression'],
      additionalProperties: false
    }
  },
  {
    name: 'upload',
    description:
      'Choose files for a file input on the current browser page. This fills the input only; it does not submit the form. Auto Review always opens the native file chooser for the user to select the files. Full Access can supply absolute paths directly, or omit paths to open the chooser.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS selector for an input[type="file"]. Defaults to the first file input on the page.'
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 10,
          description:
            'Absolute local file paths, used only in Full Access. Auto Review always asks the user to choose files in the native file chooser.'
        },
        page: {
          type: 'string',
          enum: ['user', 'agent'],
          description:
            'Which page to work on: "agent" for a page you opened, "user" for the page this conversation\u2019s thread browser is on. Defaults to your own page when you have one, and to the thread browser\u2019s page otherwise.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'navigate',
    description:
      'Navigate the current in-app browser tab to an http(s) URL. Navigating the thread browser\u2019s page (page "user") is reviewed first: it moves the page the user is reading, not the tab they have in front of them.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        page: {
          type: 'string',
          enum: ['user', 'agent'],
          description:
            'Which page to work on: "agent" for a page you opened, "user" for the page this conversation\u2019s thread browser is on. Defaults to your own page when you have one, and to the thread browser\u2019s page otherwise.'
        }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'screenshot',
    description:
      'Capture the page as an image. That is how you see what a person sees: layout, disabled states, error text under a field, where the agent cursor is. Pass fullPage for a long page, or a ref/selector for one element, and the crop is rendered at the same size budget as a viewport capture. A page unchanged since the previous capture is reported as unchanged rather than sent again; pass {"force":true} to capture it regardless.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'Capture even when the page is unchanged since the previous screenshot.'
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the whole document, not just the visible viewport.'
        },
        ref: REF_FIELD,
        selector: {
          type: 'string',
          description: 'Capture only this element, by the selector a snapshot reported.'
        },
        page: PAGE_TARGET_FIELD
      },
      additionalProperties: false
    }
  },
  {
    name: 'reload',
    description: 'Reload the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          enum: ['user', 'agent'],
          description:
            'Which page to work on: "agent" for a page you opened, "user" for the page this conversation\u2019s thread browser is on. Defaults to your own page when you have one, and to the thread browser\u2019s page otherwise.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'console',
    description:
      'Read console messages and browser runtime errors from the page being worked on. The thread browser\u2019s own page is readable with page "user", which is the page the user is looking at.',
    inputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          enum: ['user', 'agent'],
          description:
            'Which page to work on: "agent" for a page you opened, "user" for the page this conversation\u2019s thread browser is on. Defaults to your own page when you have one, and to the thread browser\u2019s page otherwise.'
        }
      },
      additionalProperties: false
    }
  }
]

/** The agent names completed steps, not every keystroke or tool call. */
function authoredWorkCheckpointTool(): McpTool {
  return {
    name: 'checkpoint',
    description:
      'Save a durable, named step for one screen. Call before editing an existing screen and after each major section, title, image, navbar or scene change, before starting the next step. Unchanged content creates no duplicate snapshot. When Git tracks this folder, reports that Git owns history and creates no app snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Project-relative authored-work folder.' },
        entry: {
          type: 'string',
          description: 'Screen entry relative to that folder, such as index.html or creator.html.'
        },
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          description:
            'Short user-facing description of the completed step, such as Hero title updated.'
        }
      },
      required: ['directory', 'entry', 'label'],
      additionalProperties: false
    }
  }
}

/**
 * Operations of the app-owned design capability (`cio:design`).
 *
 * These operations are things the agent cannot do with its own tools: show
 * the design on the app's own origin, run the model the user assigned to a piece
 * of design work, save a named checkpoint, generate an asset with the model assigned to a media craft, and
 * turn a generated asset into a file beside the design. Looking at the result is
 * deliberately not repeated here: the browser capability already owns
 * screenshots, viewports and console reads, and the docs point at it.
 */
export function designUtilityTools(roots: WorkRoots): McpTool[] {
  const designRoot = workRootForKind(roots, 'design')
  return [
    ...designMotionTools(),
    {
      name: 'read-contract',
      description:
        'Read existing DESIGN.md or DESIGNS.md, case-insensitively, at root, apps and src. Root takes precedence. No recursive search.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'extract-reference',
      description:
        'Measure visible typography, area-weighted colours, component spacing and logo references from a user-named web page in an isolated renderer. Returns measured facts for a lightweight design contract.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', maxLength: 4096 } },
        required: ['url'],
        additionalProperties: false
      }
    },
    {
      name: 'lint',
      description:
        'Run bounded craft checks over one authored HTML screen off the main thread. Returns concrete rules and source lines; visual judgement belongs in critique.',
      inputSchema: {
        type: 'object',
        properties: { directory: { type: 'string' }, entry: { type: 'string' } },
        required: ['directory', 'entry'],
        additionalProperties: false
      }
    },
    authoredWorkCritiqueTool(),
    {
      name: 'write-contract',
      description:
        'Generate a root DESIGN.md and preserve existing matching contracts as timestamped old-file backups. Only use when the user requested contract generation.',
      inputSchema: {
        type: 'object',
        properties: { markdown: { type: 'string', minLength: 1, maxLength: 131072 } },
        required: ['markdown'],
        additionalProperties: false
      }
    },
    generateMediaTool(roots),
    authoredWorkCheckpointTool(),
    {
      name: 'preview',
      description: `Serve a project folder on the app's own loopback origin and open it in this project and thread's browser tab. The folder's own scripts and stylesheets run, so an HTML design renders as written, and the tab is mounted offscreen at a real viewport whether or not the user is looking at it. Aim it at the folder holding the design's entry file, and name \`entry\` to turn it to one of that design's screens.`,
      inputSchema: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: `Project-relative folder to serve. Defaults to ${designRoot}.`
          },
          entry: {
            type: 'string',
            description:
              'File inside that folder to load, relative to it, which is how a screen of a multi-screen design is shown: "dashboard.html". Defaults to index.html when that file exists; otherwise the folder listing is shown.'
          },
          attention: {
            type: 'string',
            enum: ['focus', 'background'],
            description:
              'background (default) keeps the tab offscreen without interrupting the user; focus remains available when background interaction cannot accomplish the task.'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'delegate',
      description:
        "Run one prompt on the model the user assigned to a named piece of design work: long-form copy, an SEO pass, a script, a storyboard. The assigned model did not see this conversation, so the prompt has to carry every detail it needs. This lane answers with text only: a craft that produces a picture, a clip or a track is made by the `generate` operation instead, which uses the model the user assigned to that craft. Assignments that share one craft are the user's own alternatives and are tried in the order they are listed. Never choose a model yourself and never stand in for one.",
      inputSchema: {
        type: 'object',
        properties: {
          assignment: {
            type: 'string',
            description:
              'The design work to delegate, named by its handle or its title. The playbook lists the assignments the user set up.'
          },
          prompt: {
            type: 'string',
            description:
              'The complete brief for the assigned model: the subject, the tone, the format, and every constraint, written as if to a stranger who has seen nothing of this work.'
          }
        },
        required: ['assignment', 'prompt'],
        additionalProperties: false
      }
    },
    {
      name: 'groups',
      description:
        "Read how the user organises this project's designs on the coordinator board: the named groups, the designs each one holds, how the board draws them, and when the user last rearranged them. Read this before you talk about the arrangement, and again after the user says they moved something. A group is a record about folders, not a place to put them, so reading it never changes where a design lives.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['design', 'video'],
            description: 'Which board to read. Defaults to design.'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'organize-designs',
      description:
        "Change how the user's designs are grouped on the coordinator board. This is the only way you may group designs: it writes names and memberships, never a folder, so no design moves on disk and no rename ever happens here. Every call answers with the whole board afterwards. Actions: create (a new empty group), rename, delete (its designs return to ungrouped), assign (move designs into a group, or out of every group when group is omitted), reorder (the order the groups appear in), view (cards, which is a picture per design, or list, which is a folded list).",
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'rename', 'delete', 'assign', 'reorder', 'view'],
            description: 'What to change about the arrangement.'
          },
          kind: {
            type: 'string',
            enum: ['design', 'video'],
            description: 'Which board to change. Defaults to design.'
          },
          name: {
            type: 'string',
            maxLength: 80,
            description: 'The group name for create, or the new name for rename.'
          },
          group: {
            type: 'string',
            description:
              'The group to act on for rename, delete and assign, by its name or the id the last read returned. Omit it for assign to ungroup the designs.'
          },
          designs: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Project-relative design folders for assign, such as .cio/designs/hero. These are the folders the board lists; grouping them does not move them.'
          },
          order: {
            type: 'array',
            items: { type: 'string' },
            description: 'Group names or ids in the order they should appear, for reorder.'
          },
          view: {
            type: 'string',
            enum: ['cards', 'list'],
            description: 'How the board should draw the designs, for view.'
          }
        },
        required: ['action'],
        additionalProperties: false
      }
    },
    {
      name: 'save-media',
      description: `Save a generated image, video or sound file into the project, so the design references a file of its own instead of a link that expires. Give it the https link the generation service answered with; the file is named after the source unless you name it. The reply carries the relative path to use in the markup.`,
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description:
              'The https link the generation service returned for the asset. Only an https link with a media type, from a public host, is accepted.'
          },
          name: {
            type: 'string',
            description:
              'Optional file name without an extension, such as hero. Defaults to the name in the source URL.'
          },
          directory: {
            type: 'string',
            description: `Project-relative folder to save into. Defaults to ${designRoot}, so name the design's own folder when the asset belongs to a design.`
          }
        },
        required: ['source'],
        additionalProperties: false
      }
    }
  ]
}

/**
 * Operations of the app-owned video capability (`cio:video`).
 *
 * Three operations, because watching, checking and making are three different
 * acts. `preview` serves the composition folder and opens it in the browser tab,
 * where the page runs and the tab refreshes itself as the agent writes. `capture`
 * freezes the composition at one second and answers with the picture, which is
 * the only way an agent can tell whether the frame it wrote is the frame it
 * meant. `generate` produces a clip, a still or a music bed with the model the
 * user assigned to that craft, which is what a composition's audio track and its
 * b-roll clips need.
 */
export function videoUtilityTools(roots: WorkRoots): McpTool[] {
  const videoRoot = workRootForKind(roots, 'video')
  return [
    ...videoStudioTools(),
    authoredWorkCritiqueTool('video'),
    generateMediaTool(roots),
    authoredWorkCheckpointTool(),
    {
      name: 'preview',
      description: `Serve a project folder on the app's own loopback origin and open it in this project and thread's browser tab, where the composition runs and is watched. The tab refreshes itself shortly after a file changes, so preview again only when you move to a different folder. Aim it at the folder holding the composition's index.html.`,
      inputSchema: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: `Project-relative folder to serve. Defaults to ${videoRoot}.`
          },
          entry: {
            type: 'string',
            description:
              'File inside that folder to load, relative to it. Defaults to index.html when that file exists; otherwise the folder listing is shown.'
          },
          attention: {
            type: 'string',
            enum: ['focus', 'background'],
            description:
              'background (default) keeps the tab offscreen without interrupting the user; focus remains available when background interaction cannot accomplish the task.'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'capture',
      description: `Freeze the composition at one second and hand the frame back as a picture you can see. This is how you check your own work: overflowed text, colliding labels, a colour that vanishes into the background and a caption over a busy area are invisible in the code and obvious in a frame. The composition must define window.cioRenderFrame(seconds) and a composition.json declaring its length; the time is clamped to that length. Call it for the first frame, the last frame and every moment something changes.`,
      inputSchema: {
        type: 'object',
        properties: {
          time: {
            type: 'number',
            description:
              'Seconds on the timeline to freeze, from 0 to the manifest duration. Defaults to 0.'
          },
          directory: {
            type: 'string',
            description: `Project-relative folder holding the composition. Defaults to ${videoRoot}.`
          },
          entry: {
            type: 'string',
            description:
              'File inside that folder to load, relative to it. Defaults to index.html when that file exists.'
          }
        },
        additionalProperties: false
      }
    }
  ]
}

export function gatewayUtility(
  request: GatewayTurnContext,
  scriptPath: string,
  bridgeUrl: string,
  token: string
): ResolvedUtility {
  const now = Date.now()
  const utility: UtilityDefinitionFor<'mcp'> = {
    id: `${GATEWAY_UTILITY_ID_PREFIX}${request.threadId}`,
    kind: 'mcp',
    name: 'CodeInOven utilities',
    description: 'Search, activate, and invoke scoped app-owned utilities on demand.',
    enabled: true,
    activation: 'always',
    scope: { level: 'thread', projectId: request.projectId, threadId: request.threadId },
    config: {
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      environment: {
        ELECTRON_RUN_AS_NODE: '1',
        CODEINOVEN_UTILITY_BRIDGE_URL: bridgeUrl,
        CODEINOVEN_UTILITY_BRIDGE_TOKEN: token,
        [GATEWAY_BRIDGE_CALL_CAP_ENV]: String(GATEWAY_BRIDGE_CALL_CAP_MS)
      }
    },
    credentials: [],
    harnessBindings: [
      { harnessId: request.harnessId, strategy: 'mcp', transportName: 'utilities' }
    ],
    appOwned: false,
    createdAt: now,
    updatedAt: now
  }
  const binding: HarnessUtilityBinding = utility.harnessBindings[0]!
  return { utility, binding }
}

/** Build the stdio MCP gateway script. The tool list and the tools/call route
 *  map are generated from `GATEWAY_TOOLS`, so the agent-facing contract always
 *  matches the catalog   no hand-synchronized copy to drift.
 *
 *  Calls run concurrently. One bridge process serves every call the harness makes to
 *  `cio_util_*`, across the sessions that share it, so a single slow call (a secret card
 *  waiting on a human, a long browser or computer-use operation) must never queue the calls
 *  behind it. Each call answers on its own by JSON-RPC id, and a client cancellation aborts
 *  exactly the call it names. */
export function buildUtilityGatewayScript(
  gatewayTools = initialGatewayTools(GATEWAY_TOOLS)
): string {
  const tools = gatewayTools.map(gatewayToolForModel).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema
  }))
  const routes: Record<string, string> = {}
  for (const tool of gatewayTools) routes[tool.name] = tool.route
  const callCapMs = GATEWAY_BRIDGE_CALL_CAP_MS
  const callCapEnv = GATEWAY_BRIDGE_CALL_CAP_ENV
  return String.raw`import readline from 'node:readline'

const baseUrl = process.env.CODEINOVEN_UTILITY_BRIDGE_URL
const token = process.env.CODEINOVEN_UTILITY_BRIDGE_TOKEN
const configuredCapMs = Number(process.env.${callCapEnv})
const callCapMs =
  Number.isFinite(configuredCapMs) && configuredCapMs > 0 ? configuredCapMs : ${callCapMs}
const tools = ${JSON.stringify(tools)}
const routes = ${JSON.stringify(routes)}

// One live call per JSON-RPC id, so a cancellation aborts exactly the call it names.
// Cancelled ids are remembered so the bridge never answers a call the client has
// already stopped waiting for.
const inFlight = new Map()
const cancelled = new Set()

function write(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function failureMessage(error, controller) {
  if (controller.signal.aborted) {
    const reason = controller.signal.reason
    if (reason instanceof Error) return reason.message
    if (typeof reason === 'string' && reason) return reason
    return 'Utility gateway call was cancelled'
  }
  return error instanceof Error ? error.message : 'Gateway failure'
}

/** A secret result can carry collected values out of band for an in-process gateway
 *  transport. No MCP transport may forward them, so the reserved field is dropped here,
 *  before the tool result reaches the harness. */
function resultContent(result) {
  if (result && typeof result === 'object' && 'environment' in result) {
    delete result.environment
  }
  return Array.isArray(result?.content)
    ? result.content
    : [{ type: 'text', text: JSON.stringify(result) }]
}

async function callUtility(request, controller) {
  if (!baseUrl || !token) throw new Error('Utility bridge environment is unavailable')
  const name = request.params?.name
  const args = request.params?.arguments || {}
  const path = routes[name]
  if (!path) throw new Error('Unknown utility gateway tool')
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: controller.signal
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Utility bridge call failed')
  return body
}

async function respondToCall(request) {
  const id = request.id
  const key = String(id)
  const controller = new AbortController()
  const cap = setTimeout(() => {
    controller.abort(new Error('Utility gateway call exceeded its ' + callCapMs + ' ms cap'))
  }, callCapMs)
  if (typeof cap.unref === 'function') cap.unref()
  inFlight.set(key, controller)
  try {
    const result = await callUtility(request, controller)
    if (cancelled.has(key)) return
    // An operation that declares an output schema answers with its payload both
    // ways. A client that runs scripts resolves the call to \`structuredContent\`,
    // and one that does not still reads the content parts, so forwarding both
    // costs the shape nothing and makes the structured payload reach a harness
    // that used to lose it at this hop.
    const structured =
      result && typeof result === 'object' && !Array.isArray(result)
        ? result.structuredContent
        : undefined
    write({
      jsonrpc: '2.0',
      id: id,
      result:
        structured === undefined
          ? { content: resultContent(result) }
          : { content: resultContent(result), structuredContent: structured }
    })
  } catch (error) {
    if (cancelled.has(key)) return
    write({
      jsonrpc: '2.0',
      id: id,
      error: { code: -32000, message: failureMessage(error, controller) }
    })
  } finally {
    clearTimeout(cap)
    inFlight.delete(key)
    cancelled.delete(key)
  }
}

/** Abort one in-flight call. The response is suppressed, because the client that sent
 *  the cancellation has already stopped waiting for it. */
function cancelCall(params) {
  const key = String(params?.requestId)
  const controller = inFlight.get(key)
  if (!controller) return
  cancelled.add(key)
  controller.abort(
    new Error('Cancelled by the client: ' + (params?.reason || 'no reason given'))
  )
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
  } catch {
    continue
  }
  if (request.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'codeinoven-utilities', version: '1' }
      }
    })
    continue
  }
  if (request.method === 'tools/list') {
    write({ jsonrpc: '2.0', id: request.id, result: { tools: tools } })
    continue
  }
  if (request.method === 'ping') {
    write({ jsonrpc: '2.0', id: request.id, result: {} })
    continue
  }
  if (request.method === 'notifications/cancelled') {
    cancelCall(request.params)
    continue
  }
  if (request.method === 'tools/call') {
    // Deliberately not awaited: the loop must keep reading stdin so a slow call cannot
    // delay the calls behind it. respondToCall writes its own result or error.
    void respondToCall(request)
    continue
  }
  if (request.id !== undefined) {
    write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
  }
}
`
}

const MAX_CUA_SESSION_TITLE_CHARS = 24

/**
 * Build the Cua session id shown as the on-screen agent cursor label. The
 * turn id is always kept so session identity stays stable; the thread title
 * is prepended as a human-readable label (e.g. `cio-fix-pip-focus-a1b2c3`).
 */
export function buildCuaSessionId(threadTitle: string | undefined, turnId: string): string {
  const label = (threadTitle ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_CUA_SESSION_TITLE_CHARS)
    .replace(/-+$/gu, '')
  return label ? `cio-${label}-${turnId}` : `codeinoven-${turnId}`
}
