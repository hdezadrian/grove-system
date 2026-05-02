import {
  loadState,
  initState,
  updateNode,
  incrementAttempts,
  getChildren,
} from "./core/state.js";
import {
  getActivatableChildren,
  validateTransition,
  needsReview,
} from "./core/rules.js";
import {
  createQuestionRequest,
  createEvaluationRequest,
  parseQuestionResponse,
  parseEvaluationResponse,
} from "./core/engine.js";

const STORAGE_OPENAI_API_KEY = "grove_openai_api_key";
const STORAGE_DEV_BYPASS = "grove_dev_bypass";
let openaiApiKey = null;
let apiKeyBackdrop = null;
let apiKeyPanel = null;
let changeApiKeyBtn = null;
let apiKeyResolver = null;
let developerBypassEnabled = false;
let rootEl = null;
let landingEl = null;
let appEntered = false;

function getStoredApiKey() {
  try {
    const key = localStorage.getItem(STORAGE_OPENAI_API_KEY);
    return typeof key === "string" ? key.trim() : "";
  } catch {
    return "";
  }
}

function saveApiKey(key) {
  const trimmed = String(key || "").trim();
  try {
    if (trimmed) localStorage.setItem(STORAGE_OPENAI_API_KEY, trimmed);
    else localStorage.removeItem(STORAGE_OPENAI_API_KEY);
  } catch {
    /* ignore storage errors */
  }
  openaiApiKey = trimmed || null;
}

function isValidApiKeyFormat(key) {
  return typeof key === "string" && key.trim().length >= 12;
}

function setDeveloperBypass(enabled) {
  developerBypassEnabled = Boolean(enabled);
  try {
    if (developerBypassEnabled) {
      localStorage.setItem(STORAGE_DEV_BYPASS, "1");
    } else {
      localStorage.removeItem(STORAGE_DEV_BYPASS);
    }
  } catch {
    /* ignore storage errors */
  }
}

function loadDeveloperBypass() {
  try {
    return localStorage.getItem(STORAGE_DEV_BYPASS) === "1";
  } catch {
    return false;
  }
}

function setApiKeyModalVisible(visible, message = "", prefill = "") {
  if (!apiKeyBackdrop || !apiKeyPanel) return;
  apiKeyBackdrop.hidden = !visible;
  apiKeyPanel.hidden = !visible;
  if (!visible) return;

  apiKeyPanel.innerHTML = `
    <h2 class="grove-modal-title">OpenAI API key required</h2>
    <p class="grove-modal-desc">Bring your own OpenAI API key to unlock AI-powered questioning and evaluation.</p>
    <input class="grove-input grove-input-single" data-grove-api-key-input type="password" placeholder="Paste your API key" value="${esc(prefill)}" autocomplete="off" />
    <p class="grove-modal-meta">Stored only in your browser localStorage. Never sent to a Grove backend.</p>
    ${message ? `<p class="grove-error">${esc(message)}</p>` : ""}
    <div class="grove-row">
      <button type="button" class="grove-btn grove-btn-primary" data-grove-save-api-key>Save key</button>
      <!-- TEMP_DEV_ONLY: remove this bypass button before production -->
      <button type="button" class="grove-btn" data-grove-dev-only-skip>Developer only</button>
    </div>
  `;

  const input = apiKeyPanel.querySelector("[data-grove-api-key-input]");
  const saveBtn = apiKeyPanel.querySelector("[data-grove-save-api-key]");
  const devOnlyBtn = apiKeyPanel.querySelector("[data-grove-dev-only-skip]");
  input?.focus();

  const submit = () => {
    const value = input?.value?.trim() || "";
    if (!isValidApiKeyFormat(value)) {
      setApiKeyModalVisible(true, "API key looks too short. Paste a full key.", value);
      return;
    }
    setDeveloperBypass(false);
    saveApiKey(value);
    setApiKeyModalVisible(false);
    if (typeof apiKeyResolver === "function") {
      const resolve = apiKeyResolver;
      apiKeyResolver = null;
      resolve(value);
    }
  };

  saveBtn?.addEventListener("click", submit);
  devOnlyBtn?.addEventListener("click", () => {
    setDeveloperBypass(true);
    setApiKeyModalVisible(false);
    if (typeof apiKeyResolver === "function") {
      const resolve = apiKeyResolver;
      apiKeyResolver = null;
      resolve("");
    }
    enterApp();
  });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

async function ensureApiKey() {
  if (developerBypassEnabled) return "";
  if (openaiApiKey && isValidApiKeyFormat(openaiApiKey)) return openaiApiKey;
  const stored = getStoredApiKey();
  if (isValidApiKeyFormat(stored)) {
    openaiApiKey = stored;
    return stored;
  }

  return new Promise((resolve) => {
    apiKeyResolver = resolve;
    setApiKeyModalVisible(true, "", stored);
  });
}

function openApiKeyEditor(message = "") {
  const current = openaiApiKey || getStoredApiKey();
  setApiKeyModalVisible(true, message, current);
}

function hasValidApiKey() {
  if (developerBypassEnabled) return true;
  const current = openaiApiKey || getStoredApiKey();
  return isValidApiKeyFormat(current);
}

function showLanding() {
  if (landingEl) landingEl.hidden = false;
  if (rootEl) rootEl.hidden = true;
  if (changeApiKeyBtn) changeApiKeyBtn.hidden = true;
}

function showTreeUi() {
  if (landingEl) landingEl.hidden = true;
  if (rootEl) rootEl.hidden = false;
  if (changeApiKeyBtn) changeApiKeyBtn.hidden = false;
}

function enterApp() {
  if (appEntered) return;
  ensureState();
  renderTree();
  showTreeUi();
  appEntered = true;
}

async function chatCompletion({ system, user, signal }) {
  if (developerBypassEnabled) {
    if (user.includes("LEARNER_ANSWER")) {
      return JSON.stringify({
        valid: true,
        reason: "Developer bypass enabled: auto-approved without API call.",
      });
    }
    return JSON.stringify({
      question: "Developer bypass enabled. Explain this concept in your own words with one clear example.",
    });
  }
  // This uses the OpenAI API directly from the browser. The API key is stored locally and never sent to a custom backend.
  const apiKey = await ensureApiKey();
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal,
    });

    if (!res.ok) {
      let apiMessage = "";
      try {
        const errData = await res.json();
        apiMessage = errData?.error?.message || "";
      } catch {
        /* ignore JSON parse errors */
      }

      if (res.status === 401 || res.status === 403) {
        saveApiKey("");
        openApiKeyEditor("Invalid API key");
        throw new Error("Invalid API key");
      }
      if (res.status === 429) {
        throw new Error("Too many requests");
      }
      throw new Error(apiMessage || "OpenAI request failed");
    }

    const data = await res.json();
    const result = data?.choices?.[0]?.message?.content;
    if (typeof result !== "string") {
      throw new Error("OpenAI response missing assistant message");
    }
    return result;
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    if (err instanceof TypeError) {
      throw new Error("Connection error");
    }
    throw err;
  }
}

