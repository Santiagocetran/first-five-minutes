export async function broker(sessionId: string, op: string, input: unknown = {}, signal?: AbortSignal) {
  const endpoint = process.env.FFM_EVE_BROKER;
  const secret = process.env.FFM_EVE_SECRET;
  if (!endpoint || !secret) throw new Error('Controller is not connected');
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error',
    headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, op, input }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('Controller rejected this request');
  return response.json();
}
