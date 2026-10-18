#!/usr/bin/env node
// Admin accounts from the server's command line. This is the only way to
// create the first owner: there is no default account and no setup page on
// the web that an attacker could reach first.
//
//   npm run admin -- create <username> [--role owner|admin|editor|viewer]
//   npm run admin -- reset-password <username>
//   npm run admin -- reset-2fa <username>
//   npm run admin -- disable <username> | enable <username>
//   npm run admin -- list
//
// Passwords are typed at a hidden prompt, or piped with --password-stdin.
// They are never accepted as arguments or environment variables, which end up
// in shell history and process listings.

import readline from 'node:readline';
import { openDb, q } from '../src/db.js';
import { createUser, setPassword, resetTotp, listUsers, revokeSessions, ROLES } from '../src/admin/auth.js';
import { audit } from '../src/admin/audit.js';
import { passwordProblem } from '../src/security/passwords.js';

const [cmd, username, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? null : rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true;
};

async function readPassword(prompt) {
  if (flag('password-stdin')) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY) throw new Error('No terminal for a password prompt. Pipe the password with --password-stdin.');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function newPassword(user) {
  const pw = await readPassword(`New password for ${user} (at least 12 characters): `);
  const problem = passwordProblem(pw, user);
  if (problem) throw new Error(problem);
  if (!flag('password-stdin')) {
    const again = await readPassword('Type it again: ');
    if (again !== pw) throw new Error("The passwords didn't match.");
  }
  return pw;
}

const findUser = (name) => {
  const u = q('SELECT * FROM admin_users WHERE username = ?').get(name);
  if (!u) throw new Error(`No user called ${name}.`);
  return u;
};

async function main() {
  openDb();
  const by = `cli:${process.env.USER || 'server'}`;
  switch (cmd) {
    case 'create': {
      if (!username) throw new Error('Usage: npm run admin -- create <username> [--role owner]');
      const role = flag('role') || 'owner';
      if (!ROLES.includes(role)) throw new Error(`Role must be one of ${ROLES.join(', ')}.`);
      const pw = await newPassword(username);
      const u = await createUser({ username, password: pw, role, createdBy: by });
      audit(null, { username: by, action: 'users.create', target: u.username, detail: { role, via: 'cli' } });
      console.log(`Created ${role} "${u.username}". Sign in at /admin; you'll be asked to set up two-factor sign-in.`);
      break;
    }
    case 'reset-password': {
      const u = findUser(username);
      await setPassword(u.id, await newPassword(username));
      revokeSessions(u.id);
      audit(null, { username: by, action: 'users.reset_password', target: u.username, detail: { via: 'cli' } });
      console.log(`Password changed for ${u.username}. Their sessions were signed out.`);
      break;
    }
    case 'reset-2fa': {
      const u = findUser(username);
      resetTotp(u.id);
      audit(null, { username: by, action: 'users.reset_2fa', target: u.username, detail: { via: 'cli' } });
      console.log(`Two-factor sign-in reset for ${u.username}. They'll set it up again at next sign-in.`);
      break;
    }
    case 'disable':
    case 'enable': {
      const u = findUser(username);
      q('UPDATE admin_users SET disabled = ?, failed_logins = 0, locked_until = 0 WHERE id = ?').run(cmd === 'disable' ? 1 : 0, u.id);
      if (cmd === 'disable') revokeSessions(u.id);
      audit(null, { username: by, action: `users.${cmd}`, target: u.username, detail: { via: 'cli' } });
      console.log(`${u.username} is now ${cmd}d.`);
      break;
    }
    case 'list': {
      const users = listUsers();
      if (!users.length) console.log('No admin users yet. Create one with: npm run admin -- create <username>');
      for (const u of users) console.log(`${u.username.padEnd(24)} ${u.role.padEnd(7)} ${u.disabled ? 'disabled' : 'active  '} 2FA ${u.totpEnabled ? 'on ' : 'off'}  last sign-in ${u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : 'never'}`);
      break;
    }
    default:
      console.log('Commands: create <username> [--role owner|admin|editor|viewer], reset-password <username>, reset-2fa <username>, disable <username>, enable <username>, list');
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
