const prisma = require('./lib/prisma');
const fs = require('fs');

async function main() {
    try {
        const roles = await prisma.role.findMany();
        const outlets = await prisma.outlet.findMany({
            take: 10,
            select: { id: true, code: true, name: true }
        });
        const recoveryOfficers = await prisma.user.findMany({
            where: {
                role: {
                    name: {
                        contains: 'recovery'
                    }
                }
            },
            select: { id: true, username: true, full_name: true, role: { select: { name: true } } }
        });

        const result = {
            roles,
            outlets,
            recoveryOfficers
        };

        fs.writeFileSync('query_db_output.txt', JSON.stringify(result, null, 2), 'utf-8');
        console.log('Result written to query_db_output.txt successfully.');
    } catch (err) {
        fs.writeFileSync('query_db_output.txt', JSON.stringify({ error: err.message }, null, 2), 'utf-8');
        console.error('Error querying database:', err);
    } finally {
        await prisma.$disconnect();
    }
}

main();
