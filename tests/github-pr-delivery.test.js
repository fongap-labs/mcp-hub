import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { RuntimeTaskJournal } from '../runtime/sqlite-task-journal.mjs';
import { createAuthorizedGithubDelivery } from '../runtime/github-pr-delivery.mjs';
import { collectApprovedWorktreeChanges } from '../runtime/worktree-change-collector.mjs';
import { worktreeKey } from '../runtime/git-worktree-preparer.mjs';
import { startLoopbackRuntimeTaskService } from '../runtime/authenticated-task-service.mjs';

const repository = 'fongap-labs/example';
const taskRef = 'task_' + 'a'.repeat(64);
const dispatchId = 'dispatch_' + 'b'.repeat(43);
const runnerId = 'runner_' + 'c'.repeat(43);
const leaseId = 'lease_' + 'd'.repeat(43);
const token = 'github_pat_' + 'x'.repeat(48);
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 12000,
    stdio: ['ignore','pipe','ignore'] }).trim();
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-github-delivery-'));
  const base = join(dir,'base');
  git(dir, ['init','-b','main',base]);
  writeFileSync(join(base,'README.md'),'Original baseline\n');
  writeFileSync(join(base,'DELETE.md'),'To be removed\n');
  git(base,['add','.']);
  git(base,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','initial']);
  git(base,['remote','add','origin','https://github.com/' + repository + '.git']);
  const sourceSha = git(base,['rev-parse','HEAD']);
  const branch = 'agent/task-' + worktreeKey(taskRef);
  const worktree = join(base+'.worktrees',worktreeKey(taskRef));
  git(base,['worktree','add','--no-track','-b',branch,worktree,sourceSha]);
  writeFileSync(join(worktree,'README.md'),'Updated text from coding engine\n');
  mkdirSync(join(worktree,'src'));
  writeFileSync(join(worktree,'src','new.ts'),'export const count = 1;\n');
  rmSync(join(worktree,'DELETE.md'));
  const journal = new RuntimeTaskJournal({ databasePath:join(dir,'task.db'),
    encryptionKey:Buffer.alloc(32,13), clock:()=>Date.UTC(2026,10,12,10,0,0) });
  const offer = { dispatchId, leaseId, taskRef, resourceKey:'repo:fongap-labs_example' };
  const fakeHub = { async get() { return {
    dispatch_id:dispatchId, task_ref:taskRef, resource_key:offer.resourceKey,
    runner_id:runnerId, lease_id:leaseId, status:'accepted',
    lease_expires_at:Date.UTC(2026,10,12,10,5,0)/1000,
  }; } };
  async function completed() {
    journal.createTask({ taskRef, resourceKey:offer.resourceKey, task:{
      repository, sourceSha, prompt:'PRIVATE_INSTRUCTIONS_NOT_TO_PUBLISH', authorizedActorId:1001,
    } });
    journal.attachDispatch(taskRef, dispatchId);
    await journal.claimAcceptedTask(offer,runnerId,fakeHub);
    await journal.beginSideEffects(taskRef,runnerId,leaseId,fakeHub);
    journal.complete(taskRef,runnerId,leaseId,'completed',{ engine:'claude-code', summary:'done' });
    journal.acknowledge(taskRef,4);
  }
  return { dir, base, worktree, branch, sourceSha, journal, completed,
    roots: { [repository]:base },
    clean() { journal.close(); rmSync(dir,{recursive:true,force:true}); } };
}
function githubMock(fx) {
  const state = { calls:[], posts:[], user:{id:1001,login:'authorized-dev',type:'User'},
    permissions:{push:true}, mainSha:fx.sourceSha, refs:new Map(),
    commits:new Map(), prs:[], losePrResponse:false };
  const baseTree='e'.repeat(40);
  const reply = (code,body)=>new Response(JSON.stringify(body),{status:code,
    headers:{'Content-Type':'application/json'}});
  async function fetcher(url,options) {
    assert.equal(options.headers.Authorization,'Bearer '+token);
    assert.equal(options.redirect,'error');
    const path=new URL(url).pathname;
    const method=options.method||'GET';
    const query=new URL(url).searchParams;
    const body=options.body ? JSON.parse(options.body) : null;
    state.calls.push({method,path});
    if(method!=='GET')state.posts.push({method,path,body});
    if(method==='GET'&&path==='/user')return reply(200,state.user);
    if(method==='GET'&&path==='/repos/'+repository)return reply(200,{
      full_name:repository,default_branch:'main',archived:false,disabled:false,
      permissions:state.permissions,
    });
    const root='/repos/'+repository;
    if(method==='GET'&&path===root+'/git/ref/heads/main')return reply(200,{object:{sha:state.mainSha}});
    if(method==='GET'&&path.startsWith(root+'/git/ref/heads/')) {
      const ref=path.slice((root+'/git/ref/heads/').length);
      return state.refs.has(ref) ? reply(200,{object:{sha:state.refs.get(ref)}})
        : reply(404,{message:'Not found'});
    }
    if(method==='GET'&&path.startsWith(root+'/git/commits/')) {
      const sha=path.slice((root+'/git/commits/').length);
      return reply(200,state.commits.get(sha)||{tree:{sha:baseTree}});
    }
    if(method==='GET'&&path===root+'/pulls') {
      const head=query.get('head');
      const matching=state.prs.filter(p=>head==='fongap-labs:'+p.head.ref);
      return reply(200,matching);
    }
    if(method==='POST'&&path===root+'/git/blobs') {
      return reply(201,{sha:createHash('sha1').update(body.content).digest('hex')});
    }
    if(method==='POST'&&path===root+'/git/trees') {
      assert.equal(body.base_tree,baseTree);
      assert.ok(body.tree.every(entry=>!entry.path.includes('..')));
      return reply(201,{sha:'f'.repeat(40)});
    }
    if(method==='POST'&&path===root+'/git/commits') {
      assert.deepEqual(body.parents,[fx.sourceSha]);
      const sha='1'.repeat(40);
      state.commits.set(sha,{message:body.message,tree:{sha:body.tree},
        parents:body.parents.map(sha=>({sha}))});
      return reply(201,{sha});
    }
    if(method==='POST'&&path===root+'/git/refs') {
      assert.match(body.ref,/^refs\/heads\/agent\/task-/);
      assert.equal(state.refs.has(body.ref.slice('refs/heads/'.length)),false);
      state.refs.set(body.ref.slice('refs/heads/'.length),body.sha);
      return reply(201,{object:{sha:body.sha}});
    }
    if(method==='POST'&&path===root+'/pulls') {
      assert.equal(body.head,fx.branch);
      assert.equal(body.base,'main');
      assert.equal(body.maintainer_can_modify,false);
      const result={number:91,state:'open',
        html_url:'https://github.com/'+repository+'/pull/91',
        head:{ref:fx.branch},base:{ref:'main'},body:body.body};
      state.prs.push(result);
      if(state.losePrResponse)throw new Error('Response lost after PR creation');
      return reply(201,result);
    }
    throw Error('Unexpected GitHub request '+method+' '+path);
  }
  return { state, fetcher };
}
function delivery(fx, mock) {
  return createAuthorizedGithubDelivery({journal:fx.journal,
    workspaceRoots:fx.roots,allowedActors:[{id:1001,login:'authorized-dev'}],
    githubFetch:mock.fetcher});
}

