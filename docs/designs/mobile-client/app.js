/* CodeInOven Mobile, interactive prototype.
   One mocked phone, one page. The agent side is scripted: send a message and the
   turn walks through a question card, a permission request, a secret prompt and an
   engineering run. Every card is real UI: it folds, counts down, and resolves. */

const icons = {
  search:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="M13.3 13.3 17.5 17.5"/></svg>',
  group:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M3 5h14M3 10h9M3 15h5"/></svg>',
  back:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M12.5 4 6 10l6.5 6"/></svg>',
  more:
    '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="3" y="8.5" width="3" height="3"/><rect x="8.5" y="8.5" width="3" height="3"/><rect x="14" y="8.5" width="3" height="3"/></svg>',
  chevron:
    '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M2 8l4-4 4 4"/></svg>',
  chevronDown:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="square" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>',
  close:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15"/></svg>',
  plus:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>',
  mic:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><rect x="7.5" y="2.5" width="5" height="9"/><path d="M5 9.5a5 5 0 0 0 10 0M10 14.5V18"/></svg>',
  arrow:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5"/></svg>',
  clock:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.5"/></svg>',
  stop:
    '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="8" height="8"/></svg>',
  shield:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="miter" aria-hidden="true"><path d="M8 2l5 2v5c0 3-2.2 4.6-5 5-2.8-.4-5-2-5-5V4z"/></svg>',
  shieldAlert:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="miter" aria-hidden="true"><path d="M8 2l5 2v5c0 3-2.2 4.6-5 5-2.8-.4-5-2-5-5V4z"/><path d="M8 5.5v3M8 10.5v.01"/></svg>',
  tool:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="miter" aria-hidden="true"><path d="M10.5 1.8 14.2 5.5 6.2 13.5H2.5v-3.7z"/></svg>',
  file:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square" aria-hidden="true"><path d="M3 2h7l3 3v9H3z"/><path d="M10 2v3h3"/></svg>',
  diff:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square" aria-hidden="true"><rect x="2" y="2" width="12" height="12"/><path d="M5 8h6"/></svg>',
  terminal:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square" aria-hidden="true"><path d="M2.5 4 6 8l-3.5 4M8 12h5.5"/></svg>',
  check:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4"/></svg>',
  cross:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  eye:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="square" aria-hidden="true"><path d="M1.5 10s3.1-5 8.5-5 8.5 5 8.5 5-3.1 5-8.5 5-8.5-5-8.5-5z"/><circle cx="10" cy="10" r="2"/></svg>',
  eyeOff:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="square" aria-hidden="true"><path d="M1.5 10s3.1-5 8.5-5 8.5 5 8.5 5-3.1 5-8.5 5-8.5-5-8.5-5z"/><path d="M3 3l14 14"/></svg>',
  threads:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h9"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M3 6h6l2 3h10v11H3z"/></svg>',
  chat:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter" aria-hidden="true"><path d="M4 4h16v12H9l-5 4z"/></svg>',
  assistant:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter" aria-hidden="true"><path d="M12 3l2 5.5L19.5 10 14 12l-2 5.5L10 12 4.5 10 10 8.5z"/></svg>',
  timeline:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square" aria-hidden="true"><circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5v6M5 8.5h4.5V7.5"/></svg>',
  battery:
    '<svg viewBox="0 0 16 12" fill="currentColor" aria-hidden="true"><rect x="0" y="2" width="13" height="8" rx="1" opacity="0.35"/><rect x="1.5" y="3.5" width="8" height="5"/><rect x="14" y="4.5" width="2" height="3"/></svg>',
  signal:
    '<svg viewBox="0 0 16 12" fill="currentColor" aria-hidden="true"><rect x="0" y="8" width="2" height="4"/><rect x="4" y="5" width="2" height="7"/><rect x="8" y="2" width="2" height="10"/><rect x="12" y="0" width="2" height="12" opacity="0.4"/></svg>',
};

const brandMark = `<svg class="mark" viewBox="0 0 96 96" aria-hidden="true">
  <path d="M49 17a31 31 0 1 0 0 62" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="square" stroke-linejoin="miter"/>
  <path d="M61 23h23v50H61z" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="miter"/>
  <rect x="58" y="45" width="29" height="6" fill="currentColor"/>
  <circle cx="84" cy="48" r="5" fill="var(--color-accent)"/>
</svg>`;

/* ── State ─────────────────────────────────────────────────────────────────── */

const threads = [
  {
    id: 'row-marks',
    title: 'Thread row status marks',
    project: 'codeinoven',
    branch: 'row-marks',
    state: 'working',
    meta: 'Auto Pilot · spec approved',
    time: '2h',
    unread: true,
    group: 'working',
    scripted: true,
  },
  {
    id: 'terminal-resize',
    title: 'Terminal resize drift',
    project: 'codeinoven',
    branch: 'main',
    state: 'attention',
    meta: 'Permission waiting · shell command',
    time: 'now',
    group: 'needs',
  },
  {
    id: 'sidebar',
    title: 'Sidebar density pass',
    project: 'pillardash',
    branch: 'density',
    state: 'working',
    meta: 'Assignment · task 3 of 7 · 14m',
    time: '1h',
    group: 'working',
  },
  {
    id: 'sqlite',
    title: 'Fix SQLite lock on restart',
    project: 'codeinoven',
    branch: 'main',
    state: 'done',
    meta: 'Done · 3 files changed · +41 −12',
    time: '3h',
    unread: true,
    group: 'recent',
  },
  {
    id: 'changelog',
    title: 'Changelog wording',
    project: 'codeinoven',
    branch: 'main',
    state: 'done',
    meta: 'Done · committed on mobile-app',
    time: 'Mon',
    group: 'recent',
  },
  {
    id: 'keymap',
    title: 'Keymap conflict audit',
    project: 'pillardash',
    branch: 'main',
    state: 'todo',
    meta: 'Draft · nothing sent yet',
    time: 'Sun',
    group: 'recent',
  },
];

const view = document.getElementById('view');
const appbar = document.getElementById('appbar');
const composer = document.getElementById('composer');
const field = document.getElementById('field');
const sendBtn = document.getElementById('send');
const dock = document.getElementById('dock');
const scrim = document.getElementById('scrim');
const sheet = document.getElementById('sheet');
const toastEl = document.getElementById('toast');

const state = {
  view: 'inbox',
  threadId: null,
  tab: 'threads',
  sessions: new Map(),
  busy: new Map(),
  queue: new Map(),
  pendingCards: new Set(),
  stopArmed: false,
  sheet: null,
  model: 'claude-opus-4.6',
  autoPilot: true,
  stage: 'spec',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = String(html).trim();
  return t.content.firstElementChild;
};
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const threadById = (id) => threads.find((t) => t.id === id);
const activeThread = () => threadById(state.threadId);