/** @typedef {{ selectedNodeId: string | null, modalOpen: boolean, loadingQuestion: boolean, loadingEvaluation: boolean, currentQuestion: string | null, lastEvaluation: { valid: boolean, reason: string, mistakes?: string[], improvements?: string[], exampleAnswer?: string } | null, reviewWarning: boolean, error: string | null }} ModalModel */

const STORAGE_PALETTE = "grove_tree_palette";

const PALETTES = {
  green: {
    name: "green",
    trunk: "#6b5344",
    activeStroke: "#3d7a52",
    activeFill: "#e8f4ea",
    bloomedStroke: "#2e8b57",
    bloomedFill: "#dcfce7",
    lockedStroke: "#b8b0a8",
    lockedFill: "#f3f0ea",
    edge: "rgba(45, 42, 38, 0.35)",
    accent: "#3d7a52",
  },
  blue: {
    name: "blue",
    trunk: "#6b5344",
    activeStroke: "#2563eb",
    activeFill: "#e8efff",
    bloomedStroke: "#1d4ed8",
    bloomedFill: "#dbeafe",
    lockedStroke: "#b8b0a8",
    lockedFill: "#f3f0ea",
    edge: "rgba(37, 99, 235, 0.28)",
    accent: "#2563eb",
  },
  purple: {
    name: "purple",
    trunk: "#6b5344",
    activeStroke: "#7c3aed",
    activeFill: "#f3e8ff",
    bloomedStroke: "#6d28d9",
    bloomedFill: "#ede9fe",
    lockedStroke: "#b8b0a8",
    lockedFill: "#f3f0ea",
    edge: "rgba(124, 58, 237, 0.28)",
    accent: "#7c3aed",
  },
  amber: {
    name: "amber",
    trunk: "#6b5344",
    activeStroke: "#d97706",
    activeFill: "#fffbeb",
    bloomedStroke: "#b45309",
    bloomedFill: "#fef3c7",
    lockedStroke: "#b8b0a8",
    lockedFill: "#f3f0ea",
    edge: "rgba(217, 119, 6, 0.3)",
    accent: "#d97706",
  },
};

const PALETTE_KEYS = Object.keys(PALETTES);

const Y_GAP = 108;
const X_PADDING = 72;
const ROOT_R = 26;
const NODE_R = 18;

/** @type {ModalModel} */
const modal = {
  selectedNodeId: null,
  modalOpen: false,
  loadingQuestion: false,
  loadingEvaluation: false,
  currentQuestion: null,
  lastEvaluation: null,
  reviewWarning: false,
  error: null,
};

let abortQuestion = null;
let abortEval = null;

let svgEl = null;
let viewportG = null;
let edgesG = null;
let nodesG = null;
let tooltipEl = null;
let modalBackdrop = null;
let modalPanel = null;

let scale = 1;
let panX = 0;
let panY = 0;
let dragging = false;
let dragLast = { x: 0, y: 0 };

/** @type {Record<string, { x: number, y: number }>} */
let lastPositions = {};

