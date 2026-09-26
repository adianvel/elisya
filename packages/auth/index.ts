import { zenstackAdapter } from '@zenstackhq/better-auth';
import { betterAuth } from "better-auth";
import { openAPI, organization, twoFactor, phoneNumber, admin as adminPlugin } from 'better-auth/plugins'
import { sendEmail } from '@repo/email';
import { logger } from '@repo/logger';

import { zenstack } from '@repo/db';
import { ac, owner, admin } from './permissions';

export async function revokeSessionsBeforeTwoFactorEnable(userId: string): Promise<void> {
  await zenstack.session.deleteMany({ where: { userId } })
}

export const auth = betterAuth({
  basePath: '/auth',
  database: zenstackAdapter(zenstack, {
    provider: 'postgresql',
  }),
  onAPIError: {
    onError: (err) => logger.auth.error({ errorName: err instanceof Error ? err.name : 'UnknownError' }, 'Auth API error'),
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 60, max: 5 },
      '/request-password-reset': { window: 60, max: 5 },
      '/reset-password': { window: 60, max: 10 },
      '/send-verification-email': { window: 60, max: 5 },
    },
  },
  trustedOrigins: [
    String(process.env.APP_URL), String(process.env.API_URL)
  ],
  user: {
    changeEmail: {
      enabled: true,
      sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
        void sendEmail({
          to: user.email,
          subject: 'Confirm your email change',
          text: `Confirm your email change to ${newEmail}: ${url}`
        })
      },
    },
    deleteUser: {
      enabled: true,
      sendDeleteAccountVerification: async ({ user, url }) => {
        void sendEmail({
          to: user.email,
          subject: 'Delete your account',
          text: `Delete your account: ${url}`
        })
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      void sendEmail({
        to: user.email,
        subject: 'Reset your password',
        text: `Reset your password: ${url}`
      })
    },
    onPasswordReset: async ({ user }) => {
      void sendEmail({
        to: user.email,
        subject: 'Password reset',
        text: 'Your password has been reset'
      })
    }
  },
  plugins: [
    phoneNumber(),
    openAPI(),
    adminPlugin(),
    organization({
      ac,
      roles: { owner, admin },
      dynamicAccessControl: {
        enabled: true,
      },
      sendInvitationEmail: async ({ email, role, organization, inviter, invitation }) => {
        void sendEmail({
          to: email,
          subject: `You've been invited to join ${organization.name}`,
          text: `${inviter.user.name} invited you to join ${organization.name}'s Organization as ${role}. Accept the invitation here: ${process.env.APP_URL}/auth/accept-invitation?id=${invitation.id}`,
        })
      },
    }),
    twoFactor({ issuer: 'Palawa', trustDeviceMaxAge: 0 }),
  ],
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url, token }) => {
      void sendEmail({
        to: user.email,
        subject: 'Verify your email',
        text: `Verify your email: ${url}`
      })
    }
  },
  databaseHooks: {
    user: {
      update: {
        before: async (user, context) => {
          if (user.twoFactorEnabled !== true) return
          const userId = context?.context?.session?.user?.id
          if (userId) await revokeSessionsBeforeTwoFactorEnable(userId)
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const organization = await zenstack.member.findFirst(({
            select: {
              organizationId: true
            },
            where: {
              userId: session.userId
            }
          }))
          return {
            data: {
              ...session,
              activeOrganizationId: organization?.organizationId,
            },
          };
        },
      },
    },
  },
});
