const STORAGE_KEY = "grove_state";

// Creates and returns a new root node object for the project.
function createRootNode(projectName, projectDescription) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    parentId: null,
    label: projectName ?? "",
    description: projectDescription ?? "",
    depth: 0,
    status: "active",
    attempts: 0,
    createdAt: now,
    completedAt: null,
  };
}

// Creates a new state with one active root node, saves it, and returns the full state.
export function initState(projectName, projectDescription) {
  const now = new Date().toISOString();
  const root = createRootNode(projectName, projectDescription);
  const state = {
    projectName: projectName ?? "",
    projectDescription: projectDescription ?? "",
    createdAt: now,
    nodes: {
      [root.id]: root,
    },
  };
  saveState(state);
  return state;
}

// Loads and returns parsed grove state from localStorage, or null if unavailable/invalid.
export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// Saves the provided state object to localStorage and returns the same state.
export function saveState(state) {
  try {
    if (!state || typeof state !== "object") return state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state;
  } catch {
    return state;
  }
}

// Loads state and returns the node for the given id, or null when not found.
export function getNode(id) {
  const state = loadState();
  if (!state || !state.nodes || !id) return null;
  return state.nodes[id] ?? null;
}

// Applies partial changes to a node, saves state, and returns the updated node or null.
export function updateNode(id, changes) {
  const state = loadState();
  if (!state || !state.nodes || !id) return null;
  const node = state.nodes[id];
  if (!node) return null;

  state.nodes[id] = { ...node, ...(changes ?? {}) };
  saveState(state);
  return state.nodes[id];
}

// Creates, saves, and returns a new child node under parentId, or null if parent is missing.
export function addNode(parentId, label, description) {
  const state = loadState();
  if (!state || !state.nodes || !parentId) return null;
  const parent = state.nodes[parentId];
  if (!parent) return null;

  const now = new Date().toISOString();
  const child = {
    id: crypto.randomUUID(),
    parentId,
    label: label ?? "",
    description: description ?? "",
    depth: (parent.depth ?? 0) + 1,
    status: parent.depth === 0 ? "active" : "locked",
    attempts: 0,
    createdAt: now,
    completedAt: null,
  };

  state.nodes[child.id] = child;
  saveState(state);
  return child;
}

// Returns an array of nodes whose parentId matches the provided id.
export function getChildren(parentId) {
  const state = loadState();
  if (!state || !state.nodes) return [];
  return Object.values(state.nodes).filter((node) => node?.parentId === parentId);
}

// Returns the root node (the node with parentId null), or null when absent.
export function getRootNode() {
  const state = loadState();
  if (!state || !state.nodes) return null;
  return (
    Object.values(state.nodes).find((node) => node && node.parentId === null) ?? null
  );
}

// Removes all persisted grove state from localStorage and returns true when attempted.
export function clearState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// Increments attempts for a node, saves state, and returns the updated node.
export function incrementAttempts(id) {
  const state = loadState();
  if (!state || !state.nodes || !id) return null;
  const node = state.nodes[id];
  if (!node) return null;

  const nextAttempts = (node.attempts ?? 0) + 1;

  state.nodes[id] = {
    ...node,
    attempts: nextAttempts,
  };

  saveState(state);
  return state.nodes[id];
}

