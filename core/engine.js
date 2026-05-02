/**
 * Grove core engine: prompts and response parsing for socratic questioning and answer evaluation.
 * No network calls and no storage — callers attach these strings to their LLM requests.
 */

// System instructions for Phase 1 — one probing pedagogical question, JSON-only output.
export const PHASE1_SYSTEM_PROMPT = `You are Grove's pedagogical question engine.

PHASE 1 — SOCRATIC QUESTION GENERATION

Your task is to ask ONE high-quality question that tests understanding of the current node in context of the learning tree.

Question quality rules:
- Never ask a trivial definition question like "What is X?"
- Do not ask yes/no questions.
- Require explanation, reasoning, and transfer of understanding.
- Include at least one of: comparison, analogy, concrete example, or application to a scenario.
- Adapt depth:
  - depth 1: clear conceptual understanding with a small example
  - depth 2+: ask for mechanism, trade-offs, failure cases, or cross-concept links
- Keep it concise and natural, but intellectually demanding.
- Use tree context and progress context when available to make the question progressive.

You are probing understanding, not giving lessons.

Return ONLY valid JSON with this exact shape (no markdown, no prose outside JSON):

{"type":"question","question":"..."}`;

// System instructions for Phase 2 — strict but educational evaluation, JSON-only output.
export const PHASE2_SYSTEM_PROMPT = `You are Grove's learning evaluator.

PHASE 2 — ANSWER EVALUATION

You receive node context, learning progress context, and the user's answer.
Evaluate whether the learner demonstrates real understanding.

WHAT COUNTS AS A VALID ANSWER

A valid answer MUST:
- show mechanistic understanding, not just memorized statements
- be written in the learner's own words
- include clear reasoning and concept-specific detail
- connect the concept to examples, contrasts, or applications when depth is higher
- avoid vagueness and unsupported claims

WHAT IS INVALID

Invalid answers:
- are generic and could fit many topics
- are too short to demonstrate understanding
- only restate keywords without explanation
- avoid reasoning, examples, or implications
- contradict core concept logic

FEEDBACK QUALITY (REQUIRED)

Always provide educational feedback, not only pass/fail:
- reason: concise overall judgement
- mistakes: specific misunderstandings or missing elements
- improvements: concrete next actions for improvement
- exampleAnswer: a high-quality concise model answer in plain language

ADAPTIVE DEPTH

- Lower depth nodes: allow simpler but still concrete explanations.
- Higher depth nodes: require stronger reasoning, comparisons, and practical implications.

Return ONLY valid JSON with this exact shape:
{"type":"evaluation","valid":false,"reason":"...","mistakes":["..."],"improvements":["..."],"exampleAnswer":"..."}

Only output JSON. No markdown.`;

// Picks safe fields from a node for prompt context; returns null if node is missing.
export function nodeContextBlock(node) {
  if (!node || typeof node !== "object") return null;
  const label = node.label ?? "";
  const description = node.description ?? "";
  const depth = node.depth ?? 0;
  return `NODE CONTEXT

Title: ${label}
Description: ${description}
Depth: ${depth}`;
}

function treeContextBlock(treeContext) {
  if (!treeContext || typeof treeContext !== "object") return "";
  const parent = treeContext.parentLabel ? `Parent: ${treeContext.parentLabel}` : "Parent: none";
  const children = Array.isArray(treeContext.childLabels) && treeContext.childLabels.length
    ? `Related children: ${treeContext.childLabels.join(", ")}`
    : "Related children: none";
  const prerequisites = Array.isArray(treeContext.prerequisiteLabels) && treeContext.prerequisiteLabels.length
    ? `Prerequisites already covered: ${treeContext.prerequisiteLabels.join(", ")}`
    : "Prerequisites already covered: none";
  return `TREE CONTEXT\n${parent}\n${children}\n${prerequisites}`;
}

// Builds the user message for Phase 1 including optional progress context.
export function buildQuestionUserMessage(node, userProgressContext = "") {
  const block = nodeContextBlock(node);
  const context = treeContextBlock(node?.treeContext);
  if (!block) {
    return userProgressContext
      ? `USER PROGRESS CONTEXT\n${userProgressContext}\n\nGenerate the question JSON.`
      : "Generate the question JSON.";
  }
  const progress =
    userProgressContext && String(userProgressContext).trim()
      ? `\n\nUSER PROGRESS CONTEXT\n${String(userProgressContext).trim()}`
      : "";
  return `${block}${context ? `\n\n${context}` : ""}${progress}

Generate ONE pedagogical question that checks real understanding.
Do not ask a pure definition question. Output JSON only.`;
}

// Builds the user message for Phase 2 including the answer and optional progress context.
export function buildEvaluationUserMessage(node, answer, userProgressContext = "") {
  const block = nodeContextBlock(node);
  const context = treeContextBlock(node?.treeContext);
  const answerText = answer == null ? "" : String(answer);
  const progress =
    userProgressContext && String(userProgressContext).trim()
      ? `\n\nUSER PROGRESS CONTEXT\n${String(userProgressContext).trim()}`
      : "";

  if (!block) {
    return `User answer:\n${answerText}${progress}

Evaluate per system rules. Output JSON only.`;
  }

  return `${block}${context ? `\n\n${context}` : ""}

User answer:
${answerText}${progress}

Evaluate per system rules. Output JSON only.`;
}

// Returns { system, user } ready for an LLM request for Phase 1.
export function createQuestionRequest(node, userProgressContext) {
  return {
    system: PHASE1_SYSTEM_PROMPT,
    user: buildQuestionUserMessage(node, userProgressContext),
  };
}

// Returns { system, user } ready for an LLM request for Phase 2.
export function createEvaluationRequest(node, answer, userProgressContext) {
  return {
    system: PHASE2_SYSTEM_PROMPT,
    user: buildEvaluationUserMessage(node, answer, userProgressContext),
  };
}

// Trims optional markdown fences and parses JSON; returns null if invalid.
function parseJsonObject(raw) {
  if (raw == null || typeof raw !== "string") return null;
  let text = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
  if (fence) text = fence[1].trim();
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Parses model output for Phase 1; returns { type, question } or null.
export function parseQuestionResponse(raw) {
  const obj = parseJsonObject(raw);
  if (!obj || obj.type !== "question") return null;
  const question = obj.question;
  if (typeof question !== "string" || !question.trim()) return null;
  return { type: "question", question: question.trim() };
}

// Parses model output for Phase 2; returns { type, valid, reason } or null.
export function parseEvaluationResponse(raw) {
  const obj = parseJsonObject(raw);
  if (!obj || obj.type !== "evaluation") return null;
  if (typeof obj.valid !== "boolean") return null;
  const reason = obj.reason;
  if (typeof reason !== "string" || !reason.trim()) return null;
  const mistakes = Array.isArray(obj.mistakes)
    ? obj.mistakes.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
    : [];
  const improvements = Array.isArray(obj.improvements)
    ? obj.improvements.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
    : [];
  const exampleAnswer =
    typeof obj.exampleAnswer === "string" && obj.exampleAnswer.trim()
      ? obj.exampleAnswer.trim()
      : "";

  return {
    type: "evaluation",
    valid: obj.valid,
    reason: reason.trim(),
    mistakes,
    improvements,
    exampleAnswer,
  };
}
