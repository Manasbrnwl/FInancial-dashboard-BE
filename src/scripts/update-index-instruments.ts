import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";

loadEnv();
const prisma = new PrismaClient();

async function main() {
  console.log("Updating index instrument mappings in the database...");

  // Update Nifty 50 (ID: 9590)
  const niftyUpdate = await prisma.instrument_lists.update({
    where: { id: 9590 },
    data: {
      upstox_id: "NSE_INDEX|Nifty 50",
      upstox_symbol: "NIFTY"
    }
  });
  console.log("✅ Nifty 50 updated:", niftyUpdate);

  // Update India VIX (ID: 9875)
  const vixUpdate = await prisma.instrument_lists.update({
    where: { id: 9875 },
    data: {
      upstox_id: "NSE_INDEX|India VIX",
      upstox_symbol: "INDIA VIX"
    }
  });
  console.log("✅ India VIX updated:", vixUpdate);
}

main()
  .then(() => prisma.$disconnect())
  .catch(err => {
    console.error("❌ Failed to update index instrument mappings:", err);
    prisma.$disconnect();
    process.exit(1);
  });
