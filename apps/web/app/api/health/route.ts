import { probeDatabase } from '../../../lib/db-probe.ts';
import { getHealth } from '../../../lib/health.ts';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const health = await getHealth(process.env, probeDatabase);
  return Response.json(health, {
    status: health.status === 'ok' ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
