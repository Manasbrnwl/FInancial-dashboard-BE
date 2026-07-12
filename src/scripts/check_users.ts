import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = "qa-local-test@example.com";
  const password = "testpassword123";
  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (user) {
    await prisma.user.update({
      where: { email },
      data: { password: hashedPassword, isActive: true },
    });
    console.log("Updated existing test user password to 'testpassword123'");
  } else {
    await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        isActive: true,
      },
    });
    console.log("Created test user with password 'testpassword123'");
  }
}

main()
  .catch((e) => {
    console.error("Error running script:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
