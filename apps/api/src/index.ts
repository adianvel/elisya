import { Elysia, t } from "elysia";
import { auth } from "@repo/auth";
import { cors } from "@elysiajs/cors";
import { RPCApiHandler } from '@zenstackhq/server/api';
import { createElysiaHandler } from '@zenstackhq/server/elysia';
import { db, zenstack, schema } from '@repo/db';
import { LogModule } from '@repo/db/enums';
import { logger, readLogs } from '@repo/logger';
import * as storage from '@repo/storage';
import { chat } from './chat';
import { configuredOrganizationId, trips } from './trips';
import { holds } from './holds';
import { payments } from './payments';
import { bookings } from './bookings';
import { dashboard } from './dashboard';
import { enqueueTask, stopTasks } from "./lib/tasks";

const AuthService = new Elysia({ name: "better-auth" })
  .mount(auth.handler);

export const AuthMacro = new Elysia({ name: "auth-macro" })
  .macro({
    auth: {
      async resolve({ status, request: { headers } }) {
        const session = await auth.api.getSession({
          headers: headers as HeadersInit
        });

        if (!session) return status(401)

        const members = await zenstack.member.findMany({
          where: { userId: session.session.userId },
          select: { organizationId: true, role: true },
        });

        return {
          user: session.user,
          session: session.session,
          members,
        }
      }
    }
  })

const AccessLog = new Elysia({ name: "access-log" })
  .derive(({ request }) => ({
    requestStart: performance.now(),
  }))
  .onAfterHandle(({ request, set, requestStart, server }) => {
    logger.access.info({
      method: request.method,
      path: new URL(request.url).pathname,
      status: set.status,
      durationMs: Math.round(performance.now() - requestStart!),
      ip: server?.requestIP(request)?.address,
    }, 'request handled')
  })
  .onError(({ request, set, requestStart, server, error }) => {
    logger.access.error({
      method: request.method,
      path: new URL(request.url).pathname,
      status: set.status,
      durationMs: Math.round(performance.now() - requestStart!),
      ip: server?.requestIP(request)?.address,
      err: error,
    }, 'request failed')
  })

function ownerActor(user: { id: string }, organizationId: string, members: Array<{ organizationId: string; role: string }>) {
  const member = members.find((item) => item.organizationId === organizationId)
  if (!member || member.role !== 'owner') return null
  return { userId: user.id, organizationId }
}

