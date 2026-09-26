--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: BookingStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."BookingStatus" AS ENUM (
    'CONFIRMED',
    'PAYMENT_REJECTED',
    'CANCELLED'
);


--
-- Name: CancellationRequestStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."CancellationRequestStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED'
);


--
-- Name: CancellationSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."CancellationSource" AS ENUM (
    'CUSTOMER',
    'TRIP'
);


--
-- Name: HoldStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."HoldStatus" AS ENUM (
    'ACTIVE',
    'EXPIRED',
    'CANCELLED'
);


--
-- Name: InvoiceStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."InvoiceStatus" AS ENUM (
    'ISSUED'
);


--
-- Name: NotificationChannel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."NotificationChannel" AS ENUM (
    'WEB',
    'EMAIL',
    'WHATSAPP'
);


--
-- Name: PaymentStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PaymentStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'REFUND_PENDING',
    'REFUNDED'
);


--
-- Name: PostStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PostStatus" AS ENUM (
    'DRAFT',
    'PUBLISHED',
    'ARCHIVED'
);


--
-- Name: RefundStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."RefundStatus" AS ENUM (
    'PENDING',
    'COMPLETED'
);


--
-- Name: TripStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TripStatus" AS ENUM (
    'DRAFT',
    'PUBLISHED',
    'ARCHIVED',
    'CANCELLED'
);