function toast(message, tone = 'ok') {
  toastEl.innerHTML = `${tone === 'ok' ? icons.check : icons.cross}<span>${esc(message)}</span>`;
  toastEl.dataset.open = 'true';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toastEl.dataset.open = 'false'), 2600);
}

function session(thread) {
  if (!state.sessions.has(thread.id)) {
    state.sessions.set(thread.id, { nodes: [], step: 0, elapsed: 0, started: 0, statusText: '' });
  }
  return state.sessions.get(thread.id);
}

function isBusy(thread) {
  return Boolean(state.busy.get(thread.id));
}

function setBusy(thread, value) {
  if (value) state.busy.set(thread.id, true);
  else state.busy.delete(thread.id);
  if (state.threadId === thread.id) {
    paintStatus(thread);
    paintSend();
  }
  paintDockBadge();
}

/* ── Status line and send button ───────────────────────────────────────────── */

function statusNode() {
  return view.querySelector('.status-line');
}

function paintStatus(thread) {
  const node = statusNode();
  if (!node || !thread) return;
  const s = session(thread);
  if (isBusy(thread)) {
    node.dataset.state = 'working';
    node.querySelector('.status-text').textContent = s.statusText || 'Working';
    node.querySelector('.elapsed')?.remove();
    const elapsed = el(`<span class="elapsed">${s.elapsed}s</span>`);
    node.append(elapsed);
  } else if (s.stopped) {
    node.dataset.state = 'stopped';
    node.querySelector('.status-text').textContent = 'Stopped';
    node.querySelector('.elapsed')?.remove();
  } else {
    node.dataset.state = 'idle';
    node.querySelector('.status-text').textContent = s.statusIdle || 'Ready';
    node.querySelector('.elapsed')?.remove();
  }
}

function setStatus(thread, text) {
  session(thread).statusText = text;
  paintStatus(thread);
}

setInterval(() => {
  const thread = activeThread();
  if (!thread || !isBusy(thread)) return;
  const s = session(thread);
  s.elapsed += 1;
  const node = statusNode();
  if (node && !node.querySelector('.elapsed')) {
    node.append(el(`<span class="elapsed">${s.elapsed}s</span>`));
  } else if (node) {
    node.querySelector('.elapsed').textContent = `${s.elapsed}s`;
  }
}, 1000);

const stageNames = {
  brainstorm: 'Brainstorm',
  prd: 'PRD',
  spec: 'Spec',
  assignment: 'Assignment',
  achievement: 'Achievement',
};

const modelNames = {
  'claude-opus-4.6': 'opus 4.6',
  'gpt-5.2-codex': 'codex 5.2',
  'deepseek-v4': 'deepseek v4',
};

function paintSettings() {
  const stageLabel = document.getElementById('stage-label');
  const modelLabel = document.getElementById('model-label');
  if (stageLabel) stageLabel.textContent = state.autoPilot ? 'Auto Pilot' : stageNames[state.stage];
  if (modelLabel) modelLabel.textContent = modelNames[state.model] ?? state.model;
}

function paintSend() {
  const thread = activeThread();
  const busy = thread ? isBusy(thread) : false;
  const hasText = field.value.trim().length > 0;
  const mode = !busy ? (hasText ? 'send' : 'idle') : hasText ? 'queue' : 'stop';
  sendBtn.dataset.mode = state.stopArmed ? 'armed' : mode;
  sendBtn.disabled = mode === 'idle';
  sendBtn.innerHTML = state.stopArmed
    ? 'Stop?'
    : mode === 'queue'
      ? icons.clock
      : mode === 'stop'
        ? icons.stop
        : icons.arrow;
  sendBtn.title =
    mode === 'queue'
      ? 'Queue this message'
      : mode === 'stop'
        ? 'Stop this turn'
        : mode === 'idle'
          ? 'Write something to send'
          : 'Send this message';
  sendBtn.setAttribute('aria-label', sendBtn.title);
  const queue = thread ? state.queue.get(thread.id) ?? [] : [];
  const pill = composer.querySelector('.queued');
  if (pill) paintQueue(queue);
}

function paintQueue(queue) {
  const existing = composer.querySelector('.queued');
  if (!queue.length) {
    existing?.remove();
    return;
  }
  const node =
    existing ??
    el(`<div class="queued" role="status">
      ${icons.clock}
      <span></span>
      <button type="button" data-action="clear-queue" title="Discard the queued message" aria-label="Discard the queued message">${icons.close}</button>
    </div>`);
  node.querySelector('span').innerHTML = `<b>Queued</b> · ${esc(queue[0])}${queue.length > 1 ? ` +${queue.length - 1}` : ''}`;
  if (!existing) composer.prepend(node);
}

/* ── Scrolling ─────────────────────────────────────────────────────────────── */

function nearBottom() {
  return view.scrollHeight - view.scrollTop - view.clientHeight < 96;
}

function scrollDown(force = false) {
  if (force || nearBottom()) {
    requestAnimationFrame(() => {
      view.scrollTop = view.scrollHeight;
    });
  }
}

/* ── Turns ─────────────────────────────────────────────────────────────────── */

function transcript() {
  return view.querySelector('.transcript');
}

function appendTurn(thread, node, store = true) {
  const scene = transcript();
  if (!scene) return;
  const wasNearBottom = nearBottom();
  scene.append(node);
  if (store) session(thread).nodes.push(node);
  if (wasNearBottom || !store) scrollDown(true);
}

function userTurn(text) {
  return el(`<div class="turn user">
    <p class="who">You</p>
    <p class="bubble">${esc(text)}</p>
  </div>`);
}

function agentTurn(html, options = {}) {
  return el(`<div class="turn agent${options.stopped ? ' stopped' : ''}">
    <p class="who">Agent</p>
    <div class="prose">${html}</div>
    ${options.tools ?? ''}
  </div>`);
}

function toolLine(what, stat, stateName = 'done', iconName = 'tool') {
  return el(`<div class="tool" data-state="${stateName}">
    ${icons[iconName]}
    <span class="what">${esc(what)}</span>
    <span class="stat">${stat}</span>
  </div>`);
}

/* ── Cards ─────────────────────────────────────────────────────────────────── */

let cardSeq = 0;
const cardWaiters = new Map();

