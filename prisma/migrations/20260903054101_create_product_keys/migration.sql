-- CreateTable
CREATE TABLE "product_keys" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_keys_code_key" ON "product_keys"("code");

-- CreateIndex
CREATE INDEX "product_keys_productId_idx" ON "product_keys"("productId");

-- AddForeignKey
ALTER TABLE "product_keys" ADD CONSTRAINT "product_keys_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
