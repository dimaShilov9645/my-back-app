/*
  Warnings:

  - You are about to alter the column `amount` on the `payment_events` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,2)` to `Integer`.

*/
-- AlterTable
ALTER TABLE "payment_events" ALTER COLUMN "amount" SET DATA TYPE INTEGER;
