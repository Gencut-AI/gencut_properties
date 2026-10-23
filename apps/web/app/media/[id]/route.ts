import { ensureWorkspace, getMediaAsset, isServiceError } from '@gencut/services';
import { db } from '../../../lib/db.ts';
import { currentUser } from '../../../lib/session.ts';

/**
 * One image (headshot or generated picture) for a signed-in member of its
 * workspace. Images never change once stored, so the browser may keep them.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await currentUser();
  if (!ctx) return new Response('Sign in to see this image.', { status: 401 });
  const { id } = await params;
  const { workspaceId } = await ensureWorkspace(db(), ctx);
  try {
    const file = await getMediaAsset(db(), ctx, workspaceId, id);
    return new Response(Buffer.from(file.bytes), {
      headers: {
        'content-type': file.contentType,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (e) {
    if (isServiceError(e)) return new Response('Not found.', { status: 404 });
    throw e;
  }
}
