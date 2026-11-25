import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium,expect} from '@playwright/test';

const root=fileURLToPath(new URL('../../apps/panel',import.meta.url)),server=await createServer({root,server:{port:0}});await server.listen();
const base=`http://127.0.0.1:${server.httpServer.address().port}`,browser=await chromium.launch({headless:true}),errors=[];
await mkdir(new URL('../../artifacts/installation-backups/',import.meta.url),{recursive:true});
try{
  for(const role of['admin','member']){
    const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),requests=[];let operation, projectMember, historyMode='ready';
    page.on('pageerror',error=>errors.push(error.message));
    const historyOperations=[
      {operationId:'32345678-1234-4123-8123-123456789abc',actorId:'12345678-1234-4123-8123-123456789abc',name:'Recent installation backup',state:'completed',createdAt:1794916800000,updatedAt:1794916860000,errorCode:null},
      {operationId:'42345678-1234-4123-8123-123456789abc',actorId:'12345678-1234-4123-8123-123456789abc',name:'Interrupted installation backup',state:'recovery_required',createdAt:1794816800000,updatedAt:1794816860000,errorCode:'resume_required'},
      {operationId:'52345678-1234-4123-8123-123456789abc',actorId:'12345678-1234-4123-8123-123456789abc',name:'Earlier failed backup',state:'failed',createdAt:1794716800000,updatedAt:1794716860000,errorCode:'capture_failed'},
    ];
    const handleRequest=async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;requests.push({path,method:request.method()});let value;
      if(path==='/api/v1/installation-backups'&&request.method()==='POST'){
        assert.equal(role,'admin');assert.equal(request.headers()['x-csrf-token'],'settings-csrf');operation={...request.postDataJSON(),actorId:'12345678-1234-4123-8123-123456789abc',state:'requested',createdAt:1794916800000,updatedAt:1794916800000,errorCode:null};return route.fulfill({status:202,json:{ok:true,operation}});
      }
      if(path.endsWith('/verify')&&request.method()==='POST'){
        assert.equal(role,'admin');assert.equal(request.headers()['x-csrf-token'],'settings-csrf');
        return route.fulfill({json:{ok:true,verification:{operationId:historyOperations[0].operationId,name:historyOperations[0].name,verified:true,manifestDigest:`sha256:${'a'.repeat(64)}`}}});
      }
      if(path.endsWith('/delete')&&request.method()==='POST'){
        assert.equal(role,'admin');assert.equal(request.headers()['x-csrf-token'],'settings-csrf');
        return route.fulfill({json:{ok:true,result:{operationId:historyOperations[0].operationId,name:historyOperations[0].name,deleted:true,remainingSnapshots:1}}});
      }
      if(path==='/api/v1/installation-backups/history'){
        if(historyMode==='error')return route.fulfill({status:503,json:{error:{code:'INSTALLATION_BACKUP_UNAVAILABLE',message:'Unavailable'}}});
        if(historyMode==='empty')return route.fulfill({json:{available:true,operations:[],nextCursor:null}});
        if(historyMode==='unsupported')return route.fulfill({json:{available:false,reason:'host_unsupported'}});
        const older=new URL(request.url()).searchParams.has('cursor');value={available:true,operations:older?historyOperations.slice(2):historyOperations.slice(0,2),nextCursor:older?null:historyOperations[1].operationId};
      }
      else if(path==='/api/v1/installation-backups')value={available:true};
      else if(path.startsWith('/api/v1/installation-backups/'))value={ok:true,operation:historyOperations.find(item=>path.endsWith(item.operationId))??operation};
      else if(path==='/api/v1/auth/session')value={user:{id:`settings-${role}`,role,email:`${role}@example.test`},csrfToken:'settings-csrf'};
      else if(path==='/api/v1/projects')value=role==='admin'?[{id:'fixture-project',name:'Production'}]:[];
      else if(path==='/api/v1/actions')value=[];
      else if(path==='/api/v1/projects/fixture-project/services')value=[];
      else if(path==='/api/v1/users')value={users:[{id:'fixture-member',email:'member@example.test',role:'member'}]};
      else if(path==='/api/v1/projects/fixture-project/members')value={members:projectMember?[projectMember]:[]};
      else if(path==='/api/v1/projects/fixture-project/members/fixture-member'){
        assert.equal(role,'admin');
        assert.equal(request.headers()['x-csrf-token'],'settings-csrf');
        projectMember=request.method()==='PUT'?{userId:'fixture-member',email:'member@example.test',role:request.postDataJSON().role}:undefined;
        value={success:true};
      }
      else if(path==='/api/v1/backup-storage')value={profiles:[]};
      else if(path==='/api/v1/auth/api-tokens')value={tokens:[]};
      else if(path==='/api/v1/updates')value={applyAvailable:false};
      else if(path==='/api/v1/integrations/github')value={connected:false};
      else if(path==='/api/v1/auth/two-factor')value={available:false,enabled:false,pending:false,recoveryCodesRemaining:0};
      else if(path==='/api/v1/runtime')value={online:true,engineVersion:'fixture',cpus:2,memoryBytes:1073741824,swarmState:'active',ingressPort:18080};
      else value={};
      return route.fulfill({json:value});
    };
    await page.route('**/api/v1/**',handleRequest);
    await page.goto(base);await page.getByRole('link',{name:'Settings',exact:true}).waitFor();assert.equal(requests.some(request=>request.path==='/api/v1/installation-backups'),false);
    await page.getByRole('link',{name:'Settings',exact:true}).click();await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
    if(role==='admin'){
      const navigation=page.getByRole('navigation',{name:'Settings sections'});
      await navigation.getByRole('link',{name:'Account & access',exact:true}).click();await expect(page).toHaveURL(/#account-access$/);
      const access=page.getByRole('region',{name:'Project access',exact:true});
      await access.getByRole('button',{name:'Grant access',exact:true}).click();
      const grant=page.getByRole('dialog',{name:'Grant project access'});
      await expect(grant.getByRole('combobox',{name:'Member',exact:true})).toBeFocused();
      await grant.getByRole('button',{name:'Save access',exact:true}).click();
      await expect(access.getByRole('list',{name:'Current members'})).toContainText('viewer');
      await access.getByRole('button',{name:'Edit access for member@example.test'}).click();
      const edit=page.getByRole('dialog',{name:'Edit project access'});
      const roleChoice=edit.getByRole('combobox',{name:'Role',exact:true});
      await expect(roleChoice).toBeFocused();
      await roleChoice.selectOption('editor');
      await edit.getByRole('button',{name:'Save access',exact:true}).click();
      await expect(access.getByRole('list',{name:'Current members'})).toContainText('editor');
      await access.getByRole('button',{name:'Remove member@example.test from this project'}).click();
      await expect(access.getByText('No members assigned',{exact:true})).toBeVisible();
      await navigation.getByRole('link',{name:'Backups',exact:true}).click();await expect(page).toHaveURL(/#settings-backups$/);
      const section=page.locator('#installation-backups');await expect(section.getByRole('heading',{name:'Installation backup',exact:true})).toBeVisible();await expect(section).toContainText('Application files, volumes and database contents require their own backups.');await section.getByRole('textbox',{name:'Backup name',exact:true}).fill('Settings screen backup');await section.getByRole('button',{name:'Create installation backup',exact:true}).click();await expect(section.getByText('Waiting for the host to begin.',{exact:true})).toBeVisible();
      const history=section.getByRole('region',{name:'Backup history',exact:true});
      await expect(history).toContainText('Recent installation backup');
      await expect(history.getByRole('row').nth(1)).toContainText('Completed');
      await history.getByText('Details for Interrupted installation backup',{exact:true}).click();
      await expect(history).toContainText('--recover-installation-backup 42345678-1234-4123-8123-123456789abc');
      await history.getByText('Details for Recent installation backup',{exact:true}).click();
      await history.getByRole('button',{name:'Verify archive',exact:true}).click();
      await expect(history).toContainText('Archive verified (sha256:aaaaaaaaaaaaaaaa');
      await history.getByRole('button',{name:'Delete snapshot',exact:true}).click();
      await history.getByRole('button',{name:'Confirm snapshot deletion',exact:true}).click();
      await expect(history).toContainText('Snapshot archive deleted. 1 verified snapshot(s) remain on disk.');
      await section.getByRole('button',{name:'Load older backups',exact:true}).click();
      await expect(history).toContainText('Earlier failed backup');
      await section.getByRole('textbox',{name:'Find by operation ID',exact:true}).fill(historyOperations[0].operationId);
      await section.getByRole('button',{name:'Find operation',exact:true}).click();
      await expect(section.getByRole('heading',{name:'Recent installation backup: Completed',exact:true})).toBeVisible();
      const fresh=await browser.newPage({viewport:{width:1440,height:1100}});
      fresh.on('pageerror',error=>errors.push(error.message));await fresh.route('**/api/v1/**',handleRequest);
      await fresh.goto(base);await fresh.getByRole('link',{name:'Settings',exact:true}).click();
      await fresh.getByRole('navigation',{name:'Settings sections'}).getByRole('link',{name:'Backups',exact:true}).click();
      await expect(fresh.getByRole('region',{name:'Backup history',exact:true})).toContainText('Recent installation backup');
      assert.equal(await fresh.evaluate(()=>localStorage.length),0);
      await fresh.close();
      for(const width of[375,768,1440]){await page.setViewportSize({width,height:1100});await section.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await section.screenshot({path:fileURLToPath(new URL(`../../artifacts/installation-backups/settings-${width}.png`,import.meta.url))});}
      historyMode='empty';await section.getByRole('button',{name:'Refresh history',exact:true}).click();
      await expect(section).toContainText('No installation backup attempts recorded on this host.');
      historyMode='unsupported';await section.getByRole('button',{name:'Refresh history',exact:true}).click();
      await expect(section).toContainText('This host does not provide backup history.');
      await expect(section.getByRole('textbox',{name:'Find by operation ID',exact:true})).toBeVisible();
      historyMode='error';await section.getByRole('button',{name:'Refresh history',exact:true}).click();
      await expect(section.getByRole('alert')).toContainText('Backup history could not be read from the host.');
      assert.equal(requests.filter(request=>request.path==='/api/v1/installation-backups'&&request.method==='POST').length,1);
    }else{await expect(page.locator('#installation-backups')).toHaveCount(0);assert.equal(requests.some(request=>request.path.startsWith('/api/v1/installation-backups')),false);}
    await page.close();
  }
  assert.deepEqual(errors,[]);console.log('PASS Settings navigation, project access grant/edit/remove, admin-only installation backups, host-backed history across fresh browsers, pagination, operation lookup, recovery instructions, CSRF and responsive widths 375/768/1440. API mocked.');
}finally{await browser.close();await server.close();}