/** @returns {Record<string, unknown> | null} */
function ensureState() {
  let state = loadState();
  if (!state || !state.nodes) {
    initState("Grove", "Your learning tree begins at the root.");
    state = loadState();
  }
  return state;
}

function persistPalette(name) {
  try {
    localStorage.setItem(STORAGE_PALETTE, name);
  } catch {
    /* ignore */
  }
}

function loadPaletteName() {
  try {
    const raw = localStorage.getItem(STORAGE_PALETTE);
    if (raw && PALETTES[raw]) return raw;
  } catch {
    /* ignore */
  }
  return null;
}

/** Assign one palette per tree at creation; stays stable via localStorage. */
function resolvePalette(state) {
  const existing = loadPaletteName();
  if (existing) return PALETTES[existing];

  const seed = String(state?.projectName ?? state?.createdAt ?? "grove");
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const pick = PALETTE_KEYS[Math.abs(h) % PALETTE_KEYS.length];
  persistPalette(pick);
  return PALETTES[pick];
}

function getRoot(state) {
  if (!state?.nodes) return null;
  return Object.values(state.nodes).find((n) => n && n.parentId === null) ?? null;
}

function getNodeById(state, id) {
  if (!state?.nodes || !id) return null;
  return state.nodes[id] ?? null;
}

/** Leaf-count subtree widths for tidy horizontal layout. */
function computeLeafCounts(rootId, state, memo = {}) {
  const kids = getChildren(rootId).filter((k) => getNodeById(state, k.id));
  if (!kids.length) {
    memo[rootId] = 1;
    return memo;
  }
  let sum = 0;
  for (const k of kids) {
    computeLeafCounts(k.id, state, memo);
    sum += memo[k.id] ?? 1;
  }
  memo[rootId] = sum;
  return memo;
}

/** @returns {Record<string, { x: number, y: number }>} */
function layoutPositions(rootId, state, leafMemo, left, width, depth, out = {}) {
  const x = left + width / 2;
  const y = depth * Y_GAP + X_PADDING;
  out[rootId] = { x, y };
  const kids = getChildren(rootId).filter((k) => getNodeById(state, k.id));
  if (!kids.length) return out;

  const totalLeaves = leafMemo[rootId] || 1;
  let cursor = left;
  for (const k of kids) {
    const w = width * ((leafMemo[k.id] || 1) / totalLeaves);
    layoutPositions(k.id, state, leafMemo, cursor, w, depth + 1, out);
    cursor += w;
  }
  return out;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function setViewportTransform() {
  if (!viewportG) return;
  viewportG.setAttribute("transform", `translate(${panX} ${panY}) scale(${scale})`);
}

function progressLine(state) {
  const nodes = state?.nodes;
  if (!nodes) return "";
  const total = Object.values(nodes).filter((n) => n && n.depth !== 0).length;
  const bloomed = Object.values(nodes).filter((n) => n && n.depth !== 0 && n.status === "bloomed").length;
  return total ? `${bloomed}/${total} concepts verified` : "";
}

function buildNodeLearningContext(node, state) {
  if (!node || !state?.nodes) return {};

  const parent = node.parentId ? state.nodes[node.parentId] : null;
  const childLabels = Object.values(state.nodes)
    .filter((n) => n && n.parentId === node.id && n.label)
    .map((n) => n.label)
    .slice(0, 4);

  const prerequisiteLabels = [];
  let cursor = parent;
  while (cursor && prerequisiteLabels.length < 4) {
    if (cursor.label) prerequisiteLabels.push(cursor.label);
    cursor = cursor.parentId ? state.nodes[cursor.parentId] : null;
  }

  return {
    parentLabel: parent?.label || "",
    childLabels,
    prerequisiteLabels,
  };
}

function applyPaletteCss(palette) {
  document.documentElement.style.setProperty("--grove-accent", palette.accent);
}

function triggerBloom(worldX, worldY) {
  if (!viewportG) return;
  const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  layer.setAttribute("class", "grove-bloom-layer");
  viewportG.appendChild(layer);

  const count = 14;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--grove-accent").trim() || "#3d7a52";

  for (let i = 0; i < count; i++) {
    const petal = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const r = 2 + (i % 4);
    const ox = (Math.random() - 0.5) * 36;
    const cyStart = worldY;
    const cyEnd = worldY - 42 - Math.random() * 52;
    petal.setAttribute("cx", String(worldX + ox));
    petal.setAttribute("cy", String(cyStart));
    petal.setAttribute("r", String(r));
    petal.setAttribute("fill", accent);
    petal.setAttribute("opacity", "0.55");
    layer.appendChild(petal);

    const anim = petal.animate(
      [
        { cy: cyStart, opacity: 0.55 },
        { cy: cyEnd, opacity: 0 },
      ],
      { duration: 900 + Math.random() * 500, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
    );
    anim.onfinish = () => petal.remove();
  }

  setTimeout(() => {
    layer.remove();
  }, 1600);
}

function drawEdges(rootId, state, positions, palette, parentId = null) {
  if (!edgesG) return;
  const kids = getChildren(parentId ?? rootId);
  const pid = parentId ?? rootId;
  const p = positions[pid];

  for (const child of kids) {
    const c = positions[child.id];
    if (p && c) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const mx = (p.x + c.x) / 2;
      const d = `M ${p.x} ${p.y} Q ${mx} ${p.y + (c.y - p.y) * 0.55}, ${c.x} ${c.y}`;
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", palette.edge);
      path.setAttribute("stroke-width", "1.35");
      path.setAttribute("stroke-linecap", "round");
      edgesG.appendChild(path);
    }
    drawEdges(rootId, state, positions, palette, child.id);
  }
}

function drawNodes(state, positions, palette) {
  if (!nodesG) return;
  for (const node of Object.values(state.nodes)) {
    if (!node) continue;
    const pos = positions[node.id];
    if (!pos) continue;

    lastPositions[node.id] = { x: pos.x, y: pos.y };

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("data-node-id", node.id);
    g.setAttribute("transform", `translate(${pos.x} ${pos.y})`);
    g.style.cursor = node.status === "locked" ? "default" : "pointer";

    const isRoot = node.parentId === null;
    const r = isRoot ? ROOT_R : NODE_R;

    let stroke = palette.lockedStroke;
    let fill = palette.lockedFill;
    if (node.status === "active") {
      stroke = palette.activeStroke;
      fill = palette.activeFill;
    } else if (node.status === "bloomed") {
      stroke = palette.bloomedStroke;
      fill = palette.bloomedFill;
    }

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", fill);
    circle.setAttribute("stroke", isRoot ? palette.trunk : stroke);
    circle.setAttribute("stroke-width", isRoot ? "2.4" : "1.8");
    g.appendChild(circle);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("y", String(r + 22));
    label.setAttribute("font-size", "12");
    label.setAttribute("fill", "#2c2825");
    label.setAttribute("font-family", "Georgia, 'Times New Roman', serif");

    if (node.status === "locked") {
      label.textContent = "?";
      label.setAttribute("opacity", "0.55");
    } else {
      label.textContent = node.label || "Untitled";
      if (node.status === "bloomed") {
        const check = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
        check.textContent = " ✓";
        check.setAttribute("fill", palette.bloomedStroke);
        label.appendChild(check);
      }
    }
    g.appendChild(label);

    if (node.status !== "locked") {
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        openModal(node.id);
      });
    }

    g.addEventListener("mouseenter", () => showTooltip(node));
    g.addEventListener("mouseleave", hideTooltip);

    nodesG.appendChild(g);
  }
}

