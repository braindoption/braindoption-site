export async function onRequestPost(context) {
  try {
    const data = await context.request.json();
    const id = crypto.randomUUID();

    const entry = {
      ...data,
      processed: false,
      submittedAt: new Date().toISOString()
    };

    await context.env.FORM_SUBMISSIONS.put(id, JSON.stringify(entry));

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