--
-- Name: VehicleStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."VehicleStatus" AS ENUM (
    'AVAILABLE',
    'ASSIGNED',
    'MAINTENANCE'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp(3) without time zone,
    "refreshTokenExpiresAt" timestamp(3) without time zone,
    scope text,
    password text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: auditEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."auditEvent" (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "actorId" text,
    action text NOT NULL,
    "entityType" text NOT NULL,
    "entityId" text NOT NULL,
    metadata text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: booking; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "holdId" text NOT NULL,
    "tripId" text NOT NULL,
    "paymentId" text NOT NULL,
    "customerRef" text NOT NULL,
    "seatCount" integer NOT NULL,
    status public."BookingStatus" NOT NULL,
    "confirmedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: cancellationRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."cancellationRequest" (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "bookingId" text,
    "paymentId" text,
    "customerRef" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    source public."CancellationSource" DEFAULT 'CUSTOMER'::public."CancellationSource" NOT NULL,
    status public."CancellationRequestStatus" DEFAULT 'PENDING'::public."CancellationRequestStatus" NOT NULL,
    reason text,
    "requestedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "reviewedBy" text,
    "reviewedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: hold; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hold (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "tripId" text NOT NULL,
    "customerRef" text NOT NULL,
    "seatCount" integer NOT NULL,
    "priceAtHold" integer,
    "currencyAtHold" text,
    status public."HoldStatus" DEFAULT 'ACTIVE'::public."HoldStatus" NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "idempotencyKey" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: integrationEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."integrationEvent" (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    source text NOT NULL,
    "messageId" text NOT NULL,
    "customerRef" text NOT NULL,
    response text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: invitation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitation (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    email text NOT NULL,
    role text,
    status text DEFAULT 'pending'::text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "inviterId" text NOT NULL
);


--
-- Name: invoice; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "bookingId" text NOT NULL,
    amount integer NOT NULL,
    currency text NOT NULL,
    status public."InvoiceStatus" DEFAULT 'ISSUED'::public."InvoiceStatus" NOT NULL,
    "issuedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: member; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "userId" text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    "createdAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id text NOT NULL,
    "userId" text NOT NULL,
    title text,
    body text NOT NULL,
    channels public."NotificationChannel"[],
    "readAt" timestamp(3) without time zone,
    "sentAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP,
    url text,
    color text,
    icon text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: organization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo text,
    "createdAt" timestamp(3) without time zone NOT NULL,
    metadata text
);


--
-- Name: organizationRole; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."organizationRole" (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    role text NOT NULL,
    permission text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone
);


--
-- Name: payment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "holdId" text NOT NULL,
    "customerRef" text NOT NULL,
    "proofKey" text NOT NULL,
    status public."PaymentStatus" DEFAULT 'PENDING'::public."PaymentStatus" NOT NULL,
    "rejectionReason" text,
    "idempotencyKey" text NOT NULL,
    "reviewedBy" text,
    "submittedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "reviewedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: post; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post (
    id text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    excerpt text,
    status public."PostStatus" DEFAULT 'DRAFT'::public."PostStatus" NOT NULL,
    "publishedAt" timestamp(3) without time zone,
    "authorId" text,
    "organizationId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: refund; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refund (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "bookingId" text,
    "paymentId" text,
    "customerRef" text NOT NULL,
    amount integer NOT NULL,
    currency text NOT NULL,
    status public."RefundStatus" DEFAULT 'PENDING'::public."RefundStatus" NOT NULL,
    "transferredAt" timestamp(3) without time zone,
    "transferReference" text,
    "recordedBy" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    "impersonatedBy" text,
    "activeOrganizationId" text
);


--
-- Name: trip; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    origin text NOT NULL,
    destination text NOT NULL,
    "departureAt" timestamp(3) without time zone NOT NULL,
    price integer NOT NULL,
    currency text DEFAULT 'IDR'::text NOT NULL,
    "seatQuota" integer NOT NULL,
    status public."TripStatus" DEFAULT 'DRAFT'::public."TripStatus" NOT NULL,
    "vehicleId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: twoFactor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."twoFactor" (
    id text NOT NULL,
    secret text NOT NULL,
    "backupCodes" text NOT NULL,
    "userId" text NOT NULL,
    verified boolean DEFAULT true,
    "failedVerificationCount" integer DEFAULT 0,
    "lockedUntil" timestamp(3) without time zone
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    image text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "phoneNumber" text,
    "phoneNumberVerified" boolean,
    role text,
    banned boolean DEFAULT false,
    "banReason" text,
    "banExpires" timestamp(3) without time zone,
    "twoFactorEnabled" boolean DEFAULT false
);


--
-- Name: vehicle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    name text NOT NULL,
    "plateNumber" text NOT NULL,
    status public."VehicleStatus" DEFAULT 'AVAILABLE'::public."VehicleStatus" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: whatsappOutbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."whatsappOutbox" (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "eventKey" text NOT NULL,
    "customerRef" text NOT NULL,
    text text NOT NULL,
    "sentAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: auditEvent auditEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."auditEvent"
    ADD CONSTRAINT "auditEvent_pkey" PRIMARY KEY (id);


--
-- Name: booking booking_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT booking_pkey PRIMARY KEY (id);


--
-- Name: cancellationRequest cancellationRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."cancellationRequest"
    ADD CONSTRAINT "cancellationRequest_pkey" PRIMARY KEY (id);


--
-- Name: hold hold_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hold
    ADD CONSTRAINT hold_pkey PRIMARY KEY (id);


--
-- Name: integrationEvent integrationEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."integrationEvent"
    ADD CONSTRAINT "integrationEvent_pkey" PRIMARY KEY (id);


--
-- Name: invitation invitation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT invitation_pkey PRIMARY KEY (id);


--
-- Name: invoice invoice_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice
    ADD CONSTRAINT invoice_pkey PRIMARY KEY (id);


--
-- Name: member member_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: organizationRole organizationRole_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."organizationRole"
    ADD CONSTRAINT "organizationRole_pkey" PRIMARY KEY (id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: payment payment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_pkey PRIMARY KEY (id);


--
-- Name: post post_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post
    ADD CONSTRAINT post_pkey PRIMARY KEY (id);


--
-- Name: refund refund_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refund
    ADD CONSTRAINT refund_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: trip trip_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip
    ADD CONSTRAINT trip_pkey PRIMARY KEY (id);


--
-- Name: twoFactor twoFactor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."twoFactor"
    ADD CONSTRAINT "twoFactor_pkey" PRIMARY KEY (id);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: vehicle vehicle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle
    ADD CONSTRAINT vehicle_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: whatsappOutbox whatsappOutbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."whatsappOutbox"
    ADD CONSTRAINT "whatsappOutbox_pkey" PRIMARY KEY (id);


--
-- Name: auditEvent_organizationId_entityType_entityId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "auditEvent_organizationId_entityType_entityId_createdAt_idx" ON public."auditEvent" USING btree ("organizationId", "entityType", "entityId", "createdAt");


--
-- Name: booking_holdId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "booking_holdId_key" ON public.booking USING btree ("holdId");


--
-- Name: booking_organizationId_customerRef_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "booking_organizationId_customerRef_createdAt_idx" ON public.booking USING btree ("organizationId", "customerRef", "createdAt");


--
-- Name: booking_organizationId_status_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "booking_organizationId_status_createdAt_idx" ON public.booking USING btree ("organizationId", status, "createdAt");


--
-- Name: booking_paymentId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "booking_paymentId_key" ON public.booking USING btree ("paymentId");


--
-- Name: cancellationRequest_bookingId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cancellationRequest_bookingId_status_idx" ON public."cancellationRequest" USING btree ("bookingId", status);


--
-- Name: cancellationRequest_organizationId_customerRef_idempotencyK_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "cancellationRequest_organizationId_customerRef_idempotencyK_key" ON public."cancellationRequest" USING btree ("organizationId", "customerRef", "idempotencyKey");


--
-- Name: cancellationRequest_organizationId_status_requestedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cancellationRequest_organizationId_status_requestedAt_idx" ON public."cancellationRequest" USING btree ("organizationId", status, "requestedAt");


--
-- Name: cancellationRequest_paymentId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cancellationRequest_paymentId_status_idx" ON public."cancellationRequest" USING btree ("paymentId", status);


--
-- Name: hold_organizationId_customerRef_idempotencyKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "hold_organizationId_customerRef_idempotencyKey_key" ON public.hold USING btree ("organizationId", "customerRef", "idempotencyKey");


--
-- Name: hold_organizationId_customerRef_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "hold_organizationId_customerRef_status_idx" ON public.hold USING btree ("organizationId", "customerRef", status);


--
-- Name: hold_tripId_status_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "hold_tripId_status_expiresAt_idx" ON public.hold USING btree ("tripId", status, "expiresAt");


--
-- Name: integrationEvent_organizationId_customerRef_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "integrationEvent_organizationId_customerRef_createdAt_idx" ON public."integrationEvent" USING btree ("organizationId", "customerRef", "createdAt");


--
-- Name: invoice_bookingId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "invoice_bookingId_key" ON public.invoice USING btree ("bookingId");


--
-- Name: invoice_organizationId_issuedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoice_organizationId_issuedAt_idx" ON public.invoice USING btree ("organizationId", "issuedAt");


--
-- Name: notifications_userId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "notifications_userId_createdAt_idx" ON public.notifications USING btree ("userId", "createdAt");


--
-- Name: organization_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX organization_slug_key ON public.organization USING btree (slug);


--
-- Name: payment_holdId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_holdId_status_idx" ON public.payment USING btree ("holdId", status);


--
-- Name: payment_organizationId_customerRef_idempotencyKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_organizationId_customerRef_idempotencyKey_key" ON public.payment USING btree ("organizationId", "customerRef", "idempotencyKey");


--
-- Name: payment_organizationId_status_submittedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_organizationId_status_submittedAt_idx" ON public.payment USING btree ("organizationId", status, "submittedAt");


--
-- Name: post_authorId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "post_authorId_idx" ON public.post USING btree ("authorId");


--
-- Name: post_organizationId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "post_organizationId_status_idx" ON public.post USING btree ("organizationId", status);


--
-- Name: post_publishedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "post_publishedAt_idx" ON public.post USING btree ("publishedAt");


--
-- Name: refund_bookingId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "refund_bookingId_key" ON public.refund USING btree ("bookingId");


--
-- Name: refund_organizationId_status_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "refund_organizationId_status_createdAt_idx" ON public.refund USING btree ("organizationId", status, "createdAt");


--
-- Name: refund_paymentId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "refund_paymentId_key" ON public.refund USING btree ("paymentId");


--
-- Name: session_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX session_token_key ON public.session USING btree (token);


--
-- Name: trip_organizationId_status_departureAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "trip_organizationId_status_departureAt_idx" ON public.trip USING btree ("organizationId", status, "departureAt");


--
-- Name: user_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_email_key ON public."user" USING btree (email);


--
-- Name: user_phoneNumber_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "user_phoneNumber_key" ON public."user" USING btree ("phoneNumber");


--
-- Name: vehicle_organizationId_plateNumber_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "vehicle_organizationId_plateNumber_key" ON public.vehicle USING btree ("organizationId", "plateNumber");


--
-- Name: vehicle_organizationId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "vehicle_organizationId_status_idx" ON public.vehicle USING btree ("organizationId", status);


--
-- Name: whatsappOutbox_organizationId_eventKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "whatsappOutbox_organizationId_eventKey_key" ON public."whatsappOutbox" USING btree ("organizationId", "eventKey");


--
-- Name: whatsappOutbox_organizationId_sentAt_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "whatsappOutbox_organizationId_sentAt_createdAt_idx" ON public."whatsappOutbox" USING btree ("organizationId", "sentAt", "createdAt");


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: auditEvent auditEvent_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."auditEvent"
    ADD CONSTRAINT "auditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: booking booking_holdId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT "booking_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES public.hold(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: booking booking_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT "booking_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: booking booking_paymentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT "booking_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES public.payment(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: booking booking_tripId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT "booking_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES public.trip(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: cancellationRequest cancellationRequest_bookingId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."cancellationRequest"
    ADD CONSTRAINT "cancellationRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES public.booking(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: cancellationRequest cancellationRequest_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."cancellationRequest"
    ADD CONSTRAINT "cancellationRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: cancellationRequest cancellationRequest_paymentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."cancellationRequest"
    ADD CONSTRAINT "cancellationRequest_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES public.payment(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: hold hold_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hold
    ADD CONSTRAINT "hold_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: hold hold_tripId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hold
    ADD CONSTRAINT "hold_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES public.trip(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: integrationEvent integrationEvent_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."integrationEvent"
    ADD CONSTRAINT "integrationEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: invitation invitation_inviterId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: invitation invitation_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: invoice invoice_bookingId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice
    ADD CONSTRAINT "invoice_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES public.booking(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: invoice invoice_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice
    ADD CONSTRAINT "invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: member member_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: member member_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: notifications notifications_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: organizationRole organizationRole_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."organizationRole"
    ADD CONSTRAINT "organizationRole_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: payment payment_holdId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT "payment_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES public.hold(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: payment payment_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT "payment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: post post_authorId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post
    ADD CONSTRAINT "post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: post post_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post
    ADD CONSTRAINT "post_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: refund refund_bookingId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refund
    ADD CONSTRAINT "refund_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES public.booking(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: refund refund_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refund
    ADD CONSTRAINT "refund_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: refund refund_paymentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refund
    ADD CONSTRAINT "refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES public.payment(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trip trip_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip
    ADD CONSTRAINT "trip_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trip trip_vehicleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip
    ADD CONSTRAINT "trip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES public.vehicle(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: twoFactor twoFactor_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."twoFactor"
    ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: vehicle vehicle_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle
    ADD CONSTRAINT "vehicle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: whatsappOutbox whatsappOutbox_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."whatsappOutbox"
    ADD CONSTRAINT "whatsappOutbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
