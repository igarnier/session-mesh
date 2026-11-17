// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// session-mesh showcase site: the app shell as navigation.
// Loaded in <head> without defer so the "js" class is set before the first
// paint; everything else waits for DOMContentLoaded. Without this file the
// page stays a long-form document.
"use strict";
document.documentElement.classList.add("js");

// Every session of the page, in sidebar order. ORDER keeps those the status
// table does not hide (the "projects" session waits for its feature).
const ALL_SESSIONS = ["welcome", "see", "collaborate", "structure", "projects", "security", "roadmap", "install"];
let ORDER = ALL_SESSIONS;
const AGENT_SESSIONS = new Set(["see", "collaborate", "structure", "roadmap"]);
// Former section names: "#frame" still opens "structure", under its new hash.
const ALIASES = { frame: "structure" };
const NUDGE_DELAY_MS = 7000;
const TYPE_MS = 16;
const PHONE = "(max-width: 700px)";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const isPhone = () => matchMedia(PHONE).matches;

const view = {
  current: null,
  lastLive: "welcome",
  tab: "live",
  histSlug: null,
  visited: new Set(),
  waiting: null,
  docOpen: true,
  variant: "",
  typing: null,
  idleTimer: 0,
  nudgedThisIdle: false,
};

// ---------------------------------------------------------------- selection

