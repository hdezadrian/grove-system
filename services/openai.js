const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

const QUESTION_SYSTEM_PROMPT = `You are Grove, a calm and educational learning guide.

Task: generate one conceptual question that helps a learner deepen understanding.

Rules:
- Ask exactly one question.
- Avoid trivia and pure definition prompts like "What is X?"
- Use a Socratic style: invite reasoning, comparison, analogy, or application.
- Adapt to node depth:
  - low depth: concrete understanding + simple example
  - higher depth: mechanism, trade-offs, edge cases, or transfer
- Keep tone warm and educational, not exam-like.

Return JSON only:
{"question":"..."}`

const EVALUATION_SYSTEM_PROMPT = `You are Grove, a calm and strict conceptual evaluator.

Task: evaluate whether the learner's answer shows real understanding.

Evaluation principles:
- Reward conceptual clarity and correct reasoning.
- Reject vague, generic, or keyword-only answers.
- Be brief and constructive.

Return JSON only:
{"valid":true,"reason":"short explanation"}`

function safeText(value) {
  return value == null ? "" : String(value).trim();
}

function nodeContext(node) {
  const label = safeText(node?.label || "Untitled concept");
  const description = safeText(node?.description || "No description provided.");
  const depth = Number.isFinite(node?.depth) ? node.depth : 0;

  return `NODE
Title: ${label}
Description: ${description}
Depth: ${depth}`;
}

function normalizeProgress(progress) {
  const p = safeText(progress);
  return p ? `\n\nPROGRESS\n${p}` : "";
}

export function createQuestionRequest(node, progress = "") {
  const user = `${nodeContext(node)}${normalizeProgress(progress)}

Generate one conceptual question that helps the learner explain the idea in their own words.
Return JSON only.`;

  return {
    system: QUESTION_SYSTEM_PROMPT,
    user,
  };
}

export function createEvaluationRequest(node, answer, progress = "") {
  const user = `${nodeContext(node)}${normalizeProgress(progress)}

LEARNER_ANSWER
${safeText(answer)}

Evaluate conceptual correctness and reasoning quality.
Return JSON only.`;

  return {
    system: EVALUATION_SYSTEM_PROMPT,
    user,
  };
}

function extractFirstJSONObject(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;

  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const stripped = fenceMatch ? fenceMatch[1].trim() : text;

  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* continue to fallback extraction */
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        const candidate = stripped.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch {
          /* keep scanning */
        }
      }
    }
  }

  return null;
}

export function parseQuestionResponse(raw) {
  const obj = extractFirstJSONObject(raw);
  if (!obj) return null;
  const question = safeText(obj.question);
  if (!question) return null;
  return { question };
}

export function parseEvaluationResponse(raw) {
  const obj = extractFirstJSONObject(raw);
  if (!obj) return null;
  if (typeof obj.valid !== "boolean") return null;
  const reason = safeText(obj.reason);
  if (!reason) return null;
  return { valid: obj.valid, reason };
}

export async function chatCompletion({ system, user, apiKey, signal }) {
  const token = safeText(apiKey);
  if (!token) {
    throw new Error("Missing API key");
  }

  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: safeText(system) },
          { role: "user", content: safeText(user) },
        ],
      }),
      signal,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("Invalid API key");
      }
      if (response.status === 429) {
        throw new Error("Too many requests");
      }

      let message = "OpenAI request failed";
      try {
        const err = await response.json();
        const apiMessage = safeText(err?.error?.message);
        if (apiMessage) message = apiMessage;
      } catch {
        /* keep generic message */
      }
      throw new Error(message);
    }

    const data = await response.json();
    const content = safeText(data?.choices?.[0]?.message?.content);
    if (!content) {
      throw new Error("Malformed OpenAI response");
    }
    return content;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error instanceof TypeError) {
      throw new Error("Connection error");
    }
    throw error;
  }
}

export default {
  chatCompletion,
  createQuestionRequest,
  createEvaluationRequest,
  parseQuestionResponse,
  parseEvaluationResponse,
};