const app = new Elysia()
  .use(
    cors({
      origin: process.env.APP_URL || 'http://localhost:3000',
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  )
  .use(AccessLog)
  .use(AuthService)
  .use(AuthMacro)
  .get('/logs', ({ query }) => readLogs({
    ...query,
    levels: query.levels?.map(Number),
  }), {
    query: t.Object({
      module: t.Union(LogModule.map((module) => t.Literal(module.value))),
      date: t.Optional(t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
      levels: t.Optional(t.Array(t.String(), { maxItems: 8 })),
      search: t.Optional(t.String({ maxLength: 200 })),
    }),
    auth: true
  })
  .group('/model', (app) =>
    app.use(
      createElysiaHandler({
        apiHandler: new RPCApiHandler({ schema }),
        basePath: '/model',
        getClient: async ({ headers }) => {
          const session = await auth.api.getSession({
            headers: headers as HeadersInit
          });

          if (!session) return db

          const members = await zenstack.member.findMany({
            where: { userId: session.session.userId },
            select: { organizationId: true, role: true },
          });

          return db.$setAuth({
            id: session.session.userId,
            members,
          } as any)
        }
      })
    )
  )
  .group('/storage', (app) =>
    app
      .post('/presign', ({ body }) => ({
        key: body.key,
        url: storage.presign(body.key, body),
      }), {
        body: t.Object({
          key: t.String({ minLength: 1, maxLength: 1024 }),
          method: t.Optional(t.Union([
            t.Literal('GET'), t.Literal('POST'), t.Literal('PUT'),
            t.Literal('DELETE'), t.Literal('HEAD'),
          ])),
          expiresIn: t.Optional(t.Number({ minimum: 1, maximum: 7 * 24 * 60 * 60 })),
          type: t.Optional(t.String({ maxLength: 255 })),
          contentDisposition: t.Optional(t.String({ maxLength: 255 })),
        }),
        auth: true,
      })
      .post('/upload', ({ body, user }) =>
        storage.upload({ scope: user.id, key: body.key, file: body.file }), {
        body: t.Object({
          file: t.File({ maxSize: '100m' }),
          key: t.Optional(t.String({ minLength: 1, maxLength: 1024 })),
        }),
        auth: true,
      })
      .get('/objects/*', async ({ params }) => {
        const s3file = await storage.download(params['*']);
        return s3file ? new Response(s3file) : { error: 'Not found' };
      }, {
        auth: true,
      })
      .delete('/objects/*', async ({ params }) => storage.removeObject(params['*']), {
        auth: true,
      })
      .get('/stat/*', async ({ params }) => storage.statObject(params['*']), {
        auth: true,
      })
      .get('/list', async ({ query }) => storage.listObjects(query), {
        query: t.Object({
          prefix: t.Optional(t.String({ maxLength: 1024 })),
          maxKeys: t.Optional(t.Number({ minimum: 1, maximum: 1000 })),
        }),
        auth: true,
      })
  )
  .group('/tasks', (app) =>
    app
      .post('/posts/export', ({ body, user }) => enqueueTask('post.export', {
        userId: user.id,
        organizationId: body.organizationId,
      }), {
        body: t.Object({
          organizationId: t.Optional(t.String()),
        }),
        auth: true,
      })
  )
  .group('/trips', (app) =>
    app
      .get('/', () => trips.listAvailable({ organizationId: configuredOrganizationId() }))
      .get('/manage', async ({ query, user, members, status }) => {
        const actor = ownerActor(user, query.organizationId, members)
        if (!actor) return status(403)
        return trips.listOwner(actor)
      }, {
        query: t.Object({
          organizationId: t.String({ minLength: 1 }),
        }),
        auth: true,
      })
      .post('/', async ({ body, user, members, status }) => {
        const actor = ownerActor(user, body.organizationId, members)
        if (!actor) return status(403)
        return trips.create(actor, {
          origin: body.origin,
          destination: body.destination,
          departureAt: new Date(body.departureAt),
          price: body.price,
          currency: body.currency,
          seatQuota: body.seatQuota,
        })
      }, {
        body: t.Object({
          organizationId: t.String({ minLength: 1 }),
          origin: t.String({ minLength: 1, maxLength: 100 }),
          destination: t.String({ minLength: 1, maxLength: 100 }),
          departureAt: t.String({ format: 'date-time' }),
          price: t.Integer({ minimum: 0 }),
          currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
          seatQuota: t.Integer({ minimum: 1 }),
        }),
        auth: true,
      })
      .patch('/:id', async ({ params, body, user, members, status }) => {
        const actor = ownerActor(user, body.organizationId, members)
        if (!actor) return status(403)
        const changes = {
          ...(body.origin === undefined ? {} : { origin: body.origin }),
          ...(body.destination === undefined ? {} : { destination: body.destination }),
          ...(body.departureAt === undefined ? {} : { departureAt: new Date(body.departureAt) }),
          ...(body.price === undefined ? {} : { price: body.price }),
          ...(body.currency === undefined ? {} : { currency: body.currency }),
          ...(body.seatQuota === undefined ? {} : { seatQuota: body.seatQuota }),
          ...(body.status === undefined ? {} : { status: body.status }),
        }
        return trips.update(actor, params.id, changes)
      }, {
        params: t.Object({ id: t.String({ minLength: 1 }) }),
        body: t.Object({
          organizationId: t.String({ minLength: 1 }),
          origin: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
          destination: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
          departureAt: t.Optional(t.String({ format: 'date-time' })),
          price: t.Optional(t.Integer({ minimum: 0 })),
          currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
          seatQuota: t.Optional(t.Integer({ minimum: 1 })),
          status: t.Optional(t.Union([t.Literal('DRAFT'), t.Literal('PUBLISHED'), t.Literal('ARCHIVED')])),
        }),
        auth: true,
      })
  )
  .group('/holds', (app) =>
    app
      .post('/', ({ body }) => holds.create({
        organizationId: configuredOrganizationId(),
        tripId: body.tripId,
        customerRef: body.customerRef,
        seatCount: body.seatCount,
        idempotencyKey: body.idempotencyKey,
      }), {
        body: t.Object({
          tripId: t.String({ minLength: 1 }),
          customerRef: t.String({ minLength: 1, maxLength: 255 }),
          seatCount: t.Integer({ minimum: 1 }),
          idempotencyKey: t.String({ minLength: 1, maxLength: 255 }),
        }),
      })
      .get('/:id', async ({ params }) => {
        const hold = await holds.get(configuredOrganizationId(), params.id)
        return hold ?? { error: 'Hold not found' }
      }, {
        params: t.Object({ id: t.String({ minLength: 1 }) }),
      })
  )
  .group('/payments', (app) =>
    app
      .post('/', ({ body }) => payments.submit({
        organizationId: configuredOrganizationId(),
        holdId: body.holdId,
        customerRef: body.customerRef,
        proofKey: body.proofKey,
        idempotencyKey: body.idempotencyKey,
      }), {
        body: t.Object({
          holdId: t.String({ minLength: 1 }),
          customerRef: t.String({ minLength: 1, maxLength: 255 }),
          proofKey: t.String({ minLength: 1, maxLength: 1024 }),
          idempotencyKey: t.String({ minLength: 1, maxLength: 255 }),
        }),
      })
      .get('/manage', async ({ query, user, members, status }) => {
        const actor = ownerActor(user, query.organizationId, members)
        if (!actor) return status(403)
        return payments.listPending(actor)
      }, {
        query: t.Object({ organizationId: t.String({ minLength: 1 }) }),
        auth: true,
      })
      .patch('/:id/review', async ({ params, body, query, user, members, status }) => {
        const actor = ownerActor(user, query.organizationId, members)
        if (!actor) return status(403)
        return payments.review(actor, params.id, body)
      }, {
        params: t.Object({ id: t.String({ minLength: 1 }) }),
        query: t.Object({ organizationId: t.String({ minLength: 1 }) }),
        body: t.Object({
          status: t.Union([t.Literal('APPROVED'), t.Literal('REJECTED')]),
          reason: t.Optional(t.String({ maxLength: 1000 })),
        }),
        auth: true,
      })
      .get('/:id/proof', async ({ params, query, user, members, status }) => {
        const actor = ownerActor(user, query.organizationId, members)
        if (!actor) return status(403)
        const key = await payments.getProof(actor, params.id)
        const file = await storage.download(key)
        return file ? new Response(file) : status(404)
      }, {
        params: t.Object({ id: t.String({ minLength: 1 }) }),
        query: t.Object({ organizationId: t.String({ minLength: 1 }) }),
        auth: true,
      })
  )
  .group('/bookings', (app) =>
    app
      .get('/manage', async ({ query, user, members, status }) => {
        const actor = ownerActor(user, query.organizationId, members)
        if (!actor) return status(403)
        return bookings.listOwner(actor)
      }, {
        query: t.Object({ organizationId: t.String({ minLength: 1 }) }),
        auth: true,
      })
      .get('/:id', async ({ params, query }) => {
        const booking = await bookings.getForCustomer(configuredOrganizationId(), query.customerRef, params.id)
        return booking ?? { error: 'Booking not found' }
      }, {
        params: t.Object({ id: t.String({ minLength: 1 }) }),
        query: t.Object({ customerRef: t.String({ minLength: 1, maxLength: 255 }) }),
      })
  )
  .group('/dashboard', (app) =>
    app
      .get('/operations', ({ query, user, members, status }) => {
        const actor = ownerActor(user, query.organizationId, members)
        if (!actor) return status(403)
        return dashboard.operations(actor)
      }, {
        query: t.Object({ organizationId: t.String({ minLength: 1 }) }),
        auth: true,
      })
      .get('/moneyflow', ({ query, user, members, status }) => {
        const actor = ownerActor(user, query.organizationId, members)
        if (!actor) return status(403)
        return dashboard.moneyflow(actor)
      }, {
        query: t.Object({ organizationId: t.String({ minLength: 1 }) }),
        auth: true,
      })
  )
  .use(chat)
  .listen(8000)

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);

  await app.stop();
  await stopTasks();

  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
