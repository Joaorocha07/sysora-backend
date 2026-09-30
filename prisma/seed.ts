import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

// Cria (ou atualiza a senha do) admin master a partir do .env e, com
// SEED_DEMO=true, uma empresa de demonstração com admin, funcionário e serviços.
const prisma = new PrismaClient();

async function main() {
  const email = process.env.MASTER_EMAIL?.trim().toLowerCase();
  const password = process.env.MASTER_PASSWORD;
  if (!email || !password || password.length < 8) {
    throw new Error('Defina MASTER_EMAIL e MASTER_PASSWORD (mínimo 8 caracteres) no .env antes de rodar o seed.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const master = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, isSuperAdmin: true, active: true },
    create: { name: process.env.MASTER_NAME || 'Admin Master', email, passwordHash, isSuperAdmin: true },
  });
  console.log(`Admin master pronto: ${master.email}`);

  if (process.env.SEED_DEMO !== 'true') return;

  const demoPassword = await bcrypt.hash('demo12345', 12);
  const company = await prisma.company.upsert({
    where: { slug: 'empresa-demo' },
    update: {},
    create: {
      name: 'Empresa Demo',
      slug: 'empresa-demo',
      inviteCode: 'DEMO2026',
      settings: { create: {} },
      // Plano Avançado pago por 30 dias, para testar a segunda empresa.
      account: { create: { name: 'Empresa Demo', plan: 'AVANCADO', status: 'ACTIVE', paidUntil: new Date(Date.now() + 30 * 86400000) } },
    },
  });

  const people: { name: string; email: string; role: Role }[] = [
    { name: 'Admin Demo', email: 'admin@demo.sysora', role: Role.ADMIN },
    { name: 'Funcionário Demo', email: 'funcionario@demo.sysora', role: Role.EMPLOYEE },
  ];
  for (const person of people) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      update: {},
      create: { name: person.name, email: person.email, passwordHash: demoPassword },
    });
    await prisma.companyMembership.upsert({
      where: { userId_companyId: { userId: user.id, companyId: company.id } },
      update: {},
      create: { userId: user.id, companyId: company.id, role: person.role },
    });
  }

  if ((await prisma.service.count({ where: { companyId: company.id } })) === 0) {
    await prisma.service.createMany({
      data: [
        { companyId: company.id, name: 'Consulta', durationMinutes: 60, priceCents: 15000, position: 0 },
        { companyId: company.id, name: 'Retorno', durationMinutes: 30, priceCents: 0, position: 1 },
        { companyId: company.id, name: 'Avaliação', durationMinutes: 45, priceCents: 9000, position: 2 },
      ],
    });
  }
  console.log('Empresa demo pronta: admin@demo.sysora / funcionario@demo.sysora (senha demo12345), código de convite DEMO2026');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