function cardShell(kind, label, body, extra = {}) {
  const id = `card-${++cardSeq}`;
  const node = el(`<article class="card" data-card-id="${id}" data-kind="${kind}" aria-label="${esc(label)}">
    <div class="card-head">
      <span class="kind">${esc(kind)}</span>
      <span class="head-note">${extra.note ?? ''}</span>
      ${extra.timer ?? ''}
      <button class="fold" type="button" data-action="fold" title="Fold this card" aria-label="Fold the ${esc(kind.toLowerCase())} card">${icons.chevron}</button>
    </div>
    ${body}
  </article>`);
  if (extra.foot) node.append(el(extra.foot));
  state.pendingCards.add(node);
  paintDockBadge();
  return node;
}

function settleCard(node, label, tone = 'yes') {
  if (node.dataset.decided === 'true') return;
  node.dataset.decided = 'true';
  node.dataset.decision = node.dataset.decision ?? 'timeout';
  clearInterval(node._timer);
  state.pendingCards.delete(node);
  paintDockBadge();
  const foot = node.querySelector('.card-foot');
  if (foot) foot.remove();
  node.querySelector('.choices')?.remove();
  node.querySelector('.timer')?.remove();
  node.append(
    el(`<div class="decision" data-tone="${tone}">
      ${tone === 'yes' ? icons.check : icons.cross}
      <span>${esc(label)}</span>
    </div>`),
  );
  const waiter = cardWaiters.get(node.dataset.cardId);
  if (waiter) {
    cardWaiters.delete(node.dataset.cardId);
    waiter(node);
  }
}

function waitFor(node) {
  return new Promise((resolve) => cardWaiters.set(node.dataset.cardId, resolve));
}

function timerMarkup(seconds) {
  return `<span class="timer" data-state="ok">
    <span class="drain" aria-hidden="true"><i style="transform: scaleX(1)"></i></span>
    <span class="tval">${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}</span>
  </span>`;
}

function runTimer(node, seconds, onExpire) {
  const elTimer = node.querySelector('.timer');
  if (!elTimer) return;
  let left = seconds;
  let paused = false;
  const paint = () => {
    elTimer.querySelector('i').style.transform = `scaleX(${left / seconds})`;
    elTimer.querySelector('.tval').textContent = paused
      ? 'Paused'
      : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    elTimer.dataset.state = left <= 15 ? 'warn' : 'ok';
  };
  node._timer = setInterval(() => {
    if (paused || node.dataset.decided === 'true') return;
    left -= 1;
    paint();
    if (left <= 0) {
      clearInterval(node._timer);
      onExpire();
    }
  }, 1000);
  node.addEventListener('pointerenter', () => {
    paused = true;
    paint();
  });
  node.addEventListener('pointerleave', () => {
    paused = false;
    paint();
  });
  node.addEventListener('focusin', () => {
    paused = true;
    paint();
  });
  node.addEventListener('focusout', () => {
    paused = false;
    paint();
  });
  paint();
}

function buildQuestion(opts) {
  const choices = opts.options
    .map(
      (o, i) => `<button class="choice" type="button" role="radio" aria-checked="${i === 0}" data-action="pick" data-index="${i}">
        <span class="box" aria-hidden="true"><i></i></span>
        <span class="label"><b>${esc(o.label)}</b>${o.desc ? `<span>${esc(o.desc)}</span>` : ''}</span>
      </button>`,
    )
    .join('');
  const node = cardShell(
    'Question',
    opts.title,
    `<div class="card-body"><h3>${esc(opts.title)}</h3></div>
     <div class="choices" role="radiogroup" aria-label="Answers">${choices}</div>`,
    {
      note: opts.note ?? '1 of 1',
      foot: `<div class="card-foot">
        <button class="btn quiet" type="button" data-action="skip">Skip</button>
        <span class="push"></span>
        <button class="btn primary" type="button" data-action="submit">Submit answer</button>
      </div>`,
    },
  );
  node.dataset.selected = '0';
  return node;
}

function buildPermission(opts) {
  const node = cardShell(
    'Permission',
    opts.title ?? 'Shell command',
    `<div class="card-body">
      <p class="cmd">${esc(opts.cmd)}</p>
      <p>${esc(opts.why)}</p>
      <p class="vault-note">${esc(opts.scope)}</p>
    </div>`,
    {
      note: opts.note ?? 'Shell command',
      timer: timerMarkup(opts.seconds ?? 95),
      foot: `<div class="card-foot">
        <button class="btn quiet" type="button" data-action="decide" data-value="reject">Reject</button>
        <span class="push"></span>
        <button class="btn" type="button" data-action="decide" data-value="once">Allow once</button>
        <button class="btn primary" type="button" data-action="decide" data-value="always">Allow always</button>
      </div>`,
    },
  );
  runTimer(node, opts.seconds ?? 95, () => settleCard(node, 'Rejected, the request timed out', 'no'));
  return node;
}

function buildSecret(opts) {
  const node = cardShell(
    'Secret',
    opts.title,
    `<div class="card-body">
      <h3>${esc(opts.title)}</h3>
      <p>${esc(opts.why)}</p>
      <div class="secret-field">
        <input id="secret-input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the key" aria-label="${esc(opts.title)}" />
        <button class="icon-btn" type="button" data-action="reveal" title="Show the value" aria-label="Show the value">${icons.eye}</button>
      </div>
      <p class="vault-note">Stored in the encrypted vault. The agent never sees the value.</p>
    </div>`,
    {
      note: 'Vault',
      timer: timerMarkup(opts.seconds ?? 150),
      foot: `<div class="card-foot">
        <button class="btn quiet" type="button" data-action="decide" data-value="cancel">Cancel</button>
        <span class="push"></span>
        <button class="btn primary" type="button" data-action="submit-secret" disabled>Store and answer</button>
      </div>`,
    },
  );
  const input = node.querySelector('input');
  const submit = node.querySelector('[data-action="submit-secret"]');
  input.addEventListener('input', () => {
    submit.disabled = input.value.trim().length === 0;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !submit.disabled) {
      e.preventDefault();
      submit.click();
    }
  });
  runTimer(node, opts.seconds ?? 150, () => settleCard(node, 'Closed, the prompt timed out', 'no'));
  return node;
}

