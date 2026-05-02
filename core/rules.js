const ALLOWED_STATUSES = ["locked", "active", "bloomed"];

// Returns true when a locked node has a valid bloomed parent and can become active.
export function canActivate(node, nodes) {
  if (!node || !nodes || typeof nodes !== "object") return false;
  if (node.status !== "locked") return false;
  if (!node.parentId) return false;

  const parent = nodes[node.parentId];
  if (!parent) return false;

  return parent.status === "bloomed";
}

// Returns true when a node is active and eligible for verification attempts.
export function canAttemptVerification(node) {
  if (!node) return false;
  return node.status === "active";
}

// Returns true when attempts suggest weak understanding for this depth/context.
export function needsReview(node, nodes = null) {
  if (!node) return false;
  const attempts = node.attempts ?? 0;
  const depth = node.depth ?? 0;
  const threshold = depth >= 3 ? 2 : depth >= 2 ? 3 : 4;

  if (attempts >= threshold) return true;
  if (attempts >= 2 && hasWeakPrerequisiteSignal(node, nodes)) return true;
  return false;
}

// Returns true when a node is active and can transition to bloomed.
export function canBloom(node) {
  if (!node) return false;
  return node.status === "active";
}

// Returns true when nearby prerequisite nodes suggest shaky foundations.
function hasWeakPrerequisiteSignal(node, nodes) {
  if (!node || !nodes || typeof nodes !== "object") return false;
  const parent = node.parentId ? nodes[node.parentId] : null;
  if (!parent) return false;
  return (parent.attempts ?? 0) >= 3;
}

// Returns direct locked children that are now valid to activate after parent blooms.
export function getActivatableChildren(parentNode, nodes) {
  if (!parentNode || !nodes || typeof nodes !== "object") return [];
  if (parentNode.status !== "bloomed") return [];

  return Object.values(nodes).filter(
    (candidate) =>
      candidate &&
      candidate.parentId === parentNode.id &&
      candidate.status === "locked" &&
      canActivate(candidate, nodes)
  );
}

// Returns true only when every non-root node in the tree has bloomed.
export function isTreeComplete(nodes) {
  if (!nodes || typeof nodes !== "object") return false;

  const nonRootNodes = Object.values(nodes).filter(
    (node) => node && node.depth !== 0
  );

  if (nonRootNodes.length === 0) return true;

  return nonRootNodes.every((node) => node.status === "bloomed");
}

// Returns aggregate progress counts and completion percentage for non-root nodes.
export function getProgress(nodes) {
  if (!nodes || typeof nodes !== "object") {
    return {
      total: 0,
      bloomed: 0,
      active: 0,
      locked: 0,
      percentage: 0,
    };
  }

  const nonRootNodes = Object.values(nodes).filter(
    (node) => node && node.depth !== 0
  );

  const total = nonRootNodes.length;
  const bloomed = nonRootNodes.filter((node) => node.status === "bloomed").length;
  const active = nonRootNodes.filter((node) => node.status === "active").length;
  const locked = nonRootNodes.filter((node) => node.status === "locked").length;

  return {
    total,
    bloomed,
    active,
    locked,
    percentage: total === 0 ? 0 : Math.round((bloomed / total) * 100),
  };
}

// Validates a requested status transition and returns an allow/deny decision with reason.
export function validateTransition(node, targetStatus, nodes) {
  if (!node) {
    return {
      allowed: false,
      reason: "Transition denied: node does not exist.",
    };
  }

  if (node.status === targetStatus) {
    return {
      allowed: false,
      reason: `Transition denied: node is already "${targetStatus}".`,
    };
  }

  if (!ALLOWED_STATUSES.includes(targetStatus)) {
    return {
      allowed: false,
      reason: 'Transition denied: target status must be "locked", "active", or "bloomed".',
    };
  }

  if (targetStatus === "locked") {
    return {
      allowed: false,
      reason: 'Transition denied: nodes cannot transition back to "locked".',
    };
  }

  if (targetStatus === "active") {
    const allowed = canActivate(node, nodes);
    return {
      allowed,
      reason: allowed
        ? 'Transition allowed: node can become "active" because its parent is bloomed.'
        : 'Transition denied: node must be "locked" with a valid parent in "bloomed" status.',
    };
  }

  const allowed = canBloom(node);
  return {
    allowed,
    reason: allowed
      ? 'Transition allowed: active node can become "bloomed".'
      : 'Transition denied: only nodes in "active" status can become "bloomed".',
  };
}

