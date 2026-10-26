'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), assert = require('node:assert/strict');
const { prepare } = require('./runtime-smoke.cjs');
async function main() {
  const archive = process.env.SIDE_NATIVE_PACKAGE; if (!archive) throw new Error('Set SIDE_NATIVE_PACKAGE.');
  const old = process.env.SIDE_NATIVE_INSTALL; process.env.SIDE_NATIVE_INSTALL = 'service';
  const f = prepare(); const checks = [];
  try {
    const patchFile = path.join(f.profile,'cordis.patch.yml'), pkgFile = path.join(f.profile,'package.json');
    const run = (...args) => {
      const r = cp.spawnSync(f.cli,['plugin','--profile','web',...args,...(args[0]==='add'?['--offline','--ignore-scripts']:[]),'--config.auto-install-peers=false','--store-dir',path.join(f.home,'store')],{cwd:f.cwd,env:f.env,encoding:'utf8',timeout:45000,detached:process.platform!=='win32'});
      if(process.platform!=='win32'&&r.pid)for(const s of ['SIGTERM','SIGKILL'])try{process.kill(-r.pid,s);}catch(e){if(e.code!=='ESRCH')throw e;}
      return r;
    };
    for(let i=0;i<2;i++){const r=run('add',path.resolve(archive));assert.equal(r.status,0,`import ${i}: ${r.stdout} ${r.stderr}`);}
    const bundleNames=JSON.parse(fs.readFileSync(pkgFile)).dsh.profile.bundles;
    assert.equal(bundleNames.filter(n=>n==='dsh-client-ui-side').length,1); checks.push({name:'official-cli-repeat-import-one-bundle',passed:true});
    const removed=run('remove','dsh-client-ui-side');assert.equal(removed.status,0,`remove: ${removed.stdout} ${removed.stderr}`); assert.equal(JSON.parse(fs.readFileSync(pkgFile)).dependencies?.['dsh-client-ui-side'],undefined); checks.push({name:'official-cli-remove-native-bundle',passed:true});
    const bad = path.join(f.home,'incompatible'); fs.mkdirSync(bad); assert.equal(cp.spawnSync('/usr/bin/tar',['-xzf',path.resolve(archive),'-C',bad]).status,0);
    const badPkg=path.join(bad,'package/package.json'), p=JSON.parse(fs.readFileSync(badPkg)); p.version='9.0.0'; p.engines.dsh='9.0.0'; fs.writeFileSync(badPkg,JSON.stringify(p));
    const pack=cp.spawnSync('npm',['pack','--ignore-scripts','--json','--cache',path.join(f.home,'npm-cache'),'--pack-destination',bad],{cwd:path.join(bad,'package'),encoding:'utf8',timeout:30000}); assert.equal(pack.status,0);
    const beforePkg=fs.readFileSync(pkgFile,'utf8'),beforePatch=fs.readFileSync(patchFile,'utf8');
    const rejected=run('add',path.join(bad,JSON.parse(pack.stdout)[0].filename)); assert.notEqual(rejected.status,0); assert.equal(fs.readFileSync(pkgFile,'utf8'),beforePkg); assert.equal(fs.readFileSync(patchFile,'utf8'),beforePatch);
    checks.push({name:'official-manager-rejects-incompatible-tgz-preserves-config',passed:true});
    console.log(JSON.stringify({passed:true,checks},null,2));
  } finally { f.cleanup(); if(old===undefined)delete process.env.SIDE_NATIVE_INSTALL;else process.env.SIDE_NATIVE_INSTALL=old; }
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({passed:false,code:e.code??'ASSERTION',message:String(e.message).replace(/\/(?:Users|private|var)\/[^\n]*/g,'<local-path>')}));process.exitCode=1;});