function buildRun() {
  const phases = [
    ['Brainstorm', '6 directions, 2 kept', 'done'],
    ['PRD', 'Finalized, v3', 'done'],
    ['Spec', 'Approved spec.md, 12 sections', 'done'],
    ['Assignment', '3 workers · phase 3 of 5', 'active'],
    ['Achievement', 'Blocked on a failing check', 'blocked'],
  ];
  const node = cardShell(
    'Auto Pilot',
    'Auto Pilot run',
    `<div class="card-progress">
      <div class="track"><i class="gold" style="width: 56%"></i></div>
      <div class="track-label"><span class="run-label">Implementing, 14 of 23 tasks</span><span class="run-pct tabular">56%</span></div>
    </div>
    <div class="stages">
      ${phases
        .map(
          ([name, sub, st], i) => `<div class="stage-row" data-state="${st}" data-index="${i}">
            <span class="n">0${i + 1}</span>
            <span><span class="nm">${name}</span><span class="ds">${sub}</span></span>
            <span class="st">${st === 'done' ? 'Done' : st === 'active' ? 'Running' : 'Waiting'}</span>
          </div>`,
        )
        .join('')}
    </div>`,
    { note: '5 stages' },
  );
  // A run is progress, not a question: it never counts toward the waiting badge.
  state.pendingCards.delete(node);
  paintDockBadge();
  return node;
}

function animateRun(node, onDone) {
  const stages = [...node.querySelectorAll('.stage-row')];
  const bar = node.querySelector('.track i');
  const label = node.querySelector('.run-label');
  const pct = node.querySelector('.run-pct');
  const steps = [
    [56, 'Implementing, 14 of 23 tasks', 900],
    [68, 'Implementing, 16 of 23 tasks', 900],
    [79, 'Implementing, 19 of 23 tasks', 900],
    [88, 'Achievement, running checks', 1100],
    [92, 'Achievement, blocked on bundle budget', 1200],
  ];
  let i = 0;
  const tick = () => {
    const [value, text, delay] = steps[i];
    bar.style.width = `${value}%`;
    pct.textContent = `${value}%`;
    label.textContent = text;
    if (i === 3) {
      stages[3].dataset.state = 'done';
      stages[3].querySelector('.st').textContent = 'Done';
      stages[4].dataset.state = 'active';
      stages[4].querySelector('.st').textContent = 'Running';
    }
    if (i === 4) {
      stages[4].dataset.state = 'blocked';
      stages[4].querySelector('.st').textContent = 'Waiting';
      node.querySelector('.card-foot')?.remove();
    }
    i += 1;
    if (i < steps.length) {
      node._anim = setTimeout(tick, delay);
    } else {
      node._anim = setTimeout(() => onDone(node), 500);
    }
  };
  tick();
}

function runFoot() {
  return `<div class="card-foot">
    <button class="btn quiet" type="button" data-action="fold">Fold</button>
    <span class="push"></span>
    <button class="btn" type="button" data-action="retry">Retry stage</button>
    <button class="btn primary" type="button" data-action="commit">Commit</button>
  </div>`;
}

const diffFiles = [
  { path: 'thread-state-marks.ts', add: 18, del: 9, lines: [['ctx', 54, 'export function stateOf(row: ThreadRow): Mark {'], ['del', 55, "  return row.unread ? 'dot' : 'none'"], ['add', 55, "  if (row.approval) return 'attention'"], ['add', 56, "  if (row.working) return 'live'"], ['add', 57, "  return row.unread ? 'unread' : 'settled'"], ['ctx', 58, '}']] },
  { path: 'ThreadRow.svelte', add: 34, del: 21, lines: [['ctx', 118, '<span class="rail" data-state={mark}>'], ['del', 119, '  <i class="dot" />'], ['add', 119, '  <i class="dot" data-live={live} />'], ['ctx', 120, '</span>']] },
  { path: 'row-marks.spec.ts', add: 121, del: 41, lines: [['ctx', 12, "it('keeps failed and settled apart', () => {"], ['add', 13, "  expect(stateOf(failed)).toBe(\"attention\")"], ['add', 14, "  expect(stateOf(settled)).toBe('settled')"], ['ctx', 15, '})']] },
];

function diffMarkup() {
  return `<div class="diff-files">
    ${diffFiles
      .map(
        (f, i) => `<button class="diff-file" type="button" data-action="diff" data-index="${i}" aria-expanded="false">
          <span class="nm">${esc(f.path)}</span>
          <span class="st"><span class="add">+${f.add}</span> <span class="del">−${f.del}</span></span>
        </button>
        <div class="diff-body" data-body="${i}" hidden>
          ${f.lines
            .map(
              ([kind, no, text]) => `<div class="ln ${kind === 'ctx' ? '' : kind}"><span class="no">${no}</span><span>${esc(text)}</span></div>`,
            )
            .join('')}
        </div>`,
      )
      .join('')}
  </div>`;
}

/* ── Scripted turns ────────────────────────────────────────────────────────── */

async function waitUnlessAborted(thread, ms) {
  await sleep(ms);
  return !session(thread).aborted;
}

async function ask(thread, node) {
  appendTurn(thread, node);
  setStatus(thread, 'Waiting on you');
  const result = await waitFor(node);
  if (session(thread).aborted) return null;
  setStatus(thread, 'Thinking');
  return result;
}

async function demoScript(thread, text) {
  const s = session(thread);

  if (s.step === 0) {
    setStatus(thread, 'Thinking');
    if (!(await waitUnlessAborted(thread, 650))) return;
    appendTurn(
      thread,
      agentTurn(
        `Hi. The row marks are open: <code>thread-state-marks.ts</code> and <code>ThreadRow.svelte</code>. Two things are still undecided before I touch the rail.`,
      ),
    );
    const q = buildQuestion({
      title: 'Should the phone carry every desktop state, or only the ones you would act on?',
      note: 'Needs an answer',
      options: [
        { label: 'Only the five I act on', desc: 'Attention, working, unread, failed, settled' },
        { label: 'Every desktop state', desc: 'Faithful to the rail, six marks on a 390px row' },
        { label: 'Marks plus a text label', desc: 'Wider rows, nothing ambiguous at arm’s length' },
      ],
    });
    const answer = await ask(thread, q);
    if (!answer) return;
    const chosen = answer.querySelector('.decision span')?.textContent ?? 'Answered';
    appendTurn(
      thread,
      agentTurn(
        `Taking <strong>${esc(chosen.replace(/^Answered: /, '').toLowerCase())}</strong>. One mark per row, same meanings as the desktop rail. I need to regenerate the budget snapshot before I touch the renderer.`,
      ),
    );
    s.step = 1;
  }

  if (s.step === 1) {
    setStatus(thread, 'Waiting on permission');
    const perm = buildPermission({
      cmd: 'bun run scripts/check-bundle-budgets.ts --write',
      why: 'Writes the budget snapshot after the renderer changes. Without it the pre-commit check fails.',
      scope: 'Full access · writes a checked-in file',
      note: 'Shell command',
      seconds: 95,
    });
    const decided = await ask(thread, perm);
    if (!decided) return;
    const value = decided.dataset.decision;
    if (value === 'reject' || value === 'timeout') {
      appendTurn(
        thread,
        agentTurn('Understood. I will keep the shipped budget and work inside it instead, no write needed.'),
      );
    } else {
      appendTurn(
        thread,
        agentTurn(
          value === 'always'
            ? 'Allowed for this project. Snapshot written.'
            : 'Allowed once. Snapshot written.',
          { tools: '' },
        ),
      );
    }
    const t1 = toolLine('check-bundle-budgets.ts', '3 budgets kept');
    const t2 = toolLine('bun test src/renderer/lib/components/threads', '41 passed');
    appendTurn(thread, el(`<div class="turn agent"><p class="who">Agent</p>${t1.outerHTML}${t2.outerHTML}</div>`));
    s.step = 2;
    if (!(await waitUnlessAborted(thread, 500))) return;
    appendTurn(
      thread,
      agentTurn('Checks pass. Pushing this to the deploy preview needs a key I do not hold.'),
    );
    setStatus(thread, 'Waiting on a secret');
    const secret = buildSecret({
      title: 'Convex deploy key',
      why: 'The preview deploy needs a deploy key for this project. The value goes to your vault; the agent only hears that it was stored.',
    });
    const stored = await ask(thread, secret);
    if (!stored) return;
    if (stored.dataset.decision === 'cancel') return;
    s.step = 3;
    appendTurn(thread, agentTurn('Stored. Starting the run: spec is approved, three workers, five stages.'));
  }

  if (s.step === 3) {
    setStatus(thread, 'Auto Pilot · implementing');
    const run = buildRun();
    appendTurn(thread, run);
    await new Promise((resolve) => animateRun(run, resolve));
    if (session(thread).aborted) return;
    run.querySelector('.card-foot')?.remove();
    run.append(el(diffMarkup()));
    run.append(el(runFoot()));
    session(thread).statusIdle = 'Run finished · 3 files changed';
    setStatus(thread, 'Run finished');
    s.step = 4;
    return;
  }

  if (s.step >= 4) {
    const generic = await genericReply(thread, text);
    return generic;
  }
}