function sectionTitle(id) {
  const heading = $(`#${id} h1, #${id} h2`);
  return heading ? heading.textContent.replace(/^#\s*/, "").trim() : id;
}

// Routes: "#<session>" for a Live session, "#history" for the whole
// changelog and "#history/<slug>" for one of its entries.
function parseRoute(hash) {
  let route = hash.replace(/^#/, "");
  try { route = decodeURIComponent(route); } catch { route = ""; }
  if (route === "history" || route.startsWith("history/")) {
    const slug = route.slice("history/".length) || null;
    return { tab: "hist", slug: slug && document.getElementById(`history/${slug}`) ? slug : null };
  }
  if (ALIASES[route]) return { tab: "live", id: ALIASES[route], replace: true };
  // An anchor inside a section ("#status") opens that section at the anchor.
  const target = !ORDER.includes(route) && route && document.getElementById(route);
  const section = target && target.closest(".sess:not(.hist-sess)");
  if (section) return { tab: "live", id: section.id, anchor: route };
  return { tab: "live", id: route };
}

function go(hash, { push = true } = {}) {
  const route = parseRoute(hash);
  if (route.tab === "hist") { openHistory(route.slug, { push }); return; }
  if (route.replace) {
    try { history.replaceState(null, "", `#${route.id}`); } catch { /* file:// in some browsers */ }
  }
  select(route.id, { push: push && !route.replace, anchor: route.anchor });
}

function markCurrent(listSelector, attr, value) {
  $$(`${listSelector} .items .item`).forEach((item) => {
    if (item.dataset[attr] !== value) { item.removeAttribute("aria-current"); return; }
    item.setAttribute("aria-current", "page");
    // The overview (no value) keeps the list at its top, where its intro is.
    if (item.offsetParent && value) item.scrollIntoView({ block: "nearest" });
  });
}

function showSession(id, hash, push, anchor) {
  const changed = view.current !== id;
  view.current = id;
  if (changed) view.variant = "";
  $$(".sess").forEach((sec) => sec.classList.toggle("cur", sec.id === id));
  $$(".mode").forEach((mode) => {
    const on = (mode.dataset.go === "projects") === (id === "projects");
    mode.classList.toggle("cur", on);
    if (on) mode.setAttribute("aria-current", "true"); else mode.removeAttribute("aria-current");
  });
  updatePaneHeads(id);
  if (push && location.hash !== `#${hash}`) {
    try { history.pushState(null, "", `#${hash}`); } catch { /* file:// in some browsers */ }
  }
  if (changed) {
    // The welcome session opens on the full width; its screenshots stay one click away.
    const hasPanel = Boolean($(`#doc .visual[data-for="${id}"]`));
    document.body.classList.toggle("no-panel", !hasPanel);
    setDoc(hasPanel && (id !== "welcome" || isPhone()));
    typeCommand(id);
    if (id === "collaborate") mockPlay(); else mockStop();
    document.dispatchEvent(new CustomEvent("mesh-site:session", { detail: id }));
  }
  // A hash change also scrolls the reader to the element with that id: undo
  // it after the browser has done so, so a session always opens at its top.
  // An anchor ("#status") is scrolled into view instead.
  // An anchor inside a closed <details> opens it first.
  const target = anchor && document.getElementById(anchor);
  const fold = target && target.closest("details");
  if (fold) fold.open = true;
  const scroll = () => {
    if (target) target.scrollIntoView({ block: "start" });
    else $("#content").scrollTop = 0;
  };
  scroll();
  requestAnimationFrame(scroll);
  showPane("main");
  closeDrawer();
  renderStates();
}

function select(id, { push = true, anchor = null } = {}) {
  if (!ORDER.includes(id)) { id = "welcome"; anchor = null; }
  view.visited.add(id);
  view.lastLive = id;
  if (view.waiting === id) view.waiting = null;
  setTab("live");
  markCurrent("#list", "session", id);
  showSession(id, anchor || id, push, anchor);
}

function openHistory(slug, { push = true } = {}) {
  view.histSlug = slug;
  setTab("hist");
  markCurrent("#hlist", "hist", slug || "");
  const section = $("#history");
  section.classList.toggle("single", Boolean(slug));
  $$(".hentry", section).forEach((entry) => entry.classList.toggle("cur", entry.dataset.slug === slug));
  $$(".doc-toc a").forEach((link) => {
    if (slug && link.getAttribute("href") === `#history/${slug}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  showSession("history", slug ? `history/${slug}` : "history", push);
  $("#pane-name").textContent = slug ? `history · ${slug}` : "history";
}

// ---------------------------------------------------------------- Live / History tabs

function setTab(which) {
  if (view.tab === which) return;
  view.tab = which;
  const live = which === "live";
  [["#tab-live", live], ["#tab-hist", !live]].forEach(([sel, on]) => {
    const tab = $(sel);
    tab.classList.toggle("cur", on);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  $("#list").hidden = !live;
  $("#hlist").hidden = live;
  // History lists releases, few enough to need no filter.
  $("#filter").hidden = !live;
  applyFilter();
}

// Switching tabs keeps the phone drawer open, so the new list stays in view.
function activateTab(which) {
  const drawerOpen = document.body.classList.contains("drawer");
  if (which === "live") select(view.lastLive);
  else openHistory(view.histSlug);
  if (drawerOpen) toggleDrawer();
}

function onTabKey(event) {
  const keys = { ArrowLeft: "live", ArrowRight: "hist", Home: "live", End: "hist" };
  const which = keys[event.key];
  if (!which) return;
  event.preventDefault();
  activateTab(which);
  $(which === "live" ? "#tab-live" : "#tab-hist").focus();
}

function bindTabs() {
  $("#list").setAttribute("role", "tabpanel");
  $("#list").setAttribute("aria-labelledby", "tab-live");
  $("#hlist").setAttribute("role", "tabpanel");
  $("#hlist").setAttribute("aria-labelledby", "tab-hist");
  $("#tab-live").addEventListener("click", () => activateTab("live"));
  $("#tab-hist").addEventListener("click", () => activateTab("hist"));
  $$(".tabs [role=tab]").forEach((tab) => tab.addEventListener("keydown", onTabKey));
}

// ---------------------------------------------------------------- pane heads

function updatePaneHeads(id) {
  const sec = $(`#${id}`);
  const visual = $$(`#doc .visual[data-for="${id}"]`).find(isShownVariant);
  const docTitle = visual ? visual.dataset.title : "document";
  const docLabel = /^(replay|whiteboard)/.test(docTitle) ? docTitle : `document · ${docTitle}`;
  $("#pane-name").textContent = id;
  $("#pane-cmd").textContent = sec.dataset.agent;
  $("#pane-agent").dataset.state = sec.dataset.state;
  $("#pane-agent").title = sec.dataset.state;
  $("#doc-name").textContent = docTitle;
  $$('[data-pane="main"]').forEach((el) => { el.textContent = `terminal · ${id}`; });
  $$('[data-pane="doc"]').forEach((el) => { el.textContent = docLabel; });
  document.title = titleWithCount();
}

function titleWithCount() {
  const base = "session-mesh: run and follow your coding agents";
  return view.waiting ? `(1) ${base}` : base;
}

// ---------------------------------------------------------------- typed command line

function typeCommand(id) {
  finishTyping();
  const line = $(`#${id} .cmdline`);
  const cmd = line && $(".cmd", line);
  $$("#doc .visual").forEach((v) => v.classList.remove("cur"));
  if (!cmd) return showVisual(id);
  const text = cmd.dataset.cmd;
  if (reduceMotion()) { cmd.textContent = text; return showVisual(id); }
  line.classList.add("pending");
  cmd.classList.add("typing");
  cmd.textContent = "";
  let index = 0;
  const timer = setInterval(() => {
    index += 1;
    cmd.textContent = text.slice(0, index);
    if (index >= text.length) finishTyping();
  }, TYPE_MS);
  view.typing = { id, line, cmd, text, timer };
}

function finishTyping() {
  const typing = view.typing;
  if (!typing) return;
  clearInterval(typing.timer);
  typing.cmd.textContent = typing.text;
  typing.cmd.classList.remove("typing");
  typing.line.classList.remove("pending");
  view.typing = null;
  showVisual(typing.id);
}

// A section can hold a second panel (data-variant), shown in place of its first one.
function isShownVariant(visual) {
  return (visual.dataset.variant || "") === view.variant;
}

function showVisual(id) {
  $$("#doc .visual").forEach((v) => v.classList.toggle("cur", v.dataset.for === id && isShownVariant(v)));
  document.dispatchEvent(new CustomEvent("mesh-site:panel", { detail: { id, variant: view.variant } }));
}

function openVariant(variant) {
  finishTyping();
  view.variant = variant;
  showVisual(view.current);
  updatePaneHeads(view.current);
  if (view.current === "collaborate" && !variant) mockPlay(); else mockStop();
  showPane("doc");
}

// ---------------------------------------------------------------- panes and panel

function setDoc(open) {
  view.docOpen = open;
  document.body.classList.toggle("doc-closed", !open);
  $("#btn-panel").setAttribute("aria-pressed", String(open));
  if (!open) showPane("main");
}

function showPane(which) {
  if (which === "doc" && !view.docOpen) setDoc(true);
  $("#col-main").classList.toggle("group-active", which === "main");
  $("#col-doc").classList.toggle("group-active", which === "doc");
  $$('.workspace-tab[data-pane]').forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.pane === which)));
  $$("#sheet-panes [data-pane]").forEach((btn) => btn.setAttribute("aria-current", String(btn.dataset.pane === which)));
}

function closeDrawer() {
  document.body.classList.remove("drawer");
  $("#btn-menu").setAttribute("aria-expanded", "false");
}

function toggleDrawer() {
  const open = !document.body.classList.contains("drawer");
  document.body.classList.toggle("drawer", open);
  $("#btn-menu").setAttribute("aria-expanded", String(open));
}

// On a phone, as in session-mesh: a swipe right from the left edge opens the sessions,
// a swipe left on the open drawer closes it. Only a deliberate horizontal move counts.
function bindSwipe() {
  // Touch events, not pointer events: a browser that starts scrolling cancels the pointer.
  let gesture = null;
  const excluded = (target) => target.closest("input,textarea,select,button,dialog");
  document.addEventListener("touchstart", (event) => {
    gesture = null;
    if (!isPhone() || event.touches.length !== 1 || excluded(event.target)) return;
    const touch = event.touches[0];
    const open = document.body.classList.contains("drawer");
    if (!(open ? event.target.closest("#side") : touch.clientX < 40)) return;
    gesture = { x: touch.clientX, y: touch.clientY, at: performance.now(), open };
  }, { capture: true, passive: true });
  document.addEventListener("touchmove", (event) => {
    const start = gesture;
    if (!start || event.touches.length !== 1) { gesture = null; return; }
    const touch = event.touches[0];
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (performance.now() - start.at >= 500 || (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx))) { gesture = null; return; }
    if (Math.abs(dx) < 50 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    gesture = null;
    if (start.open ? dx < 0 : dx > 0) toggleDrawer();
  }, { capture: true, passive: true });
  for (const name of ["touchend", "touchcancel"]) document.addEventListener(name, () => { gesture = null; }, { capture: true, passive: true });
}

// ---------------------------------------------------------------- session states and the nudge

function itemState(id) {
  if (id === view.current) return { dot: "unread", text: "open", cls: "" };
  if (id === view.waiting) return { dot: "wait", text: "waiting for you", cls: "wait" };
  if (view.visited.has(id)) return { dot: "idle", text: "done", cls: "done" };
  if (AGENT_SESSIONS.has(id)) return { dot: "busy", text: "working", cls: "busy" };
  return { dot: "", text: "", cls: "" };
}

function paintItem(item, id) {
  const st = itemState(id);
  $(".dot", item).className = `dot ${st.dot}`.trim();
  item.classList.toggle("wait", id === view.waiting);
  const meta = $(".meta", item);
  meta.replaceChildren();
  if (st.text) {
    const label = document.createElement("span");
    label.className = `st ${st.cls}`.trim();
    label.textContent = st.text;
    meta.append(label, " · ");
  }
  meta.append("~/session-mesh");
}

function renderStates() {
  $$("#list .items .item").forEach((item) => paintItem(item, item.dataset.session));
  renderTodo();
  const working = ORDER.filter((id) => itemState(id).cls === "busy").length;
  const parts = [`${ORDER.length} sessions`, `${working} working`];
  if (view.waiting) parts.push("1 waiting");
  const releases = $$(".hentry").length;
  const histCount = `${releases} ${releases === 1 ? "release" : "releases"}`;
  $(".foot-count").textContent = view.tab === "hist" ? histCount : parts.join(" · ");
  $("#btn-menu").dataset.badge = view.waiting ? "1" : "";
  document.title = titleWithCount();
}

function renderTodo() {
  const todo = $("#todo");
  const id = view.waiting;
  todo.hidden = !id;
  if (!id) return;
  const button = $("#todo-item");
  const source = $(`#list .items .item[data-session="${id}"]`);
  button.replaceChildren(...[...source.cloneNode(true).childNodes]);
  button.dataset.session = id;
  button.setAttribute("aria-label", `${id} is waiting for you`);
}

// Only Claude Code reports that it waits for you; session-mesh knows only
// whether Codex and Pi are working or idle, so their sessions are never shown
// as waiting.
const CAN_WAIT = (id) => !["codex", "pi"].includes(document.getElementById(id).dataset.agent);

function nextUnvisited() {
  const start = ORDER.indexOf(view.current);
  for (let step = 1; step <= ORDER.length; step += 1) {
    const id = ORDER[(start + step) % ORDER.length];
    if (!view.visited.has(id) && CAN_WAIT(id)) return id;
  }
  return null;
}

function nudge() {
  if (view.waiting || view.nudgedThisIdle) return;
  const id = nextUnvisited();
  if (!id) return;
  view.nudgedThisIdle = true;
  view.waiting = id;
  renderStates();
  if (!reduceMotion()) {
    const todo = $("#todo");
    todo.classList.remove("nudge-pop");
    void todo.offsetWidth;
    todo.classList.add("nudge-pop");
  }
  $("#announce").textContent = `${id} is waiting for you.`;
}

function resetIdle() {
  clearTimeout(view.idleTimer);
  view.nudgedThisIdle = false;
  if (ORDER.every((id) => view.visited.has(id))) return;
  view.idleTimer = setTimeout(nudge, NUDGE_DELAY_MS);
}

function bindIdle() {
  const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"];
  events.forEach((name) => document.addEventListener(name, resetIdle, { passive: true }));
  document.addEventListener("scroll", resetIdle, { passive: true, capture: true });
  resetIdle();
}

// ---------------------------------------------------------------- the live mock in "collaborate"

const MOCK_STATUS = [
  "tests (pi) finds a problem in the work of api (claude).",
  "tests sends a message with its mesh-board tools. api is working, so session-mesh types nothing into it.",
  "api's turn ends: it is idle at its prompt, with no unsent input.",
  "session-mesh types a one-line notice. The message itself is never typed.",
  "api asks to read the message. The page asks you first: answer the request above.",
];
const MOCK_ANSWERS = {
  later: ["Later: the message stays in the inbox, unread.", "› The message waits in the inbox."],
  refuse: ["Refused: api does not read the message.", "› Message refused. Not read."],
  once: ["Read this time: api reads this message only.", "› Reading the message from tests: “The login tests fail since the token change. Can you look?”"],
  always: ["Always: api may read messages from this exact session from now on.", "› Reading the message from tests: “The login tests fail since the token change. Can you look?”"],
};
const mock = { timers: [] };

function mockAgent(which, dot, label, cls) {
  $(`#mock-${which}-dot`).className = `dot ${dot}`;
  const state = $(`#mock-${which}-state`);
  state.textContent = label;
  state.className = `mock-state ${cls}`.trim();
}

function mockShow(step) {
  $$(`#doc .mock [data-step="${step}"]`).forEach((el) => {
    el.classList.remove("off");
    if (!reduceMotion()) el.classList.add("fresh");
  });
  $("#mock-status").textContent = MOCK_STATUS[step];
  if (step === 2) mockAgent("claude", "idle", "idle", "idle");
  if (step === 4) mockAgent("claude", "busy", "working", "");
}

function mockStop() {
  mock.timers.forEach(clearTimeout);
  mock.timers = [];
}

function mockPlay() {
  mockStop();
  $$("#doc .mock [data-step]").forEach((el) => el.classList.add("off"));
  $$("#doc .mock .fresh").forEach((el) => el.classList.remove("fresh"));
  mockAgent("sender", "busy", "working", "");
  mockAgent("claude", "busy", "working", "");
  $("#mock-replay").hidden = true;
  const delays = reduceMotion() ? [0, 0, 0, 0, 0] : [500, 1700, 3300, 4300, 5400];
  delays.forEach((delay, step) => mock.timers.push(setTimeout(() => mockShow(step), delay)));
}

function mockAnswer(kind) {
  const [status, line] = MOCK_ANSWERS[kind];
  $("#mock-consent").classList.add("off");
  const result = $("#mock-result");
  result.textContent = line;
  result.classList.remove("off");
  $("#mock-status").textContent = status;
  const reading = kind === "once" || kind === "always";
  mockAgent("claude", reading ? "busy" : "idle", reading ? "working" : "idle", reading ? "" : "idle");
  $("#mock-replay").hidden = false;
}

// ---------------------------------------------------------------- list, filter and keyboard

function visibleItems() {
  return $$("#side .list .item").filter((item) => item.offsetParent !== null);
}

function moveFocus(delta, toEdge) {
  const items = visibleItems();
  if (!items.length) return;
  let index = items.indexOf(document.activeElement);
  if (index < 0) index = Math.max(0, items.findIndex((i) => i.getAttribute("aria-current") === "page"));
  else index = Math.min(items.length - 1, Math.max(0, index + delta));
  if (toEdge) index = delta < 0 ? 0 : items.length - 1;
  items[index].focus();
}

function onListKey(event) {
  const map = { ArrowDown: 1, ArrowUp: -1, Home: -1, End: 1 };
  if (!(event.key in map) || event.target.id === "filter") return;
  event.preventDefault();
  moveFocus(map[event.key], event.key === "Home" || event.key === "End");
}

// Live items match on their name, keywords and text. The filter is shown only
// on the Live tab.
function applyFilter() {
  if (view.tab !== "live") return;
  const query = $("#filter").value.trim().toLowerCase();
  let shown = 0;
  $$("#list .items li").forEach((li) => {
    const item = $(".item", li);
    const match = !query || `${item.dataset.session} ${item.dataset.keywords} ${item.textContent}`.toLowerCase().includes(query);
    li.hidden = gatedOff(li) || !match;
    if (!li.hidden) shown += 1;
  });
  $("#no-match").hidden = shown > 0;
}

function typingInField(target) {
  return target.closest("input, textarea, select, dialog, [contenteditable]");
}

function onGlobalKey(event) {
  if (event.key === "Escape") { closeDrawer(); return; }
  if (event.ctrlKey || event.metaKey || event.altKey || typingInField(event.target)) return;
  if (view.typing && event.key.length === 1) finishTyping();
  if (event.target.closest("#side .list, .tabs")) return;
  if (event.key === "n") { event.preventDefault(); openNew(); }
}

// ---------------------------------------------------------------- dialogs

function openNew() {
  updatePresetHint();
  $("#dlg-new").showModal();
}

function updatePresetHint() {
  const checked = $('#dlg-new input[name="preset"]:checked');
  const hint = $("#preset-hint");
  hint.replaceChildren("Opens ");
  const name = document.createElement("b");
  name.textContent = checked.value;
  hint.append(name, `: ${sectionTitle(checked.value)}`);
}

function bindDialogs() {
  $("#btn-new").addEventListener("click", openNew);
  $$('#dlg-new input[name="preset"]').forEach((r) => r.addEventListener("change", updatePresetHint));
  $("#new-open").addEventListener("click", () => {
    $("#dlg-new").close();
    select($('#dlg-new input[name="preset"]:checked').value);
  });
  $$("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $$("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));
  $("#btn-mobile-panels").addEventListener("click", () => $("#sheet-panes").showModal());
  $("#btn-mobile-actions").addEventListener("click", () => $("#sheet-actions").showModal());
  $$("#sheet-panes [data-pane]").forEach((b) => b.addEventListener("click", () => {
    showPane(b.dataset.pane);
    $("#sheet-panes").close();
  }));
  $('#sheet-actions [data-action="new"]').addEventListener("click", () => { $("#sheet-actions").close(); openNew(); });
  $('#sheet-actions [data-action="install"]').addEventListener("click", () => { $("#sheet-actions").close(); select("install"); });
}

// ---------------------------------------------------------------- wiring

function onClick(event) {
  if (event.target.closest("[data-open-doc]")) {
    event.preventDefault();
    showPane("doc");
    return;
  }
  const variantLink = event.target.closest("[data-variant-open]");
  if (variantLink) {
    event.preventDefault();
    openVariant(variantLink.dataset.variantOpen);
    return;
  }
  const histLink = event.target.closest('a[href^="#history"]');
  if (histLink) {
    event.preventDefault();
    go(histLink.getAttribute("href"));
    return;
  }
  const target = event.target.closest('a[href^="#"][data-go], #list .item, #todo-item');
  if (!target) return;
  const id = target.dataset.go || target.dataset.session;
  if (!id) return;
  event.preventDefault();
  select(id);
}

function bindShell() {
  document.addEventListener("click", onClick);
  $("#list").addEventListener("keydown", onListKey);
  $("#hlist").addEventListener("keydown", onListKey);
  document.addEventListener("keydown", onGlobalKey);
  $("#filter").addEventListener("input", applyFilter);
  $("#filter").addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(0); } });
  $("#content").addEventListener("click", finishTyping);
  $("#btn-menu").addEventListener("click", toggleDrawer);
  bindSwipe();
  $("#btn-panel").addEventListener("click", () => setDoc(!view.docOpen));
  $("#btn-doc-close").addEventListener("click", () => setDoc(false));
  $$(".workspace-tab[data-pane]").forEach((t) => t.addEventListener("click", () => showPane(t.dataset.pane)));
  $("#mock-replay").addEventListener("click", mockPlay);
  $$("#mock-consent [data-answer]").forEach((b) => b.addEventListener("click", () => mockAnswer(b.dataset.answer)));
  window.addEventListener("popstate", () => go(location.hash, { push: false }));
}

// On a phone the panel is a second pane: each section offers a button to it.
function addPanelButton(visual) {
  if (visual.dataset.variant) return;
  const section = visual.closest(".sess");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn open-panel";
  button.textContent = `Open the pane “${visual.dataset.title}” →`;
  button.addEventListener("click", () => openVariant(""));
  section.insertBefore(button, $(".next", section));
}

function moveVisuals() {
  const host = $("#doc");
  $$(".sess .visual").forEach((visual) => {
    addPanelButton(visual);
    host.append(visual);
  });
}

function init() {
  applyStatuses();
  ORDER = ALL_SESSIONS.filter((id) => !document.getElementById(id).hidden);
  moveVisuals();
  bindShell();
  bindTabs();
  bindDialogs();
  go(location.hash || "#welcome", { push: false });
  window.addEventListener("load", () => { $("#content").scrollTop = 0; }, { once: true });
  bindIdle();
}

document.addEventListener("DOMContentLoaded", init);
