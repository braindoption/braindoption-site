// functions/api/process-inquiries.js
//
// Jozey — BrainDoption Agent Processing Endpoint
//
// Triggered manually or on a schedule by GitHub Actions (Phase 8 workflow).
// Reads unprocessed submissions from FORM_SUBMISSIONS KV, runs each through
// the locked pipeline (language -> tone -> skill match -> urgency -> action),
// sends the visitor acknowledgment + owner escalation emails via Resend, and
// writes the full result back to KV.
//
// Bindings required (Cloudflare Pages Settings):
//   - FORM_SUBMISSIONS  (KV namespace)
//   - AGENT_CONFIG      (KV namespace)
//   - ANTHROPIC_API_KEY (environment secret)
//   - RESEND_API_KEY    (environment secret)
//
// AGENT_CONFIG KV entries expected:
//   - settings              (agent_name, agent_signature, owner_name,
//                             owner_email, agent_identity_email,
//                             classifier_model, fallback_model, ...)
//   - language_strings       (per-language greeting/closing/bilingual copy)
//   - skill_<id>              (one or more skill definitions)
//
// NOTE: No agent name, owner name, or language copy is hardcoded below —
// all of it is read from AGENT_CONFIG so it stays fully configurable.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const RESEND_API_URL = "https://api.resend.com/emails";

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
    const languageStrings = await loadLanguageStrings(env);
    const skills = await loadSkills(env);

    const list = await env.FORM_SUBMISSIONS.list();
    const results = [];

    for (const key of list.keys) {
      const raw = await env.FORM_SUBMISSIONS.get(key.name);
      if (!raw) continue;

      const submission = JSON.parse(raw);
      if (submission.processed) continue; // already handled

      const outcome = await processSubmission(
        submission,
        settings,
        languageStrings,
        skills,
        env
      );
      const emailResult = await sendEmails(submission, outcome, settings, env);

      const updated = {
        ...submission,
        processed: true,
        processedAt: new Date().toISOString(),
        agent: outcome,
        emailed: emailResult,
      };

      await env.FORM_SUBMISSIONS.put(key.name, JSON.stringify(updated));
      results.push({
        key: key.name,
        urgency: outcome.urgency_level,
        action: outcome.action,
      });
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

async function loadLanguageStrings(env) {
  const raw = await env.AGENT_CONFIG.get("language_strings");
  if (!raw) throw new Error("AGENT_CONFIG missing 'language_strings' entry");
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

async function processSubmission(submission, settings, languageStrings, skills, env) {
  const classification = await classify(submission, settings, skills, env);

  const skill =
    skills.find((s) => s.id === classification.matched_skill_id) ||
    skills.find((s) => s.id === "universal_fallback");

  const urgency = classification.urgency_level;
  const tone = classification.tone;
  const language = classification.language; // final decision, after cross-check
  const languageConflict = classification.language_conflict === true;

  const replyTemplate =
    (skill.tone_variants && (skill.tone_variants[tone] || skill.tone_variants.default)) ||
    "Thank you for your inquiry. We will respond shortly.";

  let body = fillTemplate(replyTemplate, {
    firstName: submission.firstName || "",
    inquiryType: submission.inquiryType || "your inquiry",
    sla_response_time_hours: skill.sla_response_time_hours ?? settings.sla_response_time_hours,
  });

  if (classification.needs_clarifying_question && classification.clarifying_question) {
    body += `\n\n${classification.clarifying_question}`;
  }

  // Locked language rule: message + country signals cross-checked during
  // classification (email domain deliberately excluded from that decision).
  // If they agreed on French, translate the body. If they conflicted or
  // were ambiguous, we stay in English and add one polite bilingual line.
  let finalLanguage = language;
  if (language === "fr") {
    body = await translateText(body, "French", settings, env);
  } else if (languageConflict) {
    const bilingual = languageStrings.en && languageStrings.en.bilingual_invite;
    if (bilingual) body += `\n\n${bilingual}`;
  }

  const strings = languageStrings[finalLanguage] || languageStrings.en;
  const visitorMessage = composeVisitorEmail({
    greeting: strings.greeting,
    firstName: submission.firstName || "",
    body,
    closing: strings.closing,
    agentSignature: settings.agent_signature,
  });

  const shouldEmailEscalate =
    skill.allowed_action !== "auto_reply" &&
    urgencyMeetsThreshold(urgency, settings.email_escalation_min_urgency);

  return {
    language: finalLanguage,
    language_conflict: languageConflict,
    tone,
    matched_skill_id: skill.id,
    confidence: classification.confidence,
    urgency_level: urgency,
    urgency_score: classification.urgency_score,
    action: skill.allowed_action,
    visitor_message: visitorMessage,
    executive_summary: classification.executive_summary,
    next_action_objectives: classification.next_action_objectives || [],
    message_keywords: classification.message_keywords || [],
    reply_keywords: classification.reply_keywords || [],
    needs_clarifying_question: classification.needs_clarifying_question,
    clarifying_question: classification.clarifying_question,
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

function composeVisitorEmail({ greeting, firstName, body, closing, agentSignature }) {
  const greetingLine = firstName ? `${greeting} ${firstName},` : `${greeting},`;
  return [greetingLine, "", body, "", closing, "", agentSignature].join("\n");
}

// ---------------------------------------------------------------------------
// Claude calls (classification + translation), with model fallback
// ---------------------------------------------------------------------------

async function callClaude(prompt, maxTokens, settings, env) {
  const primaryModel = settings.classifier_model;
  const fallbackModel = settings.fallback_model;

  try {
    return await callClaudeWithModel(prompt, maxTokens, primaryModel, env);
  } catch (err) {
    if (!fallbackModel || fallbackModel === primaryModel) throw err;
    // Primary model unavailable/deprecated — retry once with the configured
    // fallback rather than failing the whole submission.
    return await callClaudeWithModel(prompt, maxTokens, fallbackModel, env);
  }
}

async function callClaudeWithModel(prompt, maxTokens, model, env) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}) using model ${model}: ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error(`No text response from model ${model}`);
  return textBlock.text;
}

async function classify(submission, settings, skills, env) {
  const skillSummaries = skills.map((s) => ({
    id: s.id,
    name: s.name,
    triggers: s.triggers,
    confidence_threshold: s.confidence_threshold,
  }));

  const prompt = `You are the classification stage of an inquiry-triage agent called ${settings.agent_name}.

Analyze this contact-form submission and return ONLY a JSON object, no preamble, no markdown fences.

Submission:
${JSON.stringify(
  {
    firstName: submission.firstName,
    lastName: submission.lastName,
    organisation: submission.organisation,
    role: submission.role,
    country: submission.country,
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

LANGUAGE DECISION (do this carefully):
  - message_signal: the language the visitor actually wrote their message in.
  - country_signal: "fr" if the stated "country" field is a primarily
    French-speaking country (e.g. France, Belgium, Switzerland, Canada-Quebec
    context, several African nations), otherwise "en".
  - IMPORTANT: base country_signal ONLY on the "country" field's text value.
    Do NOT use the visitor's email domain/TLD as a signal — it is not
    provided to you here, and must never factor into this decision.
  - If message_signal and country_signal AGREE on "fr", set "language": "fr"
    and "language_conflict": false.
  - If they agree on "en", set "language": "en" and "language_conflict": false.
  - If they DISAGREE or country is ambiguous/unknown, default "language" to
    "en" and set "language_conflict": true.

CLARIFYING QUESTION:
  - If the inquiry is beyond what a generic acknowledgment can address, set
    "needs_clarifying_question": true and provide exactly ONE short, specific
    "clarifying_question" (in English; it will be translated if needed).
    Otherwise set "needs_clarifying_question": false and
    "clarifying_question": null.

EXECUTIVE SUMMARY (for a quick-glance internal email — this is NOT the
visitor-facing reply):
  - "executive_summary": ONE short, plain sentence describing who this is
    and what they want. No filler, no pleasantries — information density
    over completeness. Written for someone scanning in 5 seconds.
  - "next_action_objectives": an array of 0-4 short bullet-style strings
    (a few words each) describing what the first follow-up conversation
    should aim to establish. Only include this if genuinely useful beyond
    the summary — leave as an empty array if there is nothing worth adding.

KEYWORDS (for later visual highlighting — pick independently for each):
  - "message_keywords": 2-5 short key terms/phrases copied EXACTLY as they
    appear in the visitor's message, in the same language they wrote in.
    Pick the most business-critical nouns/phrases (the core ask, the
    product/industry term, a deadline word) — not generic filler words.
  - "reply_keywords": 2-5 short key terms/phrases that are likely to
    appear in the acknowledgment reply and address the visitor's actual
    concern, IN THE TARGET LANGUAGE given by your "language" field above.
    These do NOT need to match message_keywords verbatim — a good reply
    often uses different words for the same concern (e.g. the visitor
    says "tarifs", the reply may say "budget" or "devis") — pick whichever
    terms best signal that the reply is addressing what was asked.

Return exactly this JSON shape:
{
  "language": "en" | "fr",
  "language_conflict": true | false,
  "tone": "default" | "warm" | "concise" | "urgent",
  "matched_skill_id": "string",
  "confidence": 0.0,
  "urgency_score": 0,
  "urgency_level": "low" | "medium" | "high" | "critical",
  "needs_clarifying_question": true | false,
  "clarifying_question": "string or null",
  "analysis_note": "one or two sentence internal note for the human reviewer",
  "executive_summary": "string",
  "next_action_objectives": ["string", "string"],
  "message_keywords": ["string", "string"],
  "reply_keywords": ["string", "string"]
}`;

  const text = await callClaude(prompt, 700, settings, env);
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

async function translateText(text, targetLanguageName, settings, env) {
  const prompt = `Translate the following business email message into natural, professional ${targetLanguageName}. Keep names, numbers, and line breaks intact. Return ONLY the translated text, no preamble, no quotes.

${text}`;

  try {
    return await callClaude(prompt, 500, settings, env);
  } catch (err) {
    // Fail safe to the original text rather than breaking the whole pipeline
    // for this submission if translation fails for any reason.
    return text;
  }
}

// ---------------------------------------------------------------------------
// Phase 10 — Email sending via Resend
// ---------------------------------------------------------------------------

async function sendEmails(submission, outcome, settings, env) {
  const result = { visitor_sent: false, owner_sent: false, errors: [] };

  try {
    await sendResendEmail(env, {
      from: `${settings.agent_name} <${settings.agent_identity_email}>`,
      to: submission.email,
      subject: `Re: Your inquiry to BrainDoption (${submission.inquiryType || "General Inquiry"})`,
      text: outcome.visitor_message,
    });
    result.visitor_sent = true;
  } catch (err) {
    result.errors.push(`visitor email failed: ${err.message}`);
  }

  if (outcome.escalation.email) {
    try {
      const html = buildEscalationEmailHtml(submission, outcome, settings);
      const text = buildEscalationEmailText(submission, outcome, settings);
      const urgencyTag = outcome.urgency_level.toUpperCase();

      await sendResendEmail(env, {
        from: `${settings.agent_name} <${settings.agent_identity_email}>`,
        to: settings.owner_email,
        subject: `[${urgencyTag}] New Inquiry — ${submission.inquiryType || "General Inquiry"} — ${submission.firstName || ""} ${submission.lastName || ""}`,
        html,
        text,
      });
      result.owner_sent = true;
    } catch (err) {
      result.errors.push(`owner escalation email failed: ${err.message}`);
    }
  }

  return result;
}

async function sendResendEmail(env, { from, to, subject, text, html }) {
  const payload = { from, to, subject };
  if (text) payload.text = text;
  if (html) payload.html = html;

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend API error (${response.status}): ${errText}`);
  }

  return response.json();
}

const URGENCY_ICON = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" };

function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function nl2br(str) {
  return esc(str).replace(/\n/g, "<br/>");
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Bolds any of `keywords` found (case-insensitive) inside `text`, after
// HTML-escaping the text. Keywords that don't literally appear are simply
// skipped rather than breaking the output.
function highlightKeywords(text, keywords) {
  const escaped = nl2br(text);
  if (!keywords || keywords.length === 0) return escaped;

  const sorted = [...keywords].filter(Boolean).sort((a, b) => b.length - a.length);
  let result = escaped;
  for (const kw of sorted) {
    const pattern = new RegExp(`(${escapeRegex(esc(kw))})`, "gi");
    result = result.replace(pattern, "<strong>$1</strong>");
  }
  return result;
}

function buildEscalationEmailHtml(submission, outcome, settings) {
  const urgencyLabel = outcome.urgency_level.charAt(0).toUpperCase() + outcome.urgency_level.slice(1);
  const urgencyIcon = URGENCY_ICON[outcome.urgency_level] || "⚪";
  const inquiryType = submission.inquiryType || "General Inquiry";
  const fullName = `${submission.firstName || ""} ${submission.lastName || ""}`.trim();

  const clarificationText = outcome.needs_clarifying_question
    ? esc(outcome.clarifying_question)
    : "Not applicable";

  const sectionTitle = (icon, title) =>
    `<tr><td style="padding:16px 0 6px 0;"><span style="font-size:16px;">${icon}</span> <span style="font-size:15px;font-weight:700;color:#1a1a1a;">${title}</span></td></tr>
     <tr><td style="border-bottom:1px solid #ececec;padding-bottom:8px;"></td></tr>`;

  const fieldRow = (label, value) =>
    `<tr>
       <td style="padding:3px 12px 3px 0;font-weight:600;color:#444;vertical-align:top;white-space:nowrap;font-size:14px;">${esc(label)}</td>
       <td style="padding:3px 0;color:#111;font-size:14px;">${value}</td>
     </tr>`;

  const objectivesBlock =
    outcome.next_action_objectives && outcome.next_action_objectives.length > 0
      ? `
    ${sectionTitle("✅", "Recommended Next Action")}
    <tr><td>
      <ul style="font-size:14px;margin:0 0 8px 16px;padding:0;line-height:1.5;">
        ${outcome.next_action_objectives.map((item) => `<li style="margin-bottom:3px;">${esc(item)}</li>`).join("")}
      </ul>
    </td></tr>`
      : "";

  return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;margin:0 auto;color:#1a1a1a;">

  <table width="100%" cellpadding="0" cellspacing="0">
    ${sectionTitle("📥", "New Inquiry Received")}
    <tr><td style="padding:4px 0 2px 0;font-size:13px;color:#666;">
      Subject: [${esc(urgencyLabel.toUpperCase())}] New Inquiry — ${esc(inquiryType)} — ${esc(fullName)}
    </td></tr>

    ${sectionTitle("⚡", "Inquiry Priority (SLA)")}
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${fieldRow("Priority", `${urgencyIcon} ${esc(urgencyLabel)} (Score: ${esc(outcome.urgency_score)})`)}
        ${fieldRow("Response Deadline", esc(outcome.escalation.deadline))}
      </table>
    </td></tr>

    ${sectionTitle("📌", "Executive Summary")}
    <tr><td style="font-size:14px;line-height:1.6;padding-bottom:6px;">
      <p style="margin:0 0 8px 0;">${nl2br(outcome.executive_summary)}</p>
      <p style="margin:0 0 8px 0;"><strong>Recommended routing:</strong> ${esc(settings.owner_name)}</p>
      <p style="margin:0;"><strong>Clarification required:</strong> ${clarificationText}</p>
    </td></tr>

    ${sectionTitle("👤", "Customer Information")}
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${fieldRow("Name", esc(fullName))}
        ${fieldRow("Organisation", esc(submission.organisation))}
        ${fieldRow("Role", esc(submission.role))}
        ${fieldRow("Country", esc(submission.country))}
        ${fieldRow("Email", `<a href="mailto:${esc(submission.email)}" style="color:#1a56db;">${esc(submission.email)}</a>`)}
        ${fieldRow("Inquiry Type", esc(inquiryType))}
      </table>
    </td></tr>

    ${sectionTitle("💬", "Customer Message")}
    <tr><td style="font-size:14px;line-height:1.6;border-left:2px solid #e5e5e5;padding:4px 0 4px 10px;">
      ${highlightKeywords(submission.message, outcome.message_keywords)}
    </td></tr>

    ${sectionTitle("📧", `Draft Reply Prepared by ${esc(settings.agent_name)}`)}
    <tr><td style="font-size:14px;line-height:1.6;">
      ${highlightKeywords(outcome.visitor_message, outcome.reply_keywords)}
    </td></tr>
    ${objectivesBlock}

  </table>
</div>`.trim();
}

function buildEscalationEmailText(submission, outcome, settings) {
  const fullName = `${submission.firstName || ""} ${submission.lastName || ""}`.trim();
  const clarificationText = outcome.needs_clarifying_question
    ? outcome.clarifying_question
    : "Not applicable";

  const lines = [
    `NEW INQUIRY RECEIVED`,
    ``,
    `INQUIRY PRIORITY (SLA)`,
    `Priority: ${outcome.urgency_level} (score: ${outcome.urgency_score})`,
    `Response deadline: ${outcome.escalation.deadline}`,
    ``,
    `EXECUTIVE SUMMARY`,
    outcome.executive_summary,
    ``,
    `Recommended routing: ${settings.owner_name}`,
    `Clarification required: ${clarificationText}`,
    ``,
    `CUSTOMER INFORMATION`,
    `Name: ${fullName}`,
    `Organisation: ${submission.organisation || ""}`,
    `Role: ${submission.role || ""}`,
    `Country: ${submission.country || ""}`,
    `Email: ${submission.email || ""}`,
    `Inquiry type: ${submission.inquiryType || ""}`,
    ``,
    `CUSTOMER MESSAGE`,
    submission.message || "",
    ``,
    `DRAFT REPLY PREPARED BY ${settings.agent_name.toUpperCase()}`,
    outcome.visitor_message,
  ];

  if (outcome.next_action_objectives && outcome.next_action_objectives.length > 0) {
    lines.push(``, `RECOMMENDED NEXT ACTION`, ...outcome.next_action_objectives.map((o) => `- ${o}`));
  }

  return lines.join("\n");
}
