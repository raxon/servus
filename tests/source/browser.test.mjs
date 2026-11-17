import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import ssh2 from 'ssh2';
import '../integration/http-uuid.mjs';

const root = fileURLToPath(new URL('../../apps/panel', import.meta.url));
const server = await createServer({ root, server: { port: 0 } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const initialService = {
  id: 'source-service', projectId: 'source-project', name: 'web', kind: 'app',
  image: 'nginx:alpine', source: { type: 'image' }, state: 'running',
  revision: 1, deployedRevision: 1, replicas: 1, domains: [],
};
const pages = [];
const errors = [];

async function fixture({ service = initialService, admin = true, connected = false } = {}) {
  let saved = structuredClone(service);
  let saveFailure = false;
  let checkFailure = false;
  let githubListFailure = false;
  let saveGate;
  let checkGate;
  const patches = [];
  const checks = [];
  const actions = [];
  const githubRequests = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  pages.push(page);
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('status of')) errors.push(message.text()); });
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/integrations/github/repositories') {
      const repositoryPage = Number(new URL(request.url()).searchParams.get('page') ?? '1');
      githubRequests.push({ kind: 'repositories', page: repositoryPage });
      return route.fulfill(githubListFailure ? { status: 503, json: { error: { code: 'GITHUB_UNAVAILABLE', message: 'GitHub is temporarily unavailable' } } } : { status: 200, json: { repositories: repositoryPage === 1
        ? [{ owner: 'example', name: 'application', fullName: 'example/application', defaultBranch: 'develop', private: true }]
        : [{ owner: 'example', name: 'second', fullName: 'example/second', defaultBranch: 'main', private: false }], page: repositoryPage, nextPage: repositoryPage === 1 ? 2 : null } });
    }
    if (/\/integrations\/github\/repositories\/[^/]+\/[^/]+\/branches$/.test(path)) {
      githubRequests.push({ kind: 'branches', path });
      return route.fulfill({ status: 200, json: { branches: ['main', 'develop', 'release/v1'], page: 1, nextPage: null } });
    }
    if (request.method() === 'PATCH' && path === `/api/v1/services/${saved.id}`) {
      const patch = request.postDataJSON();
      patches.push(structuredClone(patch));
      if (saveGate) await saveGate;
      if (saveFailure) return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: 'Configuration changed. Reload before saving again.' } } });
      assert.equal(patch.expectedRevision, saved.revision);
      const { expectedRevision, ...configuration } = patch;
      saved = { ...saved, ...configuration, revision: saved.revision + 1 };
      if (saved.source.credential?.token) saved.source.credential = { username: saved.source.credential.username, secretRef: '11111111-1111-4111-8111-111111111111' };
      if(saved.registry?.password)saved.registry={server:saved.registry.server,username:saved.registry.username,secretRef:'22222222-2222-4222-8222-222222222222'};
      if(saved.source.ssh&&!saved.source.ssh.secretRef)saved.source.ssh={knownHosts:saved.source.ssh.knownHosts,secretRef:'33333333-3333-4333-8333-333333333333',publicKey:ssh2.utils.generateKeyPairSync('ed25519').public};
      return route.fulfill({ status: 200, json: saved });
    }
    if (path.endsWith('/check-source')) {
      checks.push(request.postDataJSON());
      if (checkGate) await checkGate;
      return route.fulfill(checkFailure ? { status: 422, json: { error: { code: 'SOURCE_CONTEXT', message: 'Build context was not found in this repository.' } } } : { status: 200, json: { commit: 'abcdef1234567890abcdef1234567890abcdef12' } });
    }
    if (request.method() === 'POST' && path.endsWith('/actions')) actions.push(request.postDataJSON());
    const data = path === '/api/v1/auth/session' ? { user: { id: 'test-user', role: admin ? 'admin' : 'member', email: 'test@example.test' }, csrfToken: 'test' }
      : path === '/api/v1/projects' ? [{ id: saved.projectId, name: 'Source project', canWrite: true }]
      : path === `/api/v1/services/${saved.id}` ? saved
      : path === '/api/v1/integrations/github' ? { connected }
      : path.endsWith('/metrics') ? { cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0 }
      : path.endsWith('/actions') || path === '/api/v1/actions' ? []
      : {};
    await route.fulfill({ status: 200, json: data });
  });
  await page.goto(`${base}/services/${saved.id}?tab=source`);
  const form = page.getByRole('form', { name: service.kind === 'app' ? 'Application source' : 'Database source' });
  await form.waitFor();
  return { page, form, patches, checks, actions, githubRequests, failGithubList: value => { githubListFailure = value; }, holdSave: () => { let release; saveGate = new Promise(resolve => { release = resolve; }); return () => { release(); saveGate = undefined; }; }, holdCheck: () => { let release; checkGate = new Promise(resolve => { release = resolve; }); return () => { release(); checkGate = undefined; }; }, failSave: value => { saveFailure = value; }, failCheck: value => { checkFailure = value; } };
}