test('real Git worktree: safe file collection includes modification, creation, deletion only', () => {
  const fx=fixture();
  try {
    const plan=collectApprovedWorktreeChanges({
      taskRef,repository,sourceSha:fx.sourceSha,workspaceRoots:fx.roots,
    });
    assert.equal(plan.branch,fx.branch);
    assert.deepEqual(plan.changes.map(x=>x.path).sort(),
      ['DELETE.md','README.md','src/new.ts']);
    assert.equal(plan.changes.find(x=>x.path==='DELETE.md').sha,null);
    assert.equal(Buffer.from(plan.changes.find(x=>x.path==='src/new.ts').content,'base64')
      .toString('utf8'),'export const count = 1;\n');
  } finally {fx.clean();}
});

test('completed and acknowledged task creates only isolated branch, commit, PR and is idempotent',async()=>{
  const fx=fixture(), mock=githubMock(fx);
  try {
    await fx.completed();
    const d=delivery(fx,mock);
    const first=await d.deliver({authorization:'Bearer '+token,body:{taskRef}});
    assert.deepEqual(first,{taskRef,status:'review_pending',pullRequest:91,
      url:'https://github.com/'+repository+'/pull/91',replayed:false});
    assert.equal(mock.state.posts.filter(x=>x.path.endsWith('/git/refs')).length,1);
    assert.equal(mock.state.posts.filter(x=>x.path.endsWith('/pulls')).length,1);
    assert.ok(mock.state.posts.every(x=>!JSON.stringify(x).includes('PRIVATE_INSTRUCTIONS')));
    assert.ok(mock.state.posts.every(x=>!JSON.stringify(x).includes(token)));
    assert.ok(mock.state.posts.every(x=>x.path!=='/repos/'+repository+'/git/ref/heads/main'));
    assert.deepEqual(mock.state.posts.find(x=>x.path.endsWith('/git/trees')).body.tree
      .map(x=>x.path).sort(),['DELETE.md','README.md','src/new.ts']);
    const second=await d.deliver({authorization:'Bearer '+token,body:{taskRef}});
    assert.equal(second.replayed,true);
    assert.equal(mock.state.posts.filter(x=>x.path.endsWith('/pulls')).length,1);
  } finally {fx.clean();}
});

