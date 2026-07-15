// functions/api/process-inquiries.js
//
// Jozey — BrainDoption Agent Processing Endpoint
//
// Triggered manually or on a schedule by GitHub Actions (Phase 8 workflow).
// Reads unprocessed submissions from FORM_SUBMISSIONS KV, runs each through
// the locked pipeline (language -> tone -> skill match -> urgency -> action),
// and writes the result back to KV.
//
// Bindings required (already configured in Cloudflare Pages Settings):
//   - FORM_SUBMISSIONS  (KV namespace)
//   - AGENT_CONFIG      (KV namespace)
//   - ANTHROPIC_API_KEY (environment secret)

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

export async function onRequestPost(context) {
  return handle(context);
}

// Allow GET too, so it can be triggered with a simple fetch/curl from
// GitHub Actions without needing to send a body.
export async function onRequestGet(context) {
  return handle(context);
}

async function handle(context) {
  const { env } = context;

  try {
    const settings = await loadSettings(env);
    const skills = await loadSkills(env);

    const list = await env.FORM_SUBMISSIONS.list();
    const results = [];

    for (const key of list.keys) {
      const raw = await env.FORM_SUBMISSIONS.get(key.name);
      if (!raw) continue;

      const submission = JSON.parse(raw);
      if (submission.processed) continue; // already handled

      const outcome = await processSubmission(submission, settings, skills, env);

      const updated = {
        ...submission,
        processed: true,
        processedAt: new Date().toISOString(),
        agent: outcome,
      };

      await env.FORM_SUBMISSIONS.put(key.name, JSON.stringify(updated));
      results.push({ key: key.name, urgency: outcome.urgency_level, action: outcome.action });
    }

    return new Response(
      JSON.stringify({ ok: true, processed: results.length, results }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

async function loadSettings(env) {
  const raw = await env.AGENT_CONFIG.get("settings");
  if (!raw) throw new Error("AGENT_CONFIG missing 'settings' entry");
  return JSON.parse(raw);
}

async function loadSkills(env) {
  const list = await env.AGENT_CONFIG.list({ prefix: "skill_" });
  const skills = [];
  for (const key of list.keys) {
    const raw = await env.AGENT_CONFIG.get(key.name);
    if (raw) skills.push(JSON.parse(raw));
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function processSubmission(submission, settings, skills, env) {
  const classification = await classify(submission, settings, skills, env);

  const skill =
    skills.find((s) => s.id === classification.matched_skill_id) ||
    skills.find((s) => s.id === "universal_fallback");

  const urgency = classification.urgency_level;
  const tone = classification.tone;
  const language = classification.language;

  const replyTemplate =
    (skill.tone_variants && (skill.tone_variants[tone] || skill.tone_variants.default)) ||
    "Thank you for your inquiry. We will respond shortly.";

  const visitorMessage = fillTemplate(replyTemplate, {
    firstName: submission.firstName || "there",
    inquiryType: submission.inquiryType || "your inquiry",
    sla_response_time_hours: skill.sla_response_time_hours ?? settings.sla_response_time_hours,
  });

  const shouldEmailEscalate =
    skill.allowed_action !== "auto_reply" &&
    urgencyMeetsThreshold(urgency, settings.email_escalation_min_urgency);

  return {
    language,
    tone,
    matched_skill_id: skill.id,
    confidence: classification.confidence,
    urgency_level: urgency,
    urgency_score: classification.urgency_score,
    action: skill.allowed_action,
    visitor_message: visitorMessage,
    escalation: {
      dashboard: true,
      email: shouldEmailEscalate,
      reason: skill.escalation_reason || null,
      deadline: addHours(
        submission.submittedAt,
        skill.sla_response_time_hours ?? settings.sla_response_time_hours
      ),
      analysis: classification.analysis_note,
    },
  };
}

const URGENCY_ORDER = ["low", "medium", "high", "critical"];

function urgencyMeetsThreshold(level, minLevel) {
  return URGENCY_ORDER.indexOf(level) >= URGENCY_ORDER.indexOf(minLevel);
}

function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    values[key] !== undefined ? values[key] : `{${key}}`
  );
}

function addHours(isoString, hours) {
  if (!isoString) return null;
  const date = new Date(isoString);
  date.setHours(date.getHours() + Number(hours || 0));
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// Claude classification call (language, tone, skill match, urgency)
// ---------------------------------------------------------------------------

async function classify(submission, settings, skills, env) {
  const skillSummaries = skills.map((s) => ({
    id: s.id,
    name: s.name,
    triggers: s.triggers,
    confidence_threshold: s.confidence_threshold,
  }));

  const prompt = `You are the classification stage of an inquiry-triage agent called Jozey.

Analyze this contact-form submission and return ONLY a JSON object, no preamble, no markdown fences.

Submission:
${JSON.stringify(
  {
    firstName: submission.firstName,
    lastName: submission.lastName,
    organisation: submission.organisation,
    role: submission.role,
    country: submission.country,
    email: submission.email,
    inquiryType: submission.inquiryType,
    message: submission.message,
  },
  null,
  2
)}

Available skills (choose the best match by id, or "universal_fallback" if none fit well):
${JSON.stringify(skillSummaries, null, 2)}

Urgency scoring factors (weighted, sum to a 0-100+ score, map to bands):
  - inquiry_type_weight: e.g. Partnership Inquiry = +30
  - keyword_signals: e.g. "urgent", "deadline" = +20
  - complexity_flag: ambiguous or needs clarification = +15
Bands: low 0-30, medium 31-60, high 61-85, critical 86+

Supported languages: ${JSON.stringify(settings.supported_languages)}
Default language: ${settings.default_language}

Return exactly this JSON shape:
{
  "language": "en" | "fr",
  "tone": "default" | "warm" | "concise" | "urgent",
  "matched_skill_id": "string",
  "confidence": 0.0,
  "urgency_score": 0,
  "urgency_level": "low" | "medium" | "high" | "critical",
  "analysis_note": "one or two sentence internal note for the human reviewer"
}`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text response from classifier");

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}