async function genericReply(thread, text) {
  const s = session(thread);
  setStatus(thread, 'Thinking');
  if (!(await waitUnlessAborted(thread, 700))) return;
  const lines = [
    `Read that as a follow-up on <strong>${esc(thread.title.toLowerCase())}</strong>. The diff is unchanged; I can keep going on the same branch.`,
    `Noted. I would fold that into the next stage rather than reopening the spec, unless you want the spec amended first.`,
    `Fine. Nothing else is waiting on you in this thread, so I will continue and report the diff when the turn closes.`,
  ];
  appendTurn(thread, agentTurn(lines[s.step % lines.length]));
  s.step += 1;
  if (s.step % 3 === 0) {
    setStatus(thread, 'Waiting on permission');
    const node = buildPermission({
      cmd: 'bun run scripts/check-bundle-budgets.ts',
      why: 'Verifies the renderer still fits its budget before committing.',
      scope: 'Full access · read only check',
      seconds: 60,
    });
    const decided = await ask(thread, node);
    if (decided) {
      appendTurn(
        thread,
        agentTurn(
          decided.dataset.decision === 'reject' || decided.dataset.decision === 'timeout'
            ? 'Skipped the check. Committing what already passed.'
            : 'Check passed. Committed.',
        ),
      );
    }
  }
  session(thread).statusIdle = 'Ready';
  setStatus(thread, 'Ready');
}

async function runTurn(thread, text) {
  setBusy(thread, true);
  session(thread).aborted = false;
  session(thread).stopped = false;
  appendTurn(thread, userTurn(text));
  paintSend();
  try {
    if (thread.scripted) await demoScript(thread, text);
    else await genericReply(thread, text);
  } finally {
    if (session(thread).aborted) {
      session(thread).stopped = true;
      appendTurn(thread, agentTurn('Stopped. Nothing was written after that point.', { stopped: true }));
    }
    setBusy(thread, false);
    session(thread).statusIdle = session(thread).statusIdle ?? 'Ready';
    paintStatus(thread);
    const queue = state.queue.get(thread.id) ?? [];
    if (queue.length) {
      const next = queue.shift();
      state.queue.set(thread.id, queue);
      paintQueue(queue);
      setTimeout(() => runTurn(thread, next), 350);
    }
  }
}

function stopTurn(thread) {
  const s = session(thread);
  s.aborted = true;
  for (const card of [...state.pendingCards]) {
    if (card.closest('.transcript') && card.dataset.decided !== 'true') {
      settleCard(card, 'Cancelled, the turn was stopped', 'no');
    }
  }
  paintSend();
}

/* ── Views ─────────────────────────────────────────────────────────────────── */

function paintDock() {
  const pending = state.pendingCards.size;
  const badge = dock.querySelector('.tab[data-tab="threads"] .badge');
  if (pending > 0) {
    if (badge) badge.textContent = String(pending);
    else dock.querySelector('.tab[data-tab="threads"]').append(el(`<span class="badge">${pending}</span>`));
  } else {
    badge?.remove();
  }
}

function renderInbox() {
  state.view = 'inbox';
  state.threadId = null;
  composer.hidden = true;
  dock.hidden = false;
  appbar.innerHTML = `
    ${brandMark}
    <div class="appbar-title"><h1>Threads</h1></div>
    <span class="spacer"></span>
    <button class="icon-btn" type="button" data-action="inbox-search" title="Search threads" aria-label="Search threads">${icons.search}</button>
    <button class="icon-btn" type="button" data-action="inbox-group" title="Group threads by state" aria-label="Group threads by state">${icons.group}</button>
    <button class="icon-btn" type="button" data-action="sheet-usage" title="Usage and models" aria-label="Usage and models">${icons.battery}</button>`;

  const groups = [
    { key: 'needs', label: 'Needs you' },
    { key: 'working', label: 'Working' },
    { key: 'recent', label: 'Recent' },
  ];
  const body = groups
    .map((g) => {
      const list = threads.filter((t) => t.group === g.key);
      if (!list.length) return '';
      return `<p class="section-label">${g.label}<span class="count">${list.length}</span></p>
        <div role="list">
        ${list
          .map(
            (t) => `<button class="row ${t.unread ? 'is-unread' : ''}" type="button" role="listitem" data-action="open-thread" data-thread="${t.id}">
            <span class="mark-dot" data-state="${t.state}" aria-hidden="true"></span>
            <span class="row-main">
              <span class="row-title">${esc(t.title)}</span>
              <span class="row-meta">${esc(t.meta)}</span>
            </span>
            <span class="row-side">
              <span class="row-time">${t.time}</span>
              <span class="chip"><b>${esc(t.project)}</b></span>
            </span>
          </button>`,
          )
          .join('')}
        </div>`;
    })
    .join('');

  view.innerHTML = body;
  view.scrollTop = 0;
  requestAnimationFrame(() => appbar.querySelector('h1')?.setAttribute('tabindex', '-1'));
}

