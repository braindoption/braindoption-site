// functions/api/skills-config.js
//
// Jozey Dashboard — Skills & Rules editor endpoint.
//
// Reads/writes the AGENT_CONFIG.skill_<id> entries that
// process-inquiries.js already consumes directly — this is a thin CRUD
// layer over the same KV entries, not a separate store.
//
// GET  -> list all skills (universal_fallback always included, built-in)
// POST -> { action: "save", skill: {...} }   create or overwrite a skill
//         { action: "delete", id: "..." }    remove a custom skill
//
// Bindings required (Cloudflare Pages Settings):
//   - AGENT_CONFIG  (KV namespace)

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const skills = await loadAllSkills(env);
    return jsonOk({ skills });
  } catch (err) {
    return jsonError(err.message, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  try {
    if (body.action === 'save') return await saveSkill(body.skill, env);
    if (body.action === 'delete') return await deleteSkill(body.id, env);
    return jsonError(`Unknown action: ${body.action}`, 400);
  } catch (err) {
    return jsonError(err.message, 500);
  }
}

async function loadAllSkills(env) {
  const list = await env.AGENT_CONFIG.list({ prefix: 'skill_' });
  const skills = [];
  for (const key of list.keys) {
    const raw = await env.AGENT_CONFIG.get(key.name);
    if (raw) skills.push(toUiShape(JSON.parse(raw)));
  }
  return skills;
}

// Converts the dashboard form's flat shape into the schema
// process-inquiries.js actually reads (id, name, triggers,
// confidence_threshold, allowed_action, sla_response_time_hours,
// tone_variants, escalation_reason).
async function saveSkill(skill, env) {
  if (!skill?.id || !skill?.name) return jsonError('Skill id and name are required', 400);
  if (skill.id === 'universal_fallback') {
    return jsonError('universal_fallback is built-in and cannot be edited here', 400);
  }

  const record = {
    id: skill.id,
    name: skill.name,
    triggers: skill.triggers || [],
    allowed_action: skill.action || 'draft_for_review',
    sla_response_time_hours: Number(skill.sla) || 24,
    confidence_threshold: Number(skill.conf) || 0.75,
    escalation_reason: skill.escalation || null,
    // Only the English/default template is wired — Jozey auto-translates
    // this at send time for French, so a separate manual French template
    // isn't part of the current pipeline (see dashboard notes).
    tone_variants: skill.tone_default ? { default: skill.tone_default } : {},
  };

  await env.AGENT_CONFIG.put(`skill_${skill.id}`, JSON.stringify(record));
  return jsonOk({ skill: toUiShape(record) });
}

async function deleteSkill(id, env) {
  if (!id) return jsonError('Missing id', 400);
  if (id === 'universal_fallback') return jsonError('universal_fallback cannot be removed', 400);
  await env.AGENT_CONFIG.delete(`skill_${id}`);
  return jsonOk({ deleted: id });
}

// Converts a stored skill record back into the flat shape the dashboard UI
// (buildSkills/openAddSkill) already expects.
function toUiShape(record) {
  return {
    id: record.id,
    name: record.name,
    active: true,
    built_in: record.id === 'universal_fallback',
    triggers: record.triggers || [],
    action: record.allowed_action,
    sla: record.sla_response_time_hours,
    conf: record.confidence_threshold,
    escalation: record.escalation_reason || '',
    tone_default: record.tone_variants?.default || '',
    desc: record.id === 'universal_fallback'
      ? 'Catches all inquiries not matched by a more specific skill. Forces escalation.'
      : `Custom skill. Action: ${record.allowed_action}.`,
  };
}

function jsonOk(data) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
