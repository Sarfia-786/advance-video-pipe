import { projectInput, projectRoute } from '@/lib/platform/projects/http.mjs';
import { cancelInvitation, inviteMember } from '@/lib/platform/projects/teams.mjs';
import { sendAccountEmail } from '@/lib/platform/accounts/email.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = projectRoute(async ({ pool, owner, params, request }) => {
  const input = await projectInput(request);
  const { token, ...invitation } = await inviteMember(pool,owner,params.workspaceId,input);
  const zh = input.locale === 'zh';
  const url = new URL((zh ? '/zh' : '') + '/team',process.env.BETTER_AUTH_URL);
  url.hash = 'invite=' + token;
  let delivered = true;
  try {
    await sendAccountEmail({ to:invitation.email, subject:zh ? '团队工作区邀请' : 'Team workspace invitation',
      action:zh ? '请使用受邀请的邮箱登录，然后接受邀请。' : 'Sign in with the invited email address and accept the invitation.', url:url.href });
  } catch { delivered = false; }
  return { invitation, url:url.href, delivered };
});
export const DELETE = projectRoute(async ({ pool, owner, params, request }) =>
  cancelInvitation(pool,owner,params.workspaceId,(await projectInput(request)).id));