function showTooltip(node) {
  if (!tooltipEl) return;
  if (node.status === "locked") {
    tooltipEl.textContent = "Locked";
  } else if (node.status === "bloomed") {
    tooltipEl.textContent = `${node.label || "Untitled"} ✓`;
  } else {
    tooltipEl.textContent = node.label || "Untitled";
  }
  tooltipEl.style.opacity = "1";
}

function hideTooltip() {
  if (!tooltipEl) return;
  tooltipEl.style.opacity = "0";
}

function trackTooltip(e) {
  if (!tooltipEl || tooltipEl.style.opacity === "0") return;
  const pad = 14;
  tooltipEl.style.left = `${e.clientX + pad}px`;
  tooltipEl.style.top = `${e.clientY + pad}px`;
}

function renderTree() {
  const state = loadState();
  if (!state?.nodes || !edgesG || !nodesG || !svgEl) return;

  const palette = resolvePalette(state);
  applyPaletteCss(palette);

  lastPositions = {};

  edgesG.replaceChildren();
  nodesG.replaceChildren();

  const root = getRoot(state);
  if (!root) return;

  const memo = computeLeafCounts(root.id, state);
  const totalLeaves = memo[root.id] || 1;
  const positions = layoutPositions(root.id, state, memo, X_PADDING, Math.max(560, totalLeaves * 96), 0);

  let maxX = 0;
  let maxY = 0;
  for (const p of Object.values(positions)) {
    maxX = Math.max(maxX, p.x + ROOT_R + 120);
    maxY = Math.max(maxY, p.y + 80);
  }
  svgEl.setAttribute("viewBox", `0 0 ${Math.ceil(maxX + X_PADDING)} ${Math.ceil(maxY + X_PADDING)}`);

  drawEdges(root.id, state, positions, palette);
  drawNodes(state, positions, palette);
}

function closeModal() {
  modal.modalOpen = false;
  modal.selectedNodeId = null;
  modal.loadingQuestion = false;
  modal.loadingEvaluation = false;
  modal.currentQuestion = null;
  modal.lastEvaluation = null;
  modal.reviewWarning = false;
  modal.error = null;
  if (abortQuestion) abortQuestion.abort();
  if (abortEval) abortEval.abort();
  abortQuestion = null;
  abortEval = null;
  if (modalBackdrop) modalBackdrop.hidden = true;
  document.body.style.overflow = "";
}