function renderProjectTabs() {
  const titles = { projects: 'Projects', chats: 'Chats', assistant: 'Assistant' };
  appbar.innerHTML = `
    <div class="appbar-title"><h1>${titles[state.tab]}</h1></div>
    <span class="spacer"></span>
    <button class="icon-btn" type="button" data-action="sheet-usage" title="Usage and models" aria-label="Usage and models">${icons.battery}</button>`;
  if (state.tab === 'projects') {
    view.innerHTML = `
      <p class="section-label">On this machine<span class="count">2</span></p>
      ${[
        ['CO', 'codeinoven', '5 threads · 2 running', 'main'],
        ['PD', 'pillardash', '2 threads · 1 running', 'main'],
      ]
        .map(
          ([glyph, name, meta, branch]) => `<button class="project-row" type="button" data-action="toast" data-message="Only thread switching is mocked here">
            <span class="glyph">${glyph}</span>
            <span><span class="nm">${name}</span><span class="ds">${meta}</span></span>
            <span class="ct">${branch}</span>
          </button>`,
        )
        .join('')}
      <div class="empty">
        ${icons.folder}
        <b>Projects live on the desktop</b>
        <p>The phone reads their threads and runs new ones; it never holds a checkout of its own.</p>
      </div>`;
  } else {
    view.innerHTML = `<div class="empty">
      ${state.tab === 'chats' ? icons.chat : icons.assistant}
      <b>Nothing here yet</b>
      <p>${state.tab === 'chats' ? 'Temporary chats stay on the desktop. Side chats opened from a thread appear here.' : 'Scheduled tasks and heartbeats run on the machine you left at home.'}</p>
    </div>`;
  }
}

function historyFor(thread) {
  if (thread.id === 'row-marks' && !session(thread).nodes.length) {
    session(thread).statusIdle = 'Ready';
    return [
      userTurn('The thread rows are unreadable at arm’s length. A failed run and a finished one look identical.'),
      agentTurn(
        'Both states were the same grey. Each row now carries one mark in the rail’s own vocabulary: a live bar for a running turn, a triangle for anything waiting on you, a grey square for settled work.',
        { tools: '' },
      ),
      (() => {
        const n = el(`<div class="turn agent"><p class="who">Agent</p></div>`);
        n.append(toolLine('thread-state-marks.ts', '<span class="add">+18</span> <span class="del">−9</span>'));
        n.append(toolLine('ThreadRow.svelte', '<span class="add">+34</span> <span class="del">−21</span>'));
        return n;
      })(),
      (() => {
        const card = buildPermission({
          cmd: 'bun test src/main/db',
          why: 'Ran the storage checks before touching the rail.',
          scope: 'Full access · read only check',
          seconds: 600,
        });
        settleCard(card, 'Allowed once, 4m ago');
        return card;
      })(),
    ];
  }
  if (thread.id === 'terminal-resize' && !session(thread).nodes.length) {
    return [
      userTurn('The terminal drifts a few columns every time the window is resized.'),
      agentTurn('I can reproduce it: the pty size is written before the renderer measures the fitted cell width, so the last resize of a burst wins.'),
      buildPermission({
        cmd: 'bun run scripts/probe-terminal.ts --cols 132',
        why: 'Spawns a pty outside the project to reproduce the drift deterministically.',
        scope: 'Full access · read only, spawns a child process',
        note: 'Needs your answer',
        seconds: 120,
      }),
    ];
  }
  if (thread.id === 'sidebar' && !session(thread).nodes.length) {
    session(thread).statusIdle = 'Assignment · task 3 of 7';
    return [
      userTurn('Tighten the sidebar rows. They read like a spreadsheet.'),
      agentTurn('Task 3 of 7 is in progress: row padding is on a 4px rhythm and the status mark owns its own 14px column.'),
      (() => {
        const n = el(`<div class="turn agent"><p class="who">Agent</p></div>`);
        n.append(toolLine('SidebarRow.svelte', '<span class="add">+9</span> <span class="del">−14</span>'));
        n.append(toolLine('sidebar.svelte.ts', 'unchanged'));
        return n;
      })(),
    ];
  }
  if (thread.id === 'sqlite' && !session(thread).nodes.length) {
    return [
      userTurn('The app hangs on restart when a second window was open.'),
      agentTurn('Two connections held a write lock across the window teardown. The second connection now closes before the first flushes, and the lock waits with a bounded timeout instead of blocking.'),
      (() => {
        const n = el(`<div class="turn agent"><p class="who">Agent</p></div>`);
        n.append(toolLine('db/lock.ts', '<span class="add">+41</span> <span class="del">−12</span>'));
        n.append(toolLine('git commit', 'fixed: close the second connection first'));
        return n;
      })(),
    ];
  }
  if (!session(thread).nodes.length) {
    return [
      agentTurn(
        thread.id === 'changelog'
          ? 'The changelog entry shipped as “Deep links open the right project on the first try”. Nothing else is pending in this thread.'
          : 'Draft only: nothing has been sent in this thread yet. Write below and I will start from the current branch.',
      ),
    ];
  }
  return [];
}

function renderConversation(thread) {
  state.view = 'conversation';
  state.threadId = thread.id;
  composer.hidden = false;
  dock.hidden = true;

  appbar.innerHTML = `
    <button class="icon-btn" type="button" data-action="home" title="Back to threads" aria-label="Back to threads">${icons.back}</button>
    <div class="appbar-title">
      <h1>${esc(thread.title)}</h1>
      <p class="crumb">${esc(thread.project)} / ${esc(thread.branch)}</p>
    </div>
    <span class="spacer"></span>
    <button class="icon-btn" type="button" data-action="sheet-usage" title="Usage and models" aria-label="Usage and models">${icons.battery}</button>
    <button class="icon-btn" type="button" data-action="thread-menu" title="Thread actions" aria-label="Thread actions">${icons.more}</button>`;

  view.innerHTML = `
    <div class="thread-head">
      <h2>${esc(thread.title)}</h2>
      <div class="meta">
        <span>Auto Pilot</span><span class="dot"></span>
        <span>${esc(thread.project)}</span><span class="dot"></span>
        <span>${esc(modelNames[state.model] ?? state.model)}</span>
      </div>
      <div class="status-line" data-state="idle" aria-live="polite">
        <span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="status-text">Ready</span>
      </div>
    </div>
    <div class="transcript" role="log" aria-live="polite" aria-label="Conversation"></div>`;

  const scene = transcript();
  const s = session(thread);
  const stored = s.nodes.length ? [] : historyFor(thread);
  s.initialised = true;
  for (const node of [...stored, ...s.nodes]) scene.append(node);
  s.nodes = [...scene.children];
  paintStatus(thread);
  paintSettings();
  paintSend();
  paintQueue(state.queue.get(thread.id) ?? []);
  requestAnimationFrame(() => {
    view.scrollTop = view.scrollHeight;
  });
}

