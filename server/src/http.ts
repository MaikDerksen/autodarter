import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

export class HttpError extends Error {
  status: number;
  /** Extra fields sent along with { error } (e.g. { code: 'board_busy', ... }). */
  data?: Record<string, unknown>;
  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, `${where}${issue?.message ?? 'Ungültige Eingabe'}`);
  }
  return result.data;
}

export function userId(req: FastifyRequest): string {
  return req.user.sub;
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Nicht angemeldet' });
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; username: string };
    user: { sub: string; username: string };
  }
}