function openModal(nodeId) {
  const state = loadState();
  const node = getNodeById(state, nodeId);
  if (!node || node.status === "locked") return;

  modal.modalOpen = true;
  modal.selectedNodeId = nodeId;
  modal.loadingQuestion = false;
  modal.loadingEvaluation = false;
  modal.currentQuestion = null;
  modal.lastEvaluation = null;
  modal.reviewWarning = false;
  modal.error = null;
  if (modalBackdrop) modalBackdrop.hidden = false;
  document.body.style.overflow = "hidden";

  const isRoot = node.parentId === null;
  if (!isRoot && node.status === "active") {
    requestQuestion(node);
  }
  renderModal();
}

async function requestQuestion(node) {
  modal.loadingQuestion = true;
  modal.error = null;
  renderModal();
  abortQuestion?.abort();
  abortQuestion = new AbortController();

  try {
    const snapshot = loadState();
    const contextualNode = { ...node, treeContext: buildNodeLearningContext(node, snapshot) };
    const { system, user } = createQuestionRequest(contextualNode, progressLine(snapshot));
    const raw = await chatCompletion({ system, user, signal: abortQuestion.signal });
    const parsed = parseQuestionResponse(raw);
    if (!parsed) {
      modal.error = "Could not parse the question. Try again.";
      modal.currentQuestion = null;
    } else {
      modal.currentQuestion = parsed.question;
    }
  } catch (e) {
    if (e?.name === "AbortError") return;
    modal.error = e?.message || "Failed to load question.";
    modal.currentQuestion = null;
  } finally {
    modal.loadingQuestion = false;
    renderModal();
  }
}

async function submitAnswer() {
  const state = loadState();
  const node = getNodeById(state, modal.selectedNodeId);
  const input = modalPanel?.querySelector("[data-grove-answer]");
  const answer = input?.value?.trim() ?? "";
  if (!node || node.parentId === null || node.status !== "active") return;
  if (!answer) {
    modal.error = "Write an answer before submitting.";
    renderModal();
    return;
  }

  modal.loadingEvaluation = true;
  modal.error = null;
  modal.lastEvaluation = null;
  renderModal();
  abortEval?.abort();
  abortEval = new AbortController();

  try {
    const snapshot = loadState();
    const contextualNode = { ...node, treeContext: buildNodeLearningContext(node, snapshot) };
    const { system, user } = createEvaluationRequest(contextualNode, answer, progressLine(snapshot));
    const raw = await chatCompletion({ system, user, signal: abortEval.signal });
    const parsed = parseEvaluationResponse(raw);
    if (!parsed) {
      modal.error = "Could not parse evaluation. Try again.";
      renderModal();
      return;
    }

    modal.lastEvaluation = {
      valid: parsed.valid,
      reason: parsed.reason,
      mistakes: parsed.mistakes ?? [],
      improvements: parsed.improvements ?? [],
      exampleAnswer: parsed.exampleAnswer ?? "",
    };

    if (parsed.valid) {
      const fresh = loadState();
      const latest = getNodeById(fresh, node.id);
      if (!latest) return;

      const bloomCheck = validateTransition(latest, "bloomed", fresh.nodes);
      if (!bloomCheck.allowed) {
        modal.error = bloomCheck.reason;
        renderModal();
        return;
      }

      const iso = new Date().toISOString();
      updateNode(latest.id, { status: "bloomed", completedAt: iso });

      const afterBloom = loadState();
      const bloomedNode = getNodeById(afterBloom, latest.id);
      if (bloomedNode) {
        const toActivate = getActivatableChildren(bloomedNode, afterBloom.nodes);
        for (const child of toActivate) {
          const st = loadState();
          const ch = getNodeById(st, child.id);
          if (!ch) continue;
          const v = validateTransition(ch, "active", st.nodes);
          if (v.allowed) updateNode(ch.id, { status: "active" });
        }
      }

      const bloomPos = lastPositions[latest.id];
      if (bloomPos) triggerBloom(bloomPos.x, bloomPos.y);

      renderTree();
      modal.reviewWarning = false;
      renderModal();
      return;
    }

    incrementAttempts(node.id);
    const updated = loadState();
    const post = getNodeById(updated, node.id);
    modal.reviewWarning = needsReview(post, updated?.nodes);
    renderTree();
    renderModal();
  } catch (e) {
    if (e?.name === "AbortError") return;
    modal.error = e?.message || "Evaluation failed.";
    renderModal();
  } finally {
    modal.loadingEvaluation = false;
    renderModal();
  }
}

