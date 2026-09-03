import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ProductType } from '../src/generated/prisma/client.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
});

const products = [
  {
    sku: 'STEAM-TOPUP-500',
    name: 'Пополнение Steam 500 ₽',
    type: ProductType.topup,
    price: 500,
    currency: 'RUB',
    image: 'assets/steam.png',
  },
  {
    sku: 'STEAM-TOPUP-1000',
    name: 'Пополнение Steam 1000 ₽',
    type: ProductType.topup,
    price: 1000,
    currency: 'RUB',
    image: 'assets/steam.png',
  },
  {
    sku: 'STEAM-TOPUP-2500',
    name: 'Пополнение Steam 2500 ₽',
    type: ProductType.topup,
    price: 2500,
    currency: 'RUB',
    image: 'assets/steam.png',
  },
  {
    sku: 'KEY-CS2-PRIME',
    name: 'CS2 Prime Status ключ',
    type: ProductType.key,
    price: 1290,
    currency: 'RUB',
    image: 'assets/cs2.png',
  },
  {
    sku: 'KEY-GTA5',
    name: 'GTA V ключ активации',
    type: ProductType.key,
    price: 1990,
    currency: 'RUB',
    image: 'assets/gta5.png',
  },
  {
    sku: 'KEY-EFT',
    name: 'Escape from Tarkov ключ',
    type: ProductType.key,
    price: 3490,
    currency: 'RUB',
    image: 'assets/eft.png',
  },
  {
    sku: 'SUB-DISCORD-1M',
    name: 'Discord Nitro 1 месяц',
    type: ProductType.subscription,
    price: 399,
    currency: 'RUB',
    image: 'assets/discord.png',
  },
  {
    sku: 'SUB-YT-3M',
    name: 'YouTube Premium 3 месяца',
    type: ProductType.subscription,
    price: 1490,
    currency: 'RUB',
    image: 'assets/youtube.png',
  },
  {
    sku: 'SUB-SPOTIFY-1M',
    name: 'Spotify Premium 1 месяц',
    type: ProductType.subscription,
    price: 299,
    currency: 'RUB',
    image: 'assets/spotify.png',
  },
  {
    sku: 'GIFT-PSN-1000',
    name: 'PlayStation Store карта 1000 ₽',
    type: ProductType.giftcard,
    price: 1000,
    currency: 'RUB',
    image: 'assets/psn.png',
  },
  {
    sku: 'GIFT-XBOX-1500',
    name: 'Xbox Gift Card 1500 ₽',
    type: ProductType.giftcard,
    price: 1500,
    currency: 'RUB',
    image: 'assets/xbox.png',
  },
  {
    sku: 'GIFT-ROBLOX-800',
    name: 'Roblox 800 Robux',
    type: ProductType.giftcard,
    price: 890,
    currency: 'RUB',
    image: 'assets/roblox.png',
  },
];

async function main() {
  for (const product of products) {
    await prisma.product.upsert({
      where: { sku: product.sku },
      update: product,
      create: product,
    });
  }

  console.log(`Добавлено или обновлено товаров: ${products.length}`);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
