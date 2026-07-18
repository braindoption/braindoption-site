// functions/api/approve-reply.js
//
// Jozey Dashboard — write endpoint.
//
// Handles the three write actions the dashboard needs:
//   - "save_edit"            save Emmanuel's edited draft (does not send)
//   - "approve"              mark approved_for_send (process-inquiries.js
//                             picks this up on its next run and sends it)
//   - "update_scan_frequency"  writes scan_frequency_minutes to
//                             AGENT_CONFIG.settings (Settings view slider)
//
// Bindings required (Cloudflare Pages Settings):
//   - FORM_SUBMISSIONS  (KV namespace)
//   - AGENT_CONFIG      (KV namespace)
//
// POST body: { "action": "...", "id": "...", "reply": "...", "minutes": 15 }

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { action } = body;

  try {
    if (action === "save_edit") return await saveEdit(body, env);
    if (action === "approve") return await approve(body, env);
    if (action === "update_scan_frequency") return await updateScanFrequency(body, env);
    return jsonError(`Unknown action: ${action}`, 400);
  } catch (err) {
    return jsonError(err.message, 500);
  }
}

async function saveEdit({ id, reply }, env) {
  if (!id) return jsonError("Missing id", 400);
  const submission = await loadSubmission(id, env);
  if (!submission) return jsonError("Submission not found", 404);

  submission.edited_reply = reply ?? submission.edited_reply;
  await env.FORM_SUBMISSIONS.put(id, JSON.stringify(submission));

  return jsonOk({ id, edited_reply: submission.edited_reply });
}

async function approve({ id, reply }, env) {
  if (!id) return jsonError("Missing id", 400);
  const submission = await loadSubmission(id, env);
  if (!submission) return jsonError("Submission not found", 404);

  // Allow approving with a final edit in the same call (drill-down UI does
  // both from one button), or approving as-is if reply is omitted.
  if (reply !== undefined) submission.edited_reply = reply;
  submission.approval_status = "approved_for_send";

  await env.FORM_SUBMISSIONS.put(id, JSON.stringify(submission));

  return jsonOk({ id, approval_status: submission.approval_status });
}

async function updateScanFrequency({ minutes }, env) {
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return jsonError("minutes must be a positive number", 400);
  }

  const raw = await env.AGENT_CONFIG.get("settings");
  if (!raw) return jsonError("AGENT_CONFIG missing 'settings' entry", 500);

  const settings = JSON.parse(raw);
  settings.scan_frequency_minutes = parsed;
  await env.AGENT_CONFIG.put("settings", JSON.stringify(settings));

  return jsonOk({ scan_frequency_minutes: parsed });
}

async function loadSubmission(id, env) {
  const raw = await env.FORM_SUBMISSIONS.get(id);
  if (!raw) return null;
  return JSON.parse(raw);
}

function jsonOk(data) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