function renderModal() {
  if (!modalPanel) return;
  const state = loadState();
  const node = getNodeById(state, modal.selectedNodeId);

  if (!modal.modalOpen || !node) {
    modalPanel.innerHTML = "";
    return;
  }

  const isRoot = node.parentId === null;
  const palette = resolvePalette(state);

  let body = "";

  body += `<h2 class="grove-modal-title">${esc(node.label || "Untitled")}</h2>`;
  if (node.description) {
    body += `<p class="grove-modal-desc">${esc(node.description)}</p>`;
  }

  if (isRoot) {
    body += `<p class="grove-modal-meta">This is your learning root. Open any active child node to begin your checkpoint.</p>`;
    body += `<button type="button" class="grove-btn grove-btn-primary" data-grove-close>Close</button>`;
  } else if (node.status === "bloomed") {
    body += `<p class="grove-done">Checkpoint passed${node.completedAt ? ` · ${esc(node.completedAt.slice(0, 10))}` : ""}</p>`;
    body += `<button type="button" class="grove-btn grove-btn-primary" data-grove-close>Close</button>`;
  } else if (node.status === "active") {
    if (modal.loadingQuestion) {
      body += `<p class="grove-loading">Preparing a targeted understanding check…</p>`;
    } else if (modal.error && !modal.currentQuestion) {
      body += `<p class="grove-error">${esc(modal.error)}</p>`;
      body += `<button type="button" class="grove-btn" data-grove-retry-q>Try again</button>`;
    } else if (modal.currentQuestion) {
      body += `<p class="grove-modal-meta">Goal: explain in your own words and include a concrete example or analogy.</p>`;
      body += `<p class="grove-question">${esc(modal.currentQuestion)}</p>`;
      body += `<textarea class="grove-input" data-grove-answer rows="5" placeholder="Explain in your own words…" ${modal.loadingEvaluation ? "disabled" : ""}></textarea>`;
      body += `<div class="grove-row">`;
      body += `<button type="button" class="grove-btn grove-btn-primary" data-grove-submit ${modal.loadingEvaluation ? "disabled" : ""}>Submit</button>`;
      body += `</div>`;
      if (modal.loadingEvaluation) {
        body += `<p class="grove-loading">Evaluating depth of understanding…</p>`;
      }
      if (modal.lastEvaluation && !modal.lastEvaluation.valid) {
        body += `<p class="grove-feedback">${esc(modal.lastEvaluation.reason)}</p>`;
        if (modal.lastEvaluation.mistakes?.length) {
          body += `<p class="grove-modal-meta">What needs correction:</p>`;
          body += `<ul class="grove-list">${modal.lastEvaluation.mistakes.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`;
        }
        if (modal.lastEvaluation.improvements?.length) {
          body += `<p class="grove-modal-meta">How to improve:</p>`;
          body += `<ul class="grove-list">${modal.lastEvaluation.improvements.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`;
        }
        if (modal.lastEvaluation.exampleAnswer) {
          body += `<p class="grove-modal-meta">Example strong answer:</p>`;
          body += `<p class="grove-feedback">${esc(modal.lastEvaluation.exampleAnswer)}</p>`;
        }
      }
      if (modal.error && modal.currentQuestion) {
        body += `<p class="grove-error">${esc(modal.error)}</p>`;
      }
      if (modal.reviewWarning) {
        body += `<p class="grove-review">This concept still looks fragile. Revisit the parent idea, then answer again with clearer reasoning and a concrete example.</p>`;
      }
    }
  }

  modalPanel.innerHTML = body;

  modalPanel.querySelector("[data-grove-close]")?.addEventListener("click", closeModal);
  modalPanel.querySelector("[data-grove-retry-q]")?.addEventListener("click", () => {
    modal.error = null;
    requestQuestion(node);
  });
  modalPanel.querySelector("[data-grove-submit]")?.addEventListener("click", submitAnswer);

  modalPanel.style.borderColor = palette.accent;
}

function wireSvgInteractions() {
  if (!svgEl || !viewportG) return;

  svgEl.addEventListener("pointerdown", (e) => {
    if (e.target === svgEl || e.target === viewportG || e.target === edgesG) {
      dragging = true;
      dragLast = { x: e.clientX, y: e.clientY };
      svgEl.setPointerCapture(e.pointerId);
    }
  });

  svgEl.addEventListener("pointermove", (e) => {
    trackTooltip(e);
    if (!dragging) return;
    const dx = e.clientX - dragLast.x;
    const dy = e.clientY - dragLast.y;
    dragLast = { x: e.clientX, y: e.clientY };
    panX += dx;
    panY += dy;
    setViewportTransform();
  });

  svgEl.addEventListener("pointerup", () => {
    dragging = false;
  });

  svgEl.addEventListener("pointercancel", () => {
    dragging = false;
  });

  svgEl.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.001;
      const next = Math.min(2.4, Math.max(0.45, scale + delta));
      scale = next;
      setViewportTransform();
    },
    { passive: false }
  );
}

