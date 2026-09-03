export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new HttpError(400, 'invalid JSON body'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'body must be a JSON object');
  return parsed as Record<string, unknown>;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be a string`);
  return v;
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const v = optionalString(body, key);
  if (v === undefined) throw new HttpError(400, `${key} is required`);
  return v;
}