test('lost PR-create response is reconciled by the task marker, no second PR',async()=>{
  const fx=fixture(), mock=githubMock(fx);mock.state.losePrResponse=true;
  try {
    await fx.completed();
    const response=await delivery(fx,mock).deliver({
      authorization:'Bearer '+token,body:{taskRef}});
    assert.equal(response.pullRequest,91);
    assert.equal(mock.state.prs.length,1);
  } finally{fx.clean();}
});

test('actor mismatch, missing permission or moved main denies every write',async()=>{
  for(const scenario of ['actor','permission','main']){
    const fx=fixture(),mock=githubMock(fx);
    try {
      await fx.completed();
      if(scenario==='actor')mock.state.user.id=4004;
      if(scenario==='permission')mock.state.permissions.push=false;
      if(scenario==='main')mock.state.mainSha='9'.repeat(40);
      await assert.rejects(delivery(fx,mock).deliver({
        authorization:'Bearer '+token,body:{taskRef}}),error=>
          error.status===403||error.status===409);
      assert.equal(mock.state.posts.length,0);
    }finally{fx.clean();}
  }
});

test('unreconciled or unowned tasks cannot be delivered, even with a valid user token',async()=>{
  const fx=fixture(),mock=githubMock(fx);
  try{
    await assert.rejects(delivery(fx,mock).deliver({
      authorization:'Bearer '+token,body:{taskRef}}),/runtime_task_not_deliverable/);
    assert.equal(mock.state.calls.length,0);
  }finally{fx.clean();}
});

test('dirty delivery path restrictions deny secrets, symlinks, and unauthorized staged changes',()=>{
  const fx=fixture();
  try{
    writeFileSync(join(fx.worktree,'.env'),'API_KEY=SECRET\n');
    assert.throws(()=>collectApprovedWorktreeChanges({
      taskRef,repository,sourceSha:fx.sourceSha,workspaceRoots:fx.roots}),/delivery_path_disallowed/);
    rmSync(join(fx.worktree,'.env'));
    symlinkSync(join(fx.base,'README.md'),join(fx.worktree,'src','link.ts'));
    assert.throws(()=>collectApprovedWorktreeChanges({
      taskRef,repository,sourceSha:fx.sourceSha,workspaceRoots:fx.roots}),/delivery_file_disallowed/);
    rmSync(join(fx.worktree,'src','link.ts'));
    git(fx.worktree,['add','README.md']);
    assert.throws(()=>collectApprovedWorktreeChanges({
      taskRef,repository,sourceSha:fx.sourceSha,workspaceRoots:fx.roots}),/delivery_git_status_disallowed/);
  } finally{fx.clean();}
});

test('localhost delivery route is absent by default and uses separate user authorization',async()=>{
  const fx=fixture(),mock=githubMock(fx);await fx.completed();
  const config={journal:fx.journal,runtimeClient:{
    async get(){throw Error('No Runner execution required');},
    async reconcile(){throw Error('No Runtime reconcile required');}},
    executor:{async execute(){throw Error('Not allowed');}},
    runnerCredentials:[{runnerId,token:'rtkn_'+ 'z'.repeat(43)}]};
  const server=await startLoopbackRuntimeTaskService(config);
  try{
    const origin='http://127.0.0.1:'+server.address().port;
    const first=await fetch(origin+'/runtime/v1/tasks/deliver',{
      method:'POST',headers:{Authorization:'Bearer '+token,
        'Content-Type':'application/json'},body:JSON.stringify({taskRef})});
    assert.equal(first.status,404);
  }finally{await new Promise(r=>server.close(r));fx.clean();}
});


test('authenticated localhost delivery endpoint creates PR without Runner execution', async () => {
  const fx=fixture(),mock=githubMock(fx);
  await fx.completed();
  const server=await startLoopbackRuntimeTaskService({
    journal:fx.journal, taskDelivery:delivery(fx,mock),
    runtimeClient:{async get(){throw Error('Unexpected Hub query');},
      async reconcile(){throw Error('Unexpected reconcile');}},
    executor:{async execute(){throw Error('Unexpected Coding Engine execution');}},
    runnerCredentials:[{runnerId,token:'rtkn_'+'z'.repeat(43)}],
  });
  try {
    const origin='http://127.0.0.1:'+server.address().port;
    const post=(payload,bearer=token)=>fetch(origin+'/runtime/v1/tasks/deliver',{
      method:'POST',headers:{'Content-Type':'application/json',
        ...(bearer?{Authorization:'Bearer '+bearer}:{})},
      body:JSON.stringify(payload),
    });
    assert.equal((await post({taskRef},'')).status,401);
    assert.equal((await post({taskRef,prompt:'untrusted override'})).status,400);
    const response=await post({taskRef});
    assert.equal(response.status,200);
    assert.equal((await response.json()).pullRequest,91);
    assert.equal(mock.state.prs.length,1);
  } finally { await new Promise(resolve=>server.close(resolve)); fx.clean(); }
});
