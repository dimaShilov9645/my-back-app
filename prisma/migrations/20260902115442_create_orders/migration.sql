-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('created', 'paid', 'delivering', 'delivered', 'payment_failed', 'out_of_stock', 'delivery_failed');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productName" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'created',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotencyKey_key" ON "orders"("idempotencyKey");

-- CreateIndex
CREATE INDEX "orders_productId_idx" ON "orders"("productId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