try {
  const f = await fixture();
  const { page, form } = f;
  const save = form.getByRole('button', { name: 'Save configuration' });
  const image = form.getByRole('textbox', { name: 'Docker image', exact: true });
  await expect(save).toBeDisabled();
  await expect(image).toHaveValue('nginx:alpine');
  assert.equal(await form.locator('[aria-invalid="true"]').count(), 0);

  await image.fill('invalid image');
  await form.getByRole('button', { name: 'Discard changes' }).click();
  await expect(image).toHaveValue('nginx:alpine');

  await image.fill('bad image');
  await save.click();
  await expect(image).toHaveAttribute('aria-invalid', 'true');
  assert.equal(f.patches.length, 0);
  await form.getByRole('button', { name: 'Discard changes' }).click();
  await expect(image).toHaveValue('nginx:alpine');
  assert.equal(await form.locator('[aria-invalid="true"]').count(), 0);

  await image.fill('nginx:1.28-alpine');
  f.failSave(true);
  const releaseSave = f.holdSave();
  await save.click();
  await expect(form.locator('button[type="submit"]')).toBeDisabled();
  await expect(image).toBeDisabled();
  releaseSave();
  await expect(form.getByRole('alert')).toContainText('Reload before saving');
  await expect(image).toHaveValue('nginx:1.28-alpine');
  f.failSave(false);
  await save.click();
  await expect(form.getByText('Configuration saved', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  assert.equal(f.patches.at(-1).image, 'nginx:1.28-alpine');
  assert.equal(f.actions.length, 0, 'Saving must not deploy the service');
  await image.fill('nginx:stable');
  await form.getByRole('button', { name: 'Discard changes' }).click();
  await expect(image).toHaveValue('nginx:1.28-alpine');

  const imageChoice = form.getByRole('radio', { name: 'Docker image', exact: true });
  await imageChoice.focus();
  await page.keyboard.press('ArrowRight');
  await expect(form.getByRole('radio', { name: 'GitHub', exact: true })).toBeChecked();
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement.nextElementSibling).outlineStyle), 'solid');
  await form.getByRole('textbox', { name: 'GitHub repository', exact: true }).fill('example/application');
  await form.getByRole('radio', { name: 'Git', exact: true }).locator('..').click();
  await form.getByRole('textbox', { name: 'Repository URL', exact: true }).fill('https://git.example.com/team/app.git');
  await form.getByRole('radio', { name: 'GitHub', exact: true }).locator('..').click();
  await expect(form.getByRole('textbox', { name: 'GitHub repository', exact: true })).toHaveValue('example/application');
  await form.getByRole('radio', { name: 'Git', exact: true }).locator('..').click();
  await expect(form.getByRole('textbox', { name: 'Repository URL', exact: true })).toHaveValue('https://git.example.com/team/app.git');
  await expect(form.getByRole('button', { name: 'Check source' })).toBeDisabled();

  const context = form.getByRole('textbox', { name: 'Build context', exact: true });
  await expect(context).toBeHidden();
  await form.getByText('Advanced build settings', { exact: true }).click();
  await expect(context).toBeVisible();
  await context.fill('../escape');
  await form.getByText('Advanced build settings', { exact: true }).click();
  await expect(context).toBeHidden();
  await save.click();
  await expect(context).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByText('Use a relative path without .. to stay inside the repository.')).toBeVisible();
  await context.fill('.');
  await save.click();
  await expect(form.getByText('Configuration saved', { exact: true })).toBeVisible();
  assert.equal(f.patches.at(-1).image, undefined, 'Git settings must not overwrite a runtime image');
  assert.equal(f.patches.at(-1).expectedRevision, 2);
  await expect(form.getByRole('button', { name: 'Check source' })).toBeEnabled();
  f.failCheck(true);
  const releaseCheck = f.holdCheck();
  await form.getByRole('button', { name: 'Check source' }).click();
  await expect(form.getByRole('button', { name: 'Checking source' })).toBeDisabled();
  await expect(context).toBeDisabled();
  releaseCheck();
  await expect(context).toHaveAttribute('aria-invalid', 'true');
  await expect(context.locator('..').getByText('Build context was not found in this repository.')).toBeVisible();
  await context.fill('app');
  await expect(context).toHaveAttribute('aria-invalid', 'false');
  f.failCheck(false);
  await form.getByRole('button', { name: 'Check source' }).click();
  await expect(form.getByRole('status')).toContainText('Source is accessible');
  await form.getByRole('textbox', { name: 'Branch or ref', exact: true }).fill('develop');
  await expect(form.getByText('Source is accessible.', { exact: false })).toHaveCount(0);

  const privateGit = await fixture({ service: { ...initialService, source: { type: 'git', repository: 'https://git.example.com/team/private.git', branch: 'main', context: '.', dockerfile: 'Dockerfile', credential: { username: 'git', secretRef: '11111111-1111-4111-8111-111111111111' } } } });
  const token = privateGit.form.locator('input[name="git-token"]');
  await expect(token).not.toHaveAttribute('required');
  await privateGit.form.getByRole('textbox', { name: 'Git username', exact: true }).fill('another-user');
  await expect(token).toHaveAttribute('required');
  await token.fill('synthetic-test-token');
  await privateGit.form.getByRole('button', { name: 'Save configuration' }).click();
  await expect(privateGit.form.getByText('Configuration saved', { exact: true })).toBeVisible();
  await expect(token).toHaveValue('');
  await privateGit.form.getByRole('textbox', { name: 'Branch or ref', exact: true }).fill('release');
  await privateGit.form.getByRole('button', { name: 'Save configuration' }).click();
  await expect(privateGit.form.getByText('Configuration saved', { exact: true })).toBeVisible();
  assert.equal(privateGit.patches.at(-1).source.credential.secretRef, '11111111-1111-4111-8111-111111111111');
  assert.equal(privateGit.patches.at(-1).source.credential.token, undefined);
  assert.equal(privateGit.patches.at(-1).expectedRevision, 2);

  const envSource = await fixture({ service: { ...initialService, source: { type: 'git', repository: 'https://github.com/example/app.git', branch: 'main', context: '.', dockerfile: 'Dockerfile' } } });
  await envSource.form.getByText('Advanced build settings', { exact: true }).click();
  await envSource.form.getByRole('checkbox', { name: 'Generate an environment file before building' }).check();
  const envPath = envSource.form.getByRole('textbox', { name: 'Environment file path', exact: true });
  await expect(envPath).toHaveValue('.env');
  await envPath.fill('../outside');
  await envSource.form.getByRole('button', { name: 'Save configuration' }).click();
  await expect(envPath).toHaveAttribute('aria-invalid', 'true');
  assert.equal(envSource.patches.length, 0);
  await envPath.fill('config/.env.production');
  await envSource.form.getByRole('button', { name: 'Save configuration' }).click();
  await expect(envSource.form.getByText('Configuration saved', { exact: true })).toBeVisible();
  assert.equal(envSource.patches.at(-1).source.envFile, 'config/.env.production');
  assert.equal(envSource.actions.length, 0, 'Saving an env file path must not deploy');
  for (const width of [1440, 768, 375]) {
    await envSource.page.setViewportSize({ width, height: 1100 });
    await expect(envPath).toBeVisible();
    assert.equal(await envSource.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Environment file controls overflow at ${width}px`);
  }
  await envSource.form.getByRole('checkbox', { name: 'Generate an environment file before building' }).uncheck();
  await expect(envPath).toHaveCount(0);
  await envSource.form.getByRole('button', { name: 'Save configuration' }).click();
  await expect(envSource.form.getByText('Configuration saved', { exact: true })).toBeVisible();
  assert.equal(envSource.patches.at(-1).source.envFile, undefined);

  const browse = await fixture({ connected: true });
  await browse.form.getByRole('radio', { name: 'GitHub', exact: true }).locator('..').click();
  assert.equal(browse.githubRequests.length, 0, 'Browsing is opt-in');
  await browse.form.getByRole('button', { name: 'Browse GitHub repositories' }).click();
  const repositoryPicker = browse.form.getByRole('combobox', { name: 'Available GitHub repositories' });
  await expect(repositoryPicker).toBeEnabled();
  await repositoryPicker.selectOption('example/application');
  await expect(browse.form.getByRole('textbox', { name: 'GitHub repository', exact: true })).toHaveValue('example/application');
  await expect(browse.form.getByRole('textbox', { name: 'Branch or ref', exact: true })).toHaveValue('develop');
  const branchPicker = browse.form.getByRole('combobox', { name: 'Available GitHub branches' });
  await expect(branchPicker).toBeEnabled();
  await branchPicker.selectOption('release/v1');
  await expect(browse.form.getByRole('textbox', { name: 'Branch or ref', exact: true })).toHaveValue('release/v1');
  await browse.form.getByRole('button', { name: 'Next repositories' }).click();
  await expect(repositoryPicker.getByRole('option', { name: 'example/second', exact: true })).toHaveCount(1);
  await expect(repositoryPicker).toHaveValue('example/application');
  await repositoryPicker.selectOption('example/second');
  await expect(browse.form.getByRole('textbox', { name: 'Branch or ref', exact: true })).toHaveValue('main');
  for (const width of [1440, 768, 375]) {
    await browse.page.setViewportSize({ width, height: 1100 });
    assert.equal(await browse.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `GitHub picker overflows at ${width}px`);
  }
  await browse.form.getByRole('button', { name: 'Previous repositories' }).click();
  await expect(repositoryPicker.getByRole('option', { name: 'example/application (private)', exact: true })).toHaveCount(1);
  const failedBrowse = await fixture({ connected: true });
  failedBrowse.failGithubList(true);
  await failedBrowse.form.getByRole('radio', { name: 'GitHub', exact: true }).locator('..').click();
  await failedBrowse.form.getByRole('button', { name: 'Browse GitHub repositories' }).click();
  await expect(failedBrowse.form.getByRole('alert')).toContainText('GitHub is temporarily unavailable');
  await failedBrowse.form.getByRole('textbox', { name: 'GitHub repository', exact: true }).fill('manual/repository');
  await expect(failedBrowse.form.getByRole('textbox', { name: 'GitHub repository', exact: true })).toBeEnabled();
  failedBrowse.failGithubList(false);
  await failedBrowse.form.getByRole('button', { name: 'Retry repository list' }).click();
  await expect(failedBrowse.form.getByRole('combobox', { name: 'Available GitHub repositories' })).toBeEnabled();
  await failedBrowse.form.getByRole('button', { name: 'Save configuration' }).click();
  await expect(failedBrowse.form.getByText('Configuration saved', { exact: true })).toBeVisible();
  assert.equal(failedBrowse.patches.at(-1).source.repository, 'https://github.com/manual/repository');
  assert.equal(failedBrowse.patches.at(-1).source.sharedGithub, true);

  const registrySource=await fixture();
  await registrySource.form.getByRole('checkbox',{name:'Authenticate to a private registry'}).check();
  await registrySource.form.getByRole('textbox',{name:'Registry username',exact:true}).fill('reader');
  const registryPassword=registrySource.form.locator('input[name="registry-password"]');
  await registryPassword.fill('fixture-registry-password');
  await registrySource.form.getByRole('textbox',{name:'Registry hostname',exact:true}).fill('https://docker.io');
  await registrySource.form.getByRole('button',{name:'Save configuration'}).click();assert.equal(registrySource.patches.length,0);
  await registrySource.form.getByRole('textbox',{name:'Registry hostname',exact:true}).fill('docker.io');
  await registrySource.form.getByRole('button',{name:'Save configuration'}).click();await expect(registrySource.form.getByText('Configuration saved',{exact:true})).toBeVisible();
  assert.equal(registrySource.patches.at(-1).registry.password,'fixture-registry-password');await expect(registryPassword).toHaveValue('');await expect(registryPassword).not.toHaveAttribute('required');
  await registrySource.form.getByRole('textbox',{name:'Registry username',exact:true}).fill('new-reader');await expect(registryPassword).toHaveAttribute('required');
  await registryPassword.fill('rotated-fixture-password');await registrySource.form.getByRole('button',{name:'Save configuration'}).click();await expect(registrySource.form.getByText('Configuration saved',{exact:true})).toBeVisible();
  await registrySource.form.getByRole('checkbox',{name:'Authenticate to a private registry'}).uncheck();await registrySource.form.getByRole('button',{name:'Save configuration'}).click();await expect(registrySource.form.getByText('Configuration saved',{exact:true})).toBeVisible();assert.equal(registrySource.patches.at(-1).registry,null);
  const sshHost=ssh2.utils.generateKeyPairSync('ed25519').public.split(' ').slice(0,2).join(' '),sshPublic=ssh2.utils.generateKeyPairSync('ed25519').public;
  const sshConfig={type:'git',repository:'ssh://git@git.example.test/team/app.git',branch:'main',context:'.',dockerfile:'Dockerfile',ssh:{knownHosts:`git.example.test ${sshHost}\n`,publicKey:sshPublic,secretRef:'44444444-4444-4444-8444-444444444444'}};
  const sshSource=await fixture({service:{...initialService,source:sshConfig}});
  await expect(sshSource.form.getByRole('textbox',{name:'Deploy public key',exact:true})).toHaveValue(sshPublic);
  await sshSource.form.getByRole('checkbox',{name:'Generate a replacement deploy key when saving'}).check();
  await expect(sshSource.form.getByRole('textbox',{name:'Deploy public key',exact:true})).toHaveCount(0);
  await sshSource.form.getByRole('button',{name:'Save configuration'}).click();await expect(sshSource.form.getByText('Configuration saved',{exact:true})).toBeVisible();assert.equal(sshSource.patches.at(-1).source.ssh.secretRef,undefined);await expect(sshSource.form.getByRole('textbox',{name:'Deploy public key',exact:true})).not.toHaveValue(sshPublic);
  const knownHostsField=sshSource.form.getByRole('textbox',{name:'Verified known_hosts entry',exact:true});
  const sshPatchCount=sshSource.patches.length;await knownHostsField.fill(`foreign.example.test ${sshHost}`);await sshSource.form.getByRole('button',{name:'Save configuration'}).click();assert.equal(sshSource.patches.length,sshPatchCount);
  await knownHostsField.fill(sshConfig.ssh.knownHosts);await sshSource.form.getByRole('textbox',{name:'Branch or ref',exact:true}).fill('develop');await sshSource.form.getByRole('button',{name:'Save configuration'}).click();await expect(sshSource.form.getByText('Configuration saved',{exact:true})).toBeVisible();assert.ok(sshSource.patches.at(-1).source.ssh.secretRef);
  for(const width of[1440,768,375]){await sshSource.page.setViewportSize({width,height:1100});assert.equal(await sshSource.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`SSH credential controls overflow at ${width}px`);}
  const sshMember=await fixture({admin:false,service:{...initialService,source:sshConfig}});await expect(sshMember.form.getByRole('textbox',{name:'Branch or ref',exact:true})).toBeDisabled();

  const sharedSource = { type: 'git', repository: 'https://github.com/example/private.git', branch: 'main', context: '.', dockerfile: 'Dockerfile', sharedGithub: true };
  const shared = await fixture({ connected: true, service: { ...initialService, source: sharedSource } });
  await shared.form.getByRole('textbox', { name: 'Branch or ref', exact: true }).fill('release');
  await shared.form.getByRole('button', { name: 'Save configuration' }).click();
  await expect(shared.form.getByText('Configuration saved', { exact: true })).toBeVisible();
  assert.equal(shared.patches.at(-1).source.sharedGithub, true);
  const member = await fixture({ admin: false, service: { ...initialService, source: sharedSource } });
  await expect(member.form.getByRole('textbox', { name: 'GitHub repository', exact: true })).toBeDisabled();
  await expect(member.form.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  await expect(member.form.getByRole('button', { name: 'Browse GitHub repositories' })).toHaveCount(0);
  assert.equal(member.githubRequests.length, 0);
  const database = await fixture({ service: { ...initialService, kind: 'postgres', image: 'postgres:17-alpine' } });
  await expect(database.form.getByRole('radio', { name: 'GitHub', exact: true })).toBeDisabled();
  await expect(database.form.getByRole('textbox', { name: 'Docker image', exact: true })).toBeEnabled();

  await page.goto(`${base}/services/${initialService.id}?tab=source`);
  const screenshotDir = process.env.SOURCE_SCREENSHOT_DIR;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const name of ['Docker image', 'GitHub', 'Git']) {
      await form.getByRole('radio', { name, exact: true }).locator('..').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflows at ${width}px`);
      assert.equal(await form.evaluate(element => element.getBoundingClientRect().right <= innerWidth), true);
      if (screenshotDir && (name === 'Docker image' || (name === 'Git' && width === 1440))) await page.screenshot({ path: `${screenshotDir}/source-${name === 'Docker image' ? 'image' : 'git'}-${width}.png`, fullPage: true });
      if (screenshotDir && name === 'Docker image' && width === 1440) await form.screenshot({ path: `${screenshotDir}/source-preview.png` });
    }
  }
  assert.deepEqual(errors, [], 'No JavaScript or React errors');
  console.log('PASS: source selection, keyboard focus, validation, discard, save failure/retry, revision tracking, source checks, credentials, roles and responsive layouts at 375/768/1440px. API responses mocked; no deployment performed.');
} finally {
  await Promise.all(pages.map(page => page.close()));
  await browser.close();
  await server.close();
}