function injectStyles() {
  const css = `
    :root {
      --grove-accent: #3d7a52;
      --grove-paper: #f7f5f0;
      --grove-ink: #2c2825;
      --grove-muted: #6f6860;
    }
    html, body {
      margin: 0;
      height: 100%;
      background: var(--grove-paper);
      color: var(--grove-ink);
      font-family: system-ui, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
    }
    #grove-root {
      position: relative;
      width: 100%;
      height: 100%;
    }
    #grove-landing {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background: radial-gradient(circle at 30% 15%, #fdfcf9 0%, #f2ede4 55%, #e6dfd3 100%);
      z-index: 20;
    }
    .grove-landing-card {
      width: min(680px, calc(100vw - 36px));
      border-radius: 24px;
      padding: 36px 28px;
      background: rgba(255, 253, 248, 0.86);
      border: 1px solid rgba(44, 40, 37, 0.08);
      box-shadow: 0 26px 80px rgba(20, 18, 14, 0.16);
      text-align: center;
      backdrop-filter: blur(6px);
    }
    .grove-landing-title {
      margin: 0 0 10px;
      font-size: clamp(2rem, 5vw, 3rem);
      letter-spacing: 0.02em;
    }
    .grove-landing-tagline {
      margin: 0 0 24px;
      color: var(--grove-muted);
      font-size: 1.05rem;
    }
    .grove-landing-tree {
      display: block;
      width: min(420px, 100%);
      height: auto;
      margin: 0 auto 22px;
      filter: drop-shadow(0 10px 20px rgba(61, 122, 82, 0.18));
    }
    .grove-landing-cta {
      padding: 12px 22px;
      font-size: 1rem;
      font-weight: 600;
    }
    #grove-svg {
      width: 100%;
      height: 100%;
      display: block;
      touch-action: none;
      background: radial-gradient(circle at 30% 18%, #fdfcfa 0%, #ebe6dc 55%, #e2dcd2 100%);
    }
    #grove-tooltip {
      position: fixed;
      pointer-events: none;
      z-index: 40;
      background: rgba(44, 40, 37, 0.92);
      color: #faf8f4;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
      opacity: 0;
      transition: opacity 0.12s ease;
      max-width: 260px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #grove-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 50;
      background: rgba(30, 26, 22, 0.38);
      backdrop-filter: blur(10px);
    }
    #grove-modal-panel {
      position: fixed;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(520px, calc(100vw - 40px));
      max-height: min(72vh, 640px);
      overflow: auto;
      z-index: 51;
      background: rgba(253, 251, 246, 0.96);
      border-radius: 18px;
      border: 1px solid rgba(0,0,0,0.08);
      box-shadow: 0 28px 80px rgba(20, 18, 14, 0.22);
      padding: 28px 26px 24px;
    }
    .grove-modal-title {
      margin: 0 0 10px;
      font-weight: 600;
      font-size: 1.25rem;
      letter-spacing: 0.02em;
    }
    .grove-modal-desc {
      margin: 0 0 14px;
      color: var(--grove-muted);
      line-height: 1.55;
      font-size: 0.95rem;
    }
    .grove-modal-meta, .grove-done {
      margin: 16px 0 12px;
      font-size: 0.92rem;
      color: var(--grove-muted);
    }
    .grove-question {
      margin: 18px 0 12px;
      line-height: 1.55;
      font-size: 1rem;
    }
    .grove-input {
      width: 100%;
      box-sizing: border-box;
      border-radius: 12px;
      border: 1px solid rgba(44,40,37,0.15);
      padding: 12px 14px;
      font: inherit;
      resize: vertical;
      min-height: 120px;
      background: #fffdf8;
    }
    .grove-input-single {
      min-height: 0;
      resize: none;
    }
    .grove-row {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 12px;
    }
    .grove-btn {
      border-radius: 999px;
      border: 1px solid rgba(44,40,37,0.12);
      padding: 10px 18px;
      background: transparent;
      cursor: pointer;
      font: inherit;
      color: var(--grove-ink);
    }
    .grove-btn-primary {
      border-color: transparent;
      background: var(--grove-accent);
      color: #fdfcfa;
    }
    .grove-btn:disabled {
      opacity: 0.55;
      cursor: default;
    }
    .grove-loading {
      margin-top: 12px;
      font-size: 0.9rem;
      color: var(--grove-muted);
    }
    .grove-feedback {
      margin-top: 12px;
      font-size: 0.92rem;
      color: var(--grove-muted);
    }
    .grove-list {
      margin: 8px 0 10px 20px;
      padding: 0;
      color: var(--grove-muted);
      font-size: 0.92rem;
      line-height: 1.45;
    }
    .grove-error {
      margin-top: 12px;
      font-size: 0.92rem;
      color: #b45309;
    }
    .grove-review {
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(217, 119, 6, 0.08);
      color: #92400e;
      font-size: 0.92rem;
    }
    #grove-api-key-backdrop {
      position: fixed;
      inset: 0;
      z-index: 60;
      background: rgba(30, 26, 22, 0.5);
      backdrop-filter: blur(8px);
    }
    #grove-api-key-panel {
      position: fixed;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(480px, calc(100vw - 40px));
      z-index: 61;
      background: rgba(253, 251, 246, 0.98);
      border-radius: 18px;
      border: 1px solid rgba(0,0,0,0.08);
      box-shadow: 0 28px 80px rgba(20, 18, 14, 0.25);
      padding: 22px 22px 18px;
    }
    #grove-change-api-key {
      position: fixed;
      right: 16px;
      top: 16px;
      z-index: 45;
      border-radius: 999px;
      border: 1px solid rgba(44,40,37,0.15);
      background: rgba(253, 251, 246, 0.92);
      color: var(--grove-ink);
      padding: 8px 12px;
      font: inherit;
      cursor: pointer;
    }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

function mountDom() {
  injectStyles();

  rootEl = document.createElement("div");
  rootEl.id = "grove-root";
  rootEl.hidden = true;

  svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgEl.id = "grove-svg";

  viewportG = document.createElementNS("http://www.w3.org/2000/svg", "g");
  viewportG.id = "grove-viewport";

  edgesG = document.createElementNS("http://www.w3.org/2000/svg", "g");
  edgesG.id = "grove-edges";

  nodesG = document.createElementNS("http://www.w3.org/2000/svg", "g");
  nodesG.id = "grove-nodes";

  viewportG.appendChild(edgesG);
  viewportG.appendChild(nodesG);
  svgEl.appendChild(viewportG);
  rootEl.appendChild(svgEl);

  tooltipEl = document.createElement("div");
  tooltipEl.id = "grove-tooltip";
  rootEl.appendChild(tooltipEl);

  landingEl = document.createElement("section");
  landingEl.id = "grove-landing";
  landingEl.innerHTML = `
    <div class="grove-landing-card">
      <h1 class="grove-landing-title">Grove</h1>
      <p class="grove-landing-tagline">Learn by growing a knowledge tree</p>
      <svg class="grove-landing-tree" viewBox="0 0 420 220" role="img" aria-label="Stylized knowledge tree">
        <defs>
          <linearGradient id="groveCanopy" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#a7ddaf" />
            <stop offset="100%" stop-color="#4f9f69" />
          </linearGradient>
          <linearGradient id="groveTrunk" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#8a654d" />
            <stop offset="100%" stop-color="#6e4d39" />
          </linearGradient>
        </defs>
        <ellipse cx="210" cy="98" rx="132" ry="70" fill="url(#groveCanopy)" opacity="0.96"></ellipse>
        <ellipse cx="130" cy="92" rx="58" ry="38" fill="#b6e7be" opacity="0.9"></ellipse>
        <ellipse cx="292" cy="90" rx="62" ry="40" fill="#8dce9f" opacity="0.93"></ellipse>
        <ellipse cx="210" cy="70" rx="42" ry="24" fill="#9fdaa8" opacity="0.88"></ellipse>
        <rect x="189" y="114" width="42" height="82" rx="14" fill="url(#groveTrunk)"></rect>
        <path d="M210 188 C182 196, 154 204, 122 212" stroke="#77553f" stroke-width="9" fill="none" stroke-linecap="round"></path>
        <path d="M210 190 C238 198, 266 206, 298 214" stroke="#77553f" stroke-width="9" fill="none" stroke-linecap="round"></path>
        <circle cx="127" cy="212" r="8" fill="#4d9b67"></circle>
        <circle cx="209" cy="214" r="8" fill="#4d9b67"></circle>
        <circle cx="293" cy="213" r="8" fill="#4d9b67"></circle>
      </svg>
      <button type="button" class="grove-btn grove-btn-primary grove-landing-cta" data-grove-start>
        Start → Enter your OpenAI API key
      </button>
      <!-- TEMP_DEV_ONLY: remove this bypass button before production -->
      <button type="button" class="grove-btn grove-landing-cta" data-grove-dev-only-start>
        Developer only
      </button>
    </div>
  `;

  modalBackdrop = document.createElement("div");
  modalBackdrop.id = "grove-modal-backdrop";
  modalBackdrop.hidden = true;
  modalBackdrop.addEventListener("click", closeModal);

  modalPanel = document.createElement("div");
  modalPanel.id = "grove-modal-panel";

  changeApiKeyBtn = document.createElement("button");
  changeApiKeyBtn.id = "grove-change-api-key";
  changeApiKeyBtn.type = "button";
  changeApiKeyBtn.textContent = "Change API Key";
  changeApiKeyBtn.addEventListener("click", () => openApiKeyEditor());
  changeApiKeyBtn.hidden = true;

  apiKeyBackdrop = document.createElement("div");
  apiKeyBackdrop.id = "grove-api-key-backdrop";
  apiKeyBackdrop.hidden = true;

  apiKeyPanel = document.createElement("div");
  apiKeyPanel.id = "grove-api-key-panel";
  apiKeyPanel.hidden = true;

  document.body.appendChild(rootEl);
  document.body.appendChild(landingEl);
  document.body.appendChild(changeApiKeyBtn);
  document.body.appendChild(modalBackdrop);
  document.body.appendChild(modalPanel);
  document.body.appendChild(apiKeyBackdrop);
  document.body.appendChild(apiKeyPanel);

  landingEl.querySelector("[data-grove-start]")?.addEventListener("click", async () => {
    try {
      await ensureApiKey();
      enterApp();
    } catch {
      /* modal remains open or user retries */
    }
  });
  landingEl.querySelector("[data-grove-dev-only-start]")?.addEventListener("click", () => {
    setDeveloperBypass(true);
    enterApp();
  });

  wireSvgInteractions();
}

async function bootstrap() {
  setDeveloperBypass(loadDeveloperBypass());
  mountDom();
  if (hasValidApiKey()) {
    enterApp();
    return;
  }
  showLanding();
}

bootstrap();
