// functions/api/dashboard-data.js
//
// Jozey Dashboard — read endpoint.
//
// Reads the existing FORM_SUBMISSIONS KV (no separate data store, per the
// locked spec) and shapes it into the 3 dashboard layers: stand-up,
// status board, and drill-down detail. GET only — this endpoint never
// writes; use approve-reply.js for edits/approvals.
//
// Bindings required (Cloudflare Pages Settings):
//   - FORM_SUBMISSIONS  (KV namespace)
//   - AGENT_CONFIG      (KV namespace) — for scan_frequency_minutes /
//                         last_scanned_at, surfaced to the Settings view

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const list = await env.FORM_SUBMISSIONS.list();
    const submissions = [];

    for (const key of list.keys) {
      const raw = await env.FORM_SUBMISSIONS.get(key.name);
      if (!raw) continue;
      const submission = JSON.parse(raw);
      if (!submission.processed || !submission.agent) continue; // not yet classified
      submissions.push({ id: key.name, ...submission });
    }

    const standup = buildStandup(submissions);
    const board = submissions.map(toBoardRow).sort(byUrgencyDesc);
    const settings = await loadDashboardSettings(env);

    return new Response(
      JSON.stringify({
        ok: true,
        generated_at: new Date().toISOString(),
        standup,
        board,
        settings,
        // Full submissions included so the client can drill down without
        // a second round trip; UI fetches this once and filters client-side.
        submissions,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

const URGENCY_ORDER = ["low", "medium", "high", "critical"];

function byUrgencyDesc(a, b) {
  return URGENCY_ORDER.indexOf(b.urgency) - URGENCY_ORDER.indexOf(a.urgency);
}

function toBoardRow(submission) {
  return {
    id: submission.id,
    name: `${submission.firstName || ""} ${submission.lastName || ""}`.trim(),
    type: submission.inquiryType || "General Inquiry",
    urgency: submission.agent.urgency_level,
    status: statusLabel(submission),
  };
}

function statusLabel(submission) {
  if (submission.approval_status === "pending_review") return "Pending review";
  if (submission.approval_status === "approved_for_send") return "Approved — queued";
  if (submission.approval_status === "sent") return "Sent";
  if (submission.emailed?.owner_sent) return "Escalated";
  if (submission.emailed?.visitor_sent) return "Sent";
  return "Processed";
}

// Stand-up = urgent right now, near SLA breach, or dormant — kept light,
// per Emmanuel's "quick-glance only" preference; detail lives in drill-down.
function buildStandup(submissions) {
  const now = new Date();
  const items = [];

  for (const s of submissions) {
    if (s.approval_status === "sent") continue; // already resolved

    const urgent = s.agent.urgency_level === "high" || s.agent.urgency_level === "critical";
    const deadline = s.agent.escalation?.deadline ? new Date(s.agent.escalation.deadline) : null;
    const hoursToDeadline = deadline ? (deadline - now) / 3600000 : null;
    const nearSla = hoursToDeadline !== null && hoursToDeadline <= 4 && hoursToDeadline >= 0;
    const breached = hoursToDeadline !== null && hoursToDeadline < 0;
    const dormant = s.approval_status === "pending_review" && hoursSince(s.processedAt) > 24;

    if (urgent || nearSla || breached || dormant) {
      items.push({
        id: s.id,
        name: `${s.firstName || ""} ${s.lastName || ""}`.trim(),
        type: s.inquiryType || "General Inquiry",
        urgency: s.agent.urgency_level,
        reason: breached ? "sla_breached" : nearSla ? "near_sla" : dormant ? "dormant" : "urgent",
      });
    }
  }

  return items;
}

function hoursSince(isoString) {
  if (!isoString) return 0;
  return (new Date() - new Date(isoString)) / 3600000;
}

async function loadDashboardSettings(env) {
  const raw = await env.AGENT_CONFIG.get("settings");
  if (!raw) return { scan_frequency_minutes: null, last_scanned_at: null };
  const settings = JSON.parse(raw);
  return {
    scan_frequency_minutes: settings.scan_frequency_minutes ?? null,
    last_scanned_at: settings.last_scanned_at ?? null,
  };
}
