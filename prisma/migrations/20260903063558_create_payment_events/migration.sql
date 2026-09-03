-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('paid', 'failed');

-- CreateTable
CREATE TABLE "payment_events" (
    "eventId" VARCHAR(128) NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE INDEX "payment_events_orderId_idx" ON "payment_events"("orderId");

-- CreateIndex
CREATE INDEX "payment_events_processedAt_receivedAt_idx" ON "payment_events"("processedAt", "receivedAt");