/* ── Sheets ────────────────────────────────────────────────────────────────── */

function openSheet(name) {
  state.sheet = name;
  const usage = name === 'usage';
  sheet.innerHTML = usage
    ? `<div class="sheet-head">
        <button class="icon-btn" type="button" data-action="close-sheet" title="Close usage" aria-label="Close usage">${icons.close}</button>
        <h2>Usage</h2>
        <span class="spacer"></span>
        <span class="chip">7d</span>
      </div>
      <div class="sheet-body">
        <div class="stats">
          <div class="stat"><span class="k">Spend today</span><span class="v">$4.18</span><span class="d">$18.40 this week</span></div>
          <div class="stat"><span class="k">Context</span><span class="v">62%</span><span class="d">124k of 200k</span></div>
          <div class="stat"><span class="k">Tokens in</span><span class="v">1.24M</span><span class="d good">92% cache hit</span></div>
          <div class="stat"><span class="k">Tokens out</span><span class="v">186k</span><span class="d">48 tok/s median</span></div>
        </div>
        <p class="field-label">Daily spend</p>
        <div class="chart" role="img" aria-label="Daily spend, highest today at 4 dollars 18 cents">
          ${[42, 68, 24, 100, 55, 12, 88]
            .map(
              (h, i) =>
                `<div class="bar" ${i === 6 ? 'data-today="true"' : ''}><i style="height: ${h}%"></i><span>${['M', 'T', 'W', 'T', 'F', 'S', 'S'][i]}</span></div>`,
            )
            .join('')}
        </div>
        <p class="field-label">Quota</p>
        <div class="quota">
          <div class="meter">
            <div class="track"><i style="width: 74%"></i></div>
            <div class="track-label"><span>Claude, weekly</span><span>74% · resets 2d 6h</span></div>
          </div>
          <div class="meter">
            <div class="track"><i class="hot" style="width: 91%"></i></div>
            <div class="track-label"><span>Codex, 5 hour</span><span>91% · resets 41m</span></div>
          </div>
        </div>
        <p class="field-label">Next turn runs on</p>
        <div class="model-list" role="radiogroup" aria-label="Model for the next turn">
          ${[
            ['claude-opus-4.6', 'Anthropic, thinking high · $15 / $75 per Mtok'],
            ['gpt-5.2-codex', 'OpenAI, thinking medium · $1.25 / $10 per Mtok'],
            ['deepseek-v4', 'DeepSeek, thinking off · $0.28 / $0.42 per Mtok'],
          ]
            .map(
              ([id, desc]) => `<button class="model" type="button" role="radio" aria-checked="${state.model === id}" data-action="model" data-model="${id}">
                <span><span class="nm">${id}</span><span class="ds">${desc}</span></span>
                ${icons.check}
              </button>`,
            )
            .join('')}
        </div>
        <div class="pad">
          <button class="switch-row" type="button" aria-pressed="true" data-action="noop">
            <span><span class="nm">Show cost per thread</span><span class="ds">Adds a spend column to the inbox</span></span>
            <span class="switch" aria-hidden="true"><i></i></span>
          </button>
          <div class="sheet-note">
            <span class="k">Reported, not estimated</span>
            <p>Two turns on this thread reported no cost, so today’s total is a floor rather than a sum.</p>
          </div>
        </div>
      </div>`
    : `<div class="sheet-head">
        <button class="icon-btn" type="button" data-action="close-sheet" title="Close" aria-label="Close">${icons.close}</button>
        <h2>Run settings</h2>
      </div>
      <div class="sheet-body">
        <p class="field-label">Engineering stage</p>
        <div class="stage-chips" role="group" aria-label="Engineering stage">
          ${[
            ['brainstorm', 'Brain'],
            ['prd', 'PRD'],
            ['spec', 'Spec'],
            ['assignment', 'Assign'],
            ['achievement', 'Achieve'],
          ]
            .map(
              ([id, label]) =>
                `<button type="button" data-action="stage" data-stage="${id}" aria-pressed="${state.stage === id}">${label}</button>`,
            )
            .join('')}
        </div>
        <div class="pad">
          <button class="switch-row" type="button" aria-pressed="${state.autoPilot}" data-action="auto-pilot">
            <span><span class="nm">Auto Pilot</span><span class="ds">Brainstorm through Achievement, reworked until complete</span></span>
            <span class="switch" aria-hidden="true"><i></i></span>
          </button>
          <div class="sheet-note">
            <span class="k">Stage cascade</span>
            <p>Assignment and Achievement include the spec step. Auto Pilot runs all five.</p>
          </div>
          <button class="btn primary" type="button" data-action="close-sheet">Done</button>
        </div>
      </div>`;
  sheet.dataset.open = 'true';
  scrim.dataset.open = 'true';
}

function closeSheet() {
  state.sheet = null;
  sheet.dataset.open = 'false';
  scrim.dataset.open = 'false';
}

/* ── Events ────────────────────────────────────────────────────────────────── */

function setChoice(card, index) {
  const choices = [...card.querySelectorAll('.choice')];
  choices.forEach((c, i) => c.setAttribute('aria-checked', String(i === index)));
  card.dataset.selected = String(index);
}

