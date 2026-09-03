import 'dotenv/config';
import 'reflect-metadata';

import { PrismaService } from '../src/prisma/prisma.service.js';

const prisma = new PrismaService();

// Укажи SKU товара из своей базы.
const PRODUCT_SKU = 'KEY-CS2-PRIME';

const keys = [
  'LFXC-TNCS-BPCD',
  'P3EI-W8UO-9B4K',
  'FEL3-GUXN-TCCH',
  'YPLV-QK2Z-IUS5',
  '0K9E-P1FR-BY1U',
  '5LZV-UQ48-RXCZ',
  'X93K-NYAQ-GEC1',
  'EIO5-CQT5-35KO',
  'M58F-GIIR-VJAP',
  'NU8Y-SWYB-6252',
  'OODW-CCHF-MBAF',
  'DNA5-WFJM-NE49',
  'QRDD-MJ3F-A8TF',
  'TAT9-5ZJN-G1T2',
  'LI39-4330-ISMB',
  'BKJY-8Q79-8NHI',
  'HHW6-4RX2-DX62',
  '1RG2-L28O-O80G',
  'EF63-F39X-MTEA',
  '8XS7-P53H-JKIV',
  'JPE6-MQV6-P7ST',
  'SAPG-A2GR-0ULS',
  'T2DU-IJ1S-U16P',
  'WSSY-QTR7-Z57J',
  'U74E-EPCI-CY26',
  'FZXF-58H8-OR93',
  'FPSM-HLZA-TPAL',
  'WSC9-28DJ-B2JE',
  'P63J-F7UZ-DCYP',
  'C7W2-D4C5-QMT7',
  'JESI-DFBH-LK1K',
  'SGMA-JA0T-GR7D',
  '3PR4-OSY9-M3ZW',
  'OMBE-C0JF-D45Y',
  'KIKQ-FQJ8-9TI8',
  'LMAN-RSHS-AJDO',
  'BAKI-VT1X-Z5OL',
  '9F0X-B46W-03FS',
  'S423-V6YY-IBEM',
  'D4UW-WYRA-20ST',
  'XC0J-CJ0H-09RN',
  'RY1W-XCFJ-0KUA',
  'CJYY-YKSQ-QE6H',
  '97AQ-38QJ-H8HU',
  'FS8E-3S5Z-I6RA',
  'ARQK-FML4-A14E',
  '7Z6K-NO9V-MPJB',
  'D4K7-IJSG-N853',
  'W67T-ZB0Q-1XKB',
  '7EQM-K09J-XKUO',
];

async function main() {
  await prisma.$connect();

  const product = await prisma.product.findUnique({
    where: {
      sku: PRODUCT_SKU,
    },
  });

  if (!product) {
    throw new Error(`Товар с SKU "${PRODUCT_SKU}" не найден`);
  }

  // Не переносим ключи, уже привязанные к другим товарам.
  const conflicts = await prisma.productKey.findMany({
    where: {
      code: {
        in: keys,
      },
      productId: {
        not: product.id,
      },
    },
    select: {
      code: true,
      productId: true,
    },
  });

  if (conflicts.length > 0) {
    console.table(conflicts);

    throw new Error(
      'Некоторые ключи уже принадлежат другим товарам. Импорт остановлен.',
    );
  }

  const result = await prisma.productKey.createMany({
    data: keys.map((code) => ({
      code,
      productId: product.id,
    })),
    skipDuplicates: true,
  });

  const freeKeys = await prisma.productKey.count({
    where: {
      productId: product.id,
      delivery: {
        is: null,
      },
    },
  });

  console.log(`Товар: ${product.name}`);
  console.log(`Ключей в списке: ${keys.length}`);
  console.log(`Добавлено: ${result.count}`);
  console.log(`Пропущено существующих: ${keys.length - result.count}`);
  console.log(`Всего свободных ключей товара: ${freeKeys}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
