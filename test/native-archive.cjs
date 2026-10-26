'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict');
const { scan } = require('../scripts/privacy.cjs');
const engine = require('../tools/installer.cjs');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function main() {
  const zip = path.resolve(process.argv[2]), tmp = fs.mkdtempSync(path.join(os.tmpdir(), '迁移包 中文 空格-')), checks = [];
  const check = (name, fn) => { fn(); checks.push({ name, passed: true }); };
  try {
    const extracted = path.join(tmp, '解压 安装包'); assert.equal(cp.spawnSync('/usr/bin/ditto', ['-x','-k',zip,extracted]).status,0);
    const root = path.join(extracted,fs.readdirSync(extracted)[0]); assert.equal(scan(root).passed,true);
    const home = path.join(tmp,'隔离 用户'), profile = path.join(home,'profiles/desktop'); fs.mkdirSync(profile,{recursive:true});
    fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({name:'demo-profile',private:true})); fs.writeFileSync(path.join(profile,'cordis.patch.yml'),'- insert:\n    - id: other\n      name: keep-other\n');
    engine.install({profile,root:path.resolve(__dirname,'..')});
    const app = path.join(tmp,'测试 应用.app'); fs.mkdirSync(path.join(app,'Contents/MacOS'),{recursive:true});
    const plist = v => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.deepseek.dsh</string><key>CFBundleExecutable</key><string>TestRuntime</string><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`;
    fs.writeFileSync(path.join(app,'Contents/Info.plist'),plist('0.2.1-rc.3'));
    const stub = path.join(tmp,'runtime.cjs');
    fs.writeFileSync(stub,"const cp=require('node:child_process'),original=cp.spawnSync;cp.spawnSync=function(cmd,...args){if(cmd==='/usr/bin/osascript')return {status:0,stdout:(process.env.SIDE_FIXTURE_RUNNING==='1'?'true':'false')+'\\n'};return original.call(this,cmd,...args)};\n");
    fs.writeFileSync(path.join(app,'Contents/MacOS/TestRuntime'),`#!/bin/bash\nexec ${quote(process.execPath)} --require ${quote(stub)} "$@"\n`,{mode:0o755});
    const call = (name,args=[],env={})=>cp.spawnSync('/bin/bash',[path.join(root,name),'--home',home,...args],{env:{...process.env,DSH_SIDE_APP:app,...env},encoding:'utf8',timeout:25000});
    check('archive-entry-executable-permissions',()=>{for(const name of ['迁移旧版.command','恢复旧版.command','tools/migrate-launcher.sh']) assert.ok(fs.statSync(path.join(root,name)).mode&0o111);});
    check('archive-migrate-chinese-space-path',()=>{const r=call('迁移旧版.command');assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(engine.locations(profile).plugin),false);});
    check('archive-repeat-migration',()=>{const before=fs.readFileSync(engine.locations(profile).history,'utf8');assert.equal(call('迁移旧版.command').status,0);assert.equal(fs.readFileSync(engine.locations(profile).history,'utf8'),before);});
    check('archive-restore-retains-sibling',()=>{const r=call('恢复旧版.command');assert.equal(r.status,0,r.stderr);assert.ok(fs.existsSync(engine.locations(profile).plugin));assert.match(fs.readFileSync(engine.locations(profile).patch,'utf8'),/keep-other/);});
    check('archive-running-app-refuses-no-write',()=>{const before=engine.stateOf(engine.locations(profile));const r=call('迁移旧版.command',[],{SIDE_FIXTURE_RUNNING:'1'});assert.equal(r.status,1);assert.match(r.stderr,/退出/);assert.deepEqual(engine.stateOf(engine.locations(profile)),before);});
    check('archive-unsupported-version-refuses',()=>{fs.writeFileSync(path.join(app,'Contents/Info.plist'),plist('9.9.9'));assert.equal(call('迁移旧版.command').status,1);fs.writeFileSync(path.join(app,'Contents/Info.plist'),plist('0.2.1-rc.3'));});
    check('archive-missing-app-refuses',()=>{assert.equal(call('迁移旧版.command',[],{DSH_SIDE_APP:path.join(tmp,'Absent.app')}).status,1);});
    check('archive-missing-runtime-refuses-simulated',()=>{const env=path.join(tmp,'no-runtime.sh');fs.writeFileSync(env,'function [() { if builtin [ "$1" = "-x" ]; then return 1; fi; builtin [ "$@"; }\nfunction command() { if builtin [ "$1" = "-v" ] && builtin [ "$2" = "node" ]; then return 1; fi; builtin command "$@"; }\n');const before=engine.stateOf(engine.locations(profile));const r=call('迁移旧版.command',[],{BASH_ENV:env});assert.equal(r.status,1);assert.match(r.stdout,/运行环境不可用/);assert.deepEqual(engine.stateOf(engine.locations(profile)),before);});
    check('archive-success-tty-autoexits',()=>{
      const py = `import os,pty,subprocess,sys,errno
master,slave=pty.openpty()
child=subprocess.Popen(['/bin/bash',*sys.argv[1:]],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
while True:
    try: data=os.read(master,8192)
    except OSError as e:
        if e.errno==errno.EIO: break
        raise
    if not data: break
    os.write(sys.stdout.fileno(),data)
os.close(master)
sys.exit(child.wait())
`;
      const r=cp.spawnSync('/usr/bin/python3',['-u','-c',py,path.join(root,'迁移旧版.command'),'--home',home,'--dry-run'],{encoding:'utf8',timeout:8000,env:{...process.env,DSH_SIDE_APP:app,SIDE_KEEP_OPEN:'0'}});
      assert.equal(r.status,0);assert.match(r.stdout,/脚本自动退出/);
    });
    check('archive-dry-run-no-write',()=>{const before=engine.stateOf(engine.locations(profile));assert.equal(call('迁移旧版.command',['--dry-run']).status,0);assert.deepEqual(engine.stateOf(engine.locations(profile)),before);});
    console.log(JSON.stringify({passed:true,checks,entryExecution:'actual-extracted-shell-entrypoints',finderDoubleClick:'not-automated',mutations:'isolated-fixture'},null,2));
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
}
if(require.main===module)try{main();}catch(e){console.error(JSON.stringify({passed:false,code:e.code??'ASSERTION',message:String(e.message).replace(/\/(?:Users|private|var)\/[^\n]*/g,'<local-path>')}));process.exitCode=1;}