function resolveQuestion(card) {
  if (card.dataset.decided === 'true') return;
  const buttons = [...card.querySelectorAll('.choice')];
  const index = Number(card.dataset.selected ?? 0);
  const label = buttons[index]?.querySelector('b')?.textContent ?? 'Skipped';
  settleCard(card, `Answered: ${label}`);
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const card = target.closest('.card');

  switch (action) {
    case 'open-thread': {
      const thread = threadById(target.dataset.thread);
      if (!thread) return;
      thread.unread = false;
      renderConversation(thread);
      return;
    }
    case 'home':
      renderInbox();
      return;
    case 'pick': {
      if (!card || card.dataset.decided === 'true') return;
      setChoice(card, Number(target.dataset.index));
      return;
    }
    case 'submit': {
      if (!card) return;
      resolveQuestion(card);
      return;
    }
    case 'skip': {
      if (!card) return;
      settleCard(card, 'Skipped the question', 'no');
      return;
    }
    case 'decide': {
      if (!card || card.dataset.decided === 'true') return;
      const labels = {
        once: 'Allowed once',
        always: 'Allowed always',
        reject: 'Rejected',
        cancel: 'Cancelled',
      };
      card.dataset.decision = target.dataset.value;
      settleCard(card, labels[target.dataset.value] ?? 'Decided', target.dataset.value === 'reject' || target.dataset.value === 'cancel' ? 'no' : 'yes');
      return;
    }
    case 'submit-secret': {
      if (!card || card.dataset.decided === 'true') return;
      const value = card.querySelector('input')?.value ?? '';
      if (!value.trim()) return;
      card.querySelector('input').value = '••••••••••••••••';
      settleCard(card, 'Stored in the vault');
      return;
    }
    case 'reveal': {
      const input = card?.querySelector('input');
      if (!input) return;
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      target.innerHTML = shown ? icons.eye : icons.eyeOff;
      target.title = shown ? 'Show the value' : 'Hide the value';
      target.setAttribute('aria-label', target.title);
      input.focus();
      return;
    }
    case 'fold': {
      if (!card) return;
      card.dataset.folded = card.dataset.folded === 'true' ? 'false' : 'true';
      return;
    }
    case 'diff': {
      const index = target.dataset.index;
      const body = card?.querySelector(`.diff-body[data-body="${index}"]`);
      if (!body) return;
      const open = body.hidden;
      body.hidden = !open;
      target.setAttribute('aria-expanded', String(open));
      return;
    }
    case 'retry':
      toast('Stage retried, waiting on the bundle budget');
      return;
    case 'commit': {
      toast('Committed 3 files to row-marks');
      const foot = target.closest('.card-foot');
      if (foot) {
        foot.remove();
        card?.append(el(`<div class="decision">${icons.check}<span>Committed 3 files, +173 −71</span></div>`));
      }
      return;
    }
    case 'sheet-usage':
      openSheet('usage');
      return;
    case 'sheet-run':
      openSheet('run');
      return;
    case 'close-sheet':
      closeSheet();
      return;
    case 'model': {
      state.model = target.dataset.model;
      sheet.querySelectorAll('.model').forEach((m) => m.setAttribute('aria-checked', String(m.dataset.model === state.model)));
      paintSettings();
      const active = activeThread();
      if (active) {
        renderConversation(active);
        paintSettings();
      }
      toast(`Next turn runs on ${state.model}`);
      return;
    }
    case 'stage': {
      state.stage = target.dataset.stage;
      state.autoPilot = false;
      sheet.querySelectorAll('[data-stage]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.stage === state.stage)));
      sheet.querySelector('[data-action="auto-pilot"]')?.setAttribute('aria-pressed', 'false');
      paintSettings();
      return;
    }
    case 'auto-pilot': {
      state.autoPilot = !state.autoPilot;
      target.setAttribute('aria-pressed', String(state.autoPilot));
      paintSettings();
      return;
    }
    case 'clear-queue': {
      const thread = activeThread();
      if (!thread) return;
      state.queue.set(thread.id, []);
      paintQueue([]);
      paintSend();
      return;
    }
    case 'perm':
      toast('Full access · switching it is a desktop action');
      return;
    case 'toast':
      toast(target.dataset.message ?? 'Not part of this demo');
      return;
    case 'inbox-search':
      toast('Search is a desktop action; this demo follows one thread');
      return;
    case 'inbox-group':
      toast('Grouping by state is what the inbox already shows here');
      return;
    case 'thread-menu':
      toast('Thread actions are on the desktop');
      return;
    default:
      return;
  }
});

scrim.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sheet) closeSheet();
});

// Arrow keys move inside a question's radio group.
document.addEventListener('keydown', (e) => {
  const choice = e.target.closest?.('.choice');
  if (!choice) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const card = choice.closest('.card');
  const choices = [...card.querySelectorAll('.choice')];
  const index = Number(choice.dataset.index);
  const next = e.key === 'ArrowDown' ? (index + 1) % choices.length : (index - 1 + choices.length) % choices.length;
  setChoice(card, next);
  choices[next].focus();
});

field.addEventListener('input', () => {
  field.style.height = 'auto';
  field.style.height = `${Math.min(field.scrollHeight, 128)}px`;
  paintSend();
});

field.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitMessage();
  }
});

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  submitMessage();
});

function submitMessage() {
  const thread = activeThread();
  if (!thread) return;
  const text = field.value.trim();
  if (!text) {
    if (isBusy(thread)) {
      if (!state.stopArmed) {
        state.stopArmed = true;
        paintSend();
        setTimeout(() => {
          state.stopArmed = false;
          paintSend();
        }, 2600);
      } else {
        state.stopArmed = false;
        stopTurn(thread);
        paintSend();
      }
    }
    return;
  }
  field.value = '';
  field.style.height = 'auto';
  if (isBusy(thread)) {
    const queue = state.queue.get(thread.id) ?? [];
    queue.push(text);
    state.queue.set(thread.id, queue);
    paintQueue(queue);
    paintSend();
    return;
  }
  paintSend();
  runTurn(thread, text);
}

/* Dock */
dock.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const name = tab.dataset.tab;
  state.tab = name;
  dock.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
  if (name === 'threads') renderInbox();
  else renderProjectTabs();
});

/* Notes panel shortcuts: the buttons and their own keys do the same thing. */
function runDemo(demo) {
  if (demo === 'send-hi') {
    const thread = threadById('row-marks');
    renderConversation(thread);
    field.value = 'hi';
    paintSend();
    field.focus();
    return;
  }
  if (demo === 'usage') {
    openSheet('usage');
    return;
  }
  if (demo === 'reset') {
    state.sessions.clear();
    state.busy.clear();
    state.queue.clear();
    for (const card of state.pendingCards) clearInterval(card._timer);
    state.pendingCards.clear();
    state.model = 'claude-opus-4.6';
    state.stage = 'spec';
    state.autoPilot = true;
    threads.forEach((t) => {
      t.unread = ['row-marks', 'sqlite'].includes(t.id);
    });
    paintSettings();
    renderInbox();
    paintDockBadge();
    toast('Demo reset');
  }
}

document.querySelectorAll('[data-demo]').forEach((button) => {
  button.addEventListener('click', () => runDemo(button.dataset.demo));
});

document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, [contenteditable]')) return;
  if (state.sheet) return;
  const key = event.key.toLowerCase();
  if (key === '1') runDemo('send-hi');
  else if (key === '2') runDemo('usage');
  else if (key === 'r') runDemo('reset');
});

function paintDockBadge() {
  paintDock();
}

/* Boot */
dock.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === 'threads')));
paintSettings();
paintDockBadge();
renderInbox();
