#!/usr/bin/env node
/** Reproducible synthetic runtime benchmark. Never runs against a user's project. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(repository, 'build/benchmarks');
const baselineRef = '17bde3f88bb3b1633c2eb1a8ea9e5b565449076f';
const baselineTree = resolve(output, 'baseline-17bde3f');
const repetitionsIndex = process.argv.indexOf('--repetitions');
const repetitions = repetitionsIndex < 0 ? 3 : Number(process.argv[repetitionsIndex + 1]);
assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 20, 'repetitions must be 1..20');
const baselineOnly = process.argv.includes('--baseline-only');
const runId = 'BENCH-001';
const request = 'REQ-001: Add a bounded paginated order view using the existing tenant permission policy and API mapping. AC-001 permissions; AC-002 pagination; AC-003 mapping. No authorization policy, database, or public contract changes.\n';
const facts = { schema_version: 1, run_id: runId, producer: 'pm', revision: 1, facts: [{ id: 'FACT-001', subject: 'order.view', relation: 'equals', value: 'tenant-scoped paginated public order rows', status: 'approved' }] };
const claims = { schema_version: 1, run_id: runId, task_id: 'BA-001', producer: 'ba', revision: 1, claims: [{ id: 'CLAIM-001', source_fact_id: 'FACT-001', requirement_ids: ['REQ-001'], question_ids: [], subject: 'order.view', relation: 'equals', value: facts.facts[0].value, status: 'approved' }] };
const markdown = `---\nrevision: 1\n---\n# Synthetic benchmark specification\n\n## REQ-001\nUse existing tenant permissions, paginate records, and map safe public rows.\n\n## AC-001\nrequirement_id: REQ-001\nUnauthenticated access fails and records from other tenants are excluded.\n\n## AC-002\nrequirement_id: REQ-001\nOne-based pages return the correct slice and reject invalid bounds.\n\n## AC-003\nrequirement_id: REQ-001\nMap state labels without exposing internal fields.\n\nThis is programmatically authored fixture content, not a human or LLM review.\n`;
const goodSource = `exports.listOrders=(user,q,records)=>{if(!user)throw new Error('forbidden');if(!Number.isInteger(q.page)||q.page<1||!Number.isInteger(q.size)||q.size<1||q.size>3)throw new Error('invalid');const allowed=records.filter(r=>r.tenant===user.tenant);const start=(q.page-1)*q.size;return{total:allowed.length,rows:allowed.slice(start,start+q.size).map(r=>({id:r.id,title:r.name,status:r.state==='P'?'Pending':'Done'}))}};\n`;
const variants = {
  permission: goodSource.replace('records.filter(r=>r.tenant===user.tenant)', 'records'),
  pagination: goodSource.replace('(q.page-1)*q.size', 'q.page*q.size'),
  mapping: goodSource.replace("r.state==='P'?'Pending':'Done'", 'r.state'),
};
const acceptanceSource = `const{test}=require('node:test');const a=require('node:assert/strict');const{listOrders}=require('./feature.cjs');const rows=Array.from({length:7},(_,i)=>({id:i+1,tenant:i===1?'other':'team',name:'Order '+(i+1),state:i%2?'D':'P',secret:'internal-'+i}));const user={tenant:'team'};test('AC-001 authentication',()=>a.throws(()=>listOrders(null,{page:1,size:2},rows),/forbidden/));test('AC-001 tenant permission',()=>{const x=listOrders(user,{page:1,size:3},rows);a.equal(x.total,6);a.deepEqual(x.rows.map(r=>r.id),[1,3,4]);});test('AC-002 one-based pagination',()=>a.deepEqual(listOrders(user,{page:2,size:2},rows).rows.map(r=>r.id),[4,5]));test('AC-002 bounds and empty pages',()=>{for(const q of [{page:0,size:2},{page:1,size:0},{page:1,size:4},{page:1.5,size:2}])a.throws(()=>listOrders(user,q,rows),/invalid/);a.deepEqual(listOrders(user,{page:9,size:2},rows).rows,[]);});test('AC-003 safe response mapping',()=>a.deepEqual(listOrders(user,{page:1,size:1},rows).rows,[{id:1,title:'Order 1',status:'Pending'}]));\n`;
const controls = { api_contract_status: 'approved', gaps: [], questions: [], requirements: ['permission', 'pagination', 'mapping'].map(capability => ({ requirement_id: 'REQ-001', capability, required: true, parameters: {}, source_references: [{ kind: 'fact', reference: 'FACT-001' }] })) };
const handoffInput = { requirementOutcomes: controls.requirements.map(({ requirement_id, capability }) => ({ requirement_id, capability, status: 'implemented' })), changedFiles: [{ path: 'web/feature.cjs', type: 'source' }] };
const assessment = { bounded_scope: true, existing_patterns: true, migrations: false, breaking_api: false, authorization_changes: false, sensitive_data_exposure: false, cross_system_uncertainty: false, rationale: 'Add one bounded view using existing tenant access and response mapping conventions; fixture changes neither permission policy nor persistence.' };
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function captureBaseline() {
  await mkdir(output, { recursive: true });
  // Recreate the owned baseline directory so a previous benchmark cannot contaminate it.
  await rm(baselineTree, { recursive: true, force: true });
  await mkdir(baselineTree, { recursive: true });
  const archive = resolve(output, 'baseline.tar');
  await exec('git', ['archive', '--format=tar', `--output=${archive}`, baselineRef], { cwd: repository });
  await exec('tar', ['-xf', archive, '-C', baselineTree]); await rm(archive);
  if (!await exists(resolve(baselineTree, 'node_modules'))) await symlink(resolve(repository, 'node_modules'), resolve(baselineTree, 'node_modules'));
  await exec(resolve(repository, 'node_modules/.bin/tsc'), ['-p', resolve(baselineTree, 'tsconfig.json')], { cwd: baselineTree });
}
async function candidateFingerprint() {
  const digest=createHash('sha256');
  async function visit(path, label) {
    for(const entry of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const next=resolve(path,entry.name), identity=`${label}/${entry.name}`;
      if(entry.isDirectory())await visit(next,identity);
      else if(entry.isFile()){digest.update(identity);digest.update(await readFile(next));}
    }
  }
  for(const directory of ['src','assets'])await visit(resolve(repository,directory),directory);
  for(const file of ['package.json','package-lock.json','tsconfig.json']){digest.update(file);digest.update(await readFile(resolve(repository,file)));}
  return digest.digest('hex');
}
async function modules(tree) {
  const load = (name) => import(pathToFileURL(resolve(tree, `dist/${name}.js`)).href);
  return Object.assign({}, ...await Promise.all(['install', 'runs', 'transitions', 'manifest-transaction', 'task-operations', 'task-activation', 'agents', 'evidence', 'lifecycle', 'finalize', 'quality-gates', 'schemas'].map(load)), await exists(resolve(tree,'dist/compact-artifacts.js')) ? await load('compact-artifacts') : {});
}
async function scenario(tree, profile, repetition) {
  const api = await modules(tree);
  const root = await mkdtemp(resolve(tmpdir(), 'codex-sdlc-workflow-benchmark-'));
  const totals = { runtime_operations_ms: 0, validation_ms: 0, collector_wrapper_ms: 0, collector_command_execution_ms: 0 };
  const calls = {}; let claimLinks = []; const evidenceRecords = []; const authored = new Set(); const authoredInputs = new Set(); const checks = [];
  const wallStart = performance.now();
  const timed = async (group, name, fn) => { const start=performance.now(); try { return await fn(); } finally { totals[group]+=performance.now()-start; calls[name]=(calls[name]??0)+1; } };
  const operation = (name, fn) => timed('runtime_operations_ms',name,fn);
  const put = async (path, content, manual=true) => { await mkdir(dirname(resolve(root,path)),{recursive:true});await writeFile(resolve(root,path),content);if(manual&&path.startsWith(`.sdlc/runs/${runId}/`)) authored.add(path.slice(`.sdlc/runs/${runId}/`.length)); };
  const transition = (taskId,to,actor='pm') => operation('transition',()=>api.mutateRunManifest(root,runId,async manifest=>{const request={taskId,to,actor,reason:'Synthetic benchmark lifecycle action',at:new Date().toISOString()};Object.assign(manifest,api.transitionTask(manifest,request,await api.prepareTransitionContext(root,runId,manifest,request)));}));
  const collect = async (taskId,command='sdlc_test') => {
    const previous=process.env.CODEX_SDLC_NETWORK_POLICY;process.env.CODEX_SDLC_NETWORK_POLICY='disabled';
    try {const record=await timed('collector_wrapper_ms','evidence',()=>api.executeConfiguredCommand(root,runId,taskId,command));totals.collector_command_execution_ms+=Date.parse(record.completed_at)-Date.parse(record.started_at);evidenceRecords.push(record);return record;}
    finally{if(previous===undefined)delete process.env.CODEX_SDLC_NETWORK_POLICY;else process.env.CODEX_SDLC_NETWORK_POLICY=previous;}
  };
  try {
    await put('web/feature.cjs',"exports.listOrders=(user,q,records)=>{if(!user)throw new Error('forbidden');const allowed=records.filter(r=>r.tenant===user.tenant);return{total:allowed.length,rows:allowed}};\n",false);await put('web/acceptance.test.cjs',acceptanceSource,false);
    await put('web/requirements-check.cjs',`const fs=require('node:fs');const a=require('node:assert/strict');const facts=JSON.parse(fs.readFileSync('../.sdlc/runs/${runId}/facts.yaml','utf8'));a.equal(facts.facts[0].status,'approved');const request=fs.readFileSync('../.sdlc/runs/${runId}/request.md','utf8');for(const id of ['REQ-001','AC-001','AC-002','AC-003'])a.ok(request.includes(id));\n`,false);
    await exec('git',['init','-b','main'],{cwd:root});await exec('git',['add','.'],{cwd:root});await exec('git',['-c','user.name=Benchmark','-c','user.email=benchmark@example.invalid','commit','-m','Synthetic fixture baseline'],{cwd:root});
    await operation('initialize',()=>api.initializeProject({root,projectName:'Synthetic compact comparison',applications:['web'],webRoot:'web',dryRun:false}));
    const projectPath=resolve(root,'.sdlc/project.yaml');const project=parse(await readFile(projectPath,'utf8'));project.applications.web.lifecycle='scaffolded';
    project.commands.sdlc_test={executable:process.execPath,args:['--test','acceptance.test.cjs'],cwd:'web',network:'disabled',mutates:false};
    project.commands.sdlc_typecheck={executable:process.execPath,args:['requirements-check.cjs'],cwd:'web',network:'disabled',mutates:false};await writeFile(projectPath,stringify(project));
    await put('.sdlc/requests/feature.md',request,false);authoredInputs.add('feature request');if(profile==='compact')authoredInputs.add('low-risk assessment');
    await operation('start',()=>api.startRun(root,{id:runId,title:'Tenant-scoped paginated order view',requestFile:'.sdlc/requests/feature.md',affectedApplications:{web:true,backend:false,mobile:false,database:false,sharedPackages:false},now:new Date().toISOString(),...(profile==='compact'?{profile,assessment}:{})}));
    let manifest=await api.loadRun(root,runId);assert.equal(manifest.workflow_profile?.name??'full',profile);const initialTasks=manifest.tasks.map(task=>({id:task.id,role:task.role,stage:task.stage,required_outputs:task.required_outputs}));
    for (const original of initialTasks) {
      manifest=await api.loadRun(root,runId);const task=manifest.tasks.find(task=>task.id===original.id);assert.equal(task.status,'ready',`${profile} ${task.id} must be ready`);
      if(task.role==='frontend') {
        authoredInputs.add('implementation semantic controls');
        await operation('prepare-task',()=>api.prepareTask(root,runId,task.id,{controls,commandIds:['sdlc_test']}));
        const capabilities={source:'synthetic benchmark host adapter; no live LLM',model_selection:true,reasoning_selection:true,models:[]};
        const plan=await operation('agent-plan',()=>api.planAgent(root,runId,task.id,capabilities));
        await operation('activate-task',()=>api.activateTask(root,runId,task.id,{plan,agent_id:'synthetic-benchmark-agent',actual_model:null,actual_reasoning_effort:null,observation_source:null},'Synthetic host adapter activation'));
        for(const path of task.required_outputs.filter(path=>!path.endsWith('-delivery-report.yaml')))await put(`.sdlc/runs/${runId}/${path}`,markdown);
        for(const [variant,source] of Object.entries(variants)) {
          await put('web/feature.cjs',source,false);const evidence=await collect(task.id);assert.equal(evidence.result_status,'failed',`${variant} must fail acceptance`);
          let refused=false;try{await operation('rejected-handoff',()=>api.handoffTask(root,runId,task.id,handoffInput));}catch(error){assert.match(String(error),/missing passed collector evidence/);refused=true;}assert(refused,`${variant} must not hand off`);checks.push({variant,collector:'failed',handoff:'rejected'});
        }
        await put('web/feature.cjs',goodSource,false);const passed=await collect(task.id);assert.equal(passed.result_status,'passed');checks.push({variant:'correct',collector:'passed'});
        authoredInputs.add('implementation requirement outcomes and task-owned file inventory');
        await operation('handoff-task',()=>api.handoffTask(root,runId,task.id,handoffInput));
        await operation('review-gate',()=>api.recordQualityGate(root,runId,'web','passed',[passed.evidence_path],'pm','Synthetic fixed-fixture review; no human acceptance',new Date().toISOString()));
      } else {
        await transition(task.id,'running',task.role);
        if(profile==='compact'&&task.role==='ba') {
          assert.equal(typeof api.publishCompactSpecification,'function','Compact specification helper unavailable');
          authoredInputs.add('compact specification semantic input');
          await operation('compact-specification',()=>api.publishCompactSpecification(root,runId,{scope:{summary:request,in_scope:['Tenant-scoped paginated order view'],out_of_scope:['Policy, schema, service or public contract changes']},requirements:[{id:'REQ-001',description:'Apply existing tenant isolation, pagination and safe public row mapping.',fact_ids:['FACT-001']}],acceptance_criteria:['permission','pagination','mapping'].map((label,i)=>({id:`AC-00${i+1}`,requirement_id:'REQ-001',given:'The fixed seeded order records and existing tenant policy',when:`The ${label} acceptance case executes`,then:'Its fixed Node assertions pass',evidence_types:['command']})),api_change:{kind:'unchanged',description:'Uses existing response conventions; no public contract change'}}));
        } else if(profile==='compact'&&task.role==='qc') {
          assert.equal(typeof api.publishCompactQc,'function','Compact QC helper unavailable');
          const passed=await collect(task.id);assert.equal(passed.result_status,'passed');authoredInputs.add('compact QC acceptance outcomes');
          await operation('compact-qc',()=>api.publishCompactQc(root,runId,{results:[1,2,3].map(i=>({ac_id:`AC-00${i}`,status:'passed',evidence:[{type:'command',reference:passed.evidence_path}],notes:'Executed fixed seed Node acceptance cases; no external service claim.'})),defects:[]}));
          for(const gate of ['integration','qc'])await operation('review-gate',()=>api.recordQualityGate(root,runId,gate,'passed',[passed.evidence_path],'pm','Synthetic independent acceptance fixture',new Date().toISOString()));
        } else {
          for(const path of task.required_outputs.filter(path=>!['request.md','manifest.yaml'].includes(path)))await put(`.sdlc/runs/${runId}/${path}`,path==='facts.yaml'?JSON.stringify(facts,null,2):path.endsWith('semantic-claims.yaml')?stringify(claims):markdown);
        }
        if(task.role==='ba') {
          await timed('validation_ms','validate-semantic-claims',async()=>{
            const packageDocument=parse(await readFile(resolve(root,`.sdlc/runs/${runId}/artifacts/ba/semantic-claims.yaml`),'utf8'));
            const validation=api.validateDocument('semanticClaims',packageDocument);
            assert.equal(validation.valid,true,validation.diagnostics.join('; '));
            claimLinks=packageDocument.claims.map(claim=>({fact_id:claim.source_fact_id,requirement_ids:claim.requirement_ids,question_ids:claim.question_ids,subject:claim.subject,relation:claim.relation,value:claim.value,status:claim.status}));
            assert.deepEqual(claimLinks,[{fact_id:'FACT-001',requirement_ids:['REQ-001'],question_ids:[],subject:facts.facts[0].subject,relation:facts.facts[0].relation,value:facts.facts[0].value,status:'approved'}],'both profiles must preserve the same approved fact and requirement mapping');
          });
          const record=await collect(task.id,'sdlc_typecheck');assert.equal(record.result_status,'passed');
          if(profile==='compact')await transition(task.id,'awaiting_review',task.role);
          await operation('review-gate',()=>api.recordQualityGate(root,runId,'requirements','passed',profile==='compact'?['artifacts/ba/specification.yaml']:[record.evidence_path],'pm','Synthetic requirements traceability check',new Date().toISOString()));
        }
        if(profile!=='compact'&&['integration','qc'].includes(task.stage)) {
          const record=await collect(task.id);assert.equal(record.result_status,'passed');
          await operation('review-gate',()=>api.recordQualityGate(root,runId,task.stage,'passed',[record.evidence_path],'pm','Synthetic fixed acceptance review',new Date().toISOString()));
        }
        if(!(profile==='compact'&&task.role==='ba'))await transition(task.id,'awaiting_review',task.role);
      }
      await transition(task.id,'completed','pm');
    }
    await timed('validation_ms','validate-run',async()=>{const result=await api.validateRun(root,runId);assert.equal(result.valid,true,result.diagnostics.join('; '));});
    const final=await operation('finalize',()=>api.finalizeRun(root,runId,'pm',new Date().toISOString()));
    assert.equal(final.product_owner_review.decision,null);assert.equal(final.final_result.status,'ready');assert.equal(final.run.status,'product_owner_review');
    const required=[...new Set(initialTasks.flatMap(task=>task.required_outputs))];
    return {profile,repetition,semantic_claim_links:claimLinks,graph_sha256:createHash('sha256').update(JSON.stringify(initialTasks)).digest('hex'),fixture_program_artifact_count:3,task_count:initialTasks.length,task_ids:initialTasks.map(task=>task.id),required_artifact_count:required.length,fixture_authored_required_artifact_count:required.filter(path=>authored.has(path)).length,runtime_generated_required_artifact_count:required.filter(path=>!authored.has(path)).length,fixture_authored_required_artifact_paths:required.filter(path=>authored.has(path)),runtime_generated_required_artifact_paths:required.filter(path=>!authored.has(path)),runtime_generated_auxiliary_artifact_count:3+evidenceRecords.length*3,runtime_generated_total_artifact_count:required.filter(path=>!authored.has(path)).length+3+evidenceRecords.length*3,collector_invocation_count:evidenceRecords.length,runtime_generated_auxiliary_artifact_categories:{assignment:1,handoff_receipt:1,changed_file_inventory:1,collector_json:evidenceRecords.length,collector_stdout:evidenceRecords.length,collector_stderr:evidenceRecords.length},semantic_input_count:authoredInputs.size,authored_semantic_inputs:[...authoredInputs],runtime_call_count:Object.values(calls).reduce((a,b)=>a+b,0),runtime_calls:calls,...Object.fromEntries(Object.entries(totals).map(([key,value])=>[key,Math.round(value*100)/100])),fixture_wall_ms:Math.round((performance.now()-wallStart)*100)/100,acceptance_case_count:5,negative_variants:checks,final_status:final.run.status,human_acceptance:'pending',source_sha256:createHash('sha256').update(goodSource).digest('hex'),acceptance_sha256:createHash('sha256').update(acceptanceSource).digest('hex')};
  } finally {await rm(root,{recursive:true,force:true});}
}
function summarize(samples) {
  const median=(key)=>{const values=samples.map(sample=>sample[key]).sort((a,b)=>a-b);const mid=Math.floor(values.length/2);return values.length%2?values[mid]:(values[mid-1]+values[mid])/2;};
  return {samples:samples.length,task_count:samples[0].task_count,required_artifact_count:samples[0].required_artifact_count,fixture_authored_required_artifact_count:samples[0].fixture_authored_required_artifact_count,runtime_generated_required_artifact_count:samples[0].runtime_generated_required_artifact_count,median_runtime_operations_ms:median('runtime_operations_ms'),median_validation_ms:median('validation_ms'),median_collector_wrapper_ms:median('collector_wrapper_ms'),median_collector_command_execution_ms:median('collector_command_execution_ms'),median_fixture_wall_ms:median('fixture_wall_ms')};
}
await captureBaseline();
const candidateHash=baselineOnly?null:await candidateFingerprint();
if (!baselineOnly) await exec(resolve(repository, 'node_modules/.bin/tsc'), ['-p', resolve(repository, 'tsconfig.json')], { cwd: repository });
const suites=[{name:'baseline_full',tree:baselineTree,profile:'full'},...baselineOnly?[]:[{name:'candidate_full',tree:repository,profile:'full'},{name:'candidate_compact',tree:repository,profile:'compact'}]];
const report={schema_version:1,completed:false,candidate_source_sha256:candidateHash,baseline_commit:baselineRef,benchmark_script_sha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),recorded_at:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,dependency_lock_sha256:createHash('sha256').update(await readFile(resolve(repository,'package-lock.json'))).digest('hex')},repetitions,seed:'fixed-seven-orders-v1',limits:['Synthetic local fixture; no real agents, humans, external services, database, or customer data.','Runtime operations include helper/validation I/O; collector wrapper time includes subprocess execution and evidence publication.','Collector execution time comes only from collector timestamps; it excludes LLM and human work.','Fixture wall time includes scripted file creation and Git setup; it is not real delivery lead time.','Authored artifact counts identify fixed fixture content supplied by this script, not actual human typing or LLM output. Required artifacts count distinct workflow required outputs; extra semantic inputs are counted separately.',
'Auxiliary generated artifacts count assignment/receipt/change inventory and collector JSON/stdout/stderr; they exclude locks, installation assets, and internal authority-version metadata.','Negative variants and acceptance source are identical across profiles; Compact combines integration/QC into one collector pass, so repeated verification invocation counts differ by design. Synthetic role/review fixtures do not replace independent real delivery review.'],suites:{}};
for(const suite of suites){const samples=[];for(let repetition=1;repetition<=repetitions;repetition++){samples.push(await scenario(suite.tree,suite.profile,repetition));process.stdout.write(`${suite.name} repetition ${repetition}: ${samples.at(-1).fixture_wall_ms}ms\n`);}report.suites[suite.name]={summary:summarize(samples),samples};await writeFile(resolve(output,baselineOnly?'baseline.json':'comparison.json'),JSON.stringify(report,null,2)+'\n');}
const baselineSample=report.suites.baseline_full.samples[0];
for(const suite of Object.values(report.suites))for(const sample of suite.samples){
  assert.equal(sample.source_sha256,baselineSample.source_sha256,'feature source differs across measured suites');
  assert.equal(sample.acceptance_sha256,baselineSample.acceptance_sha256,'acceptance test source differs across measured suites');
  assert.deepEqual(sample.negative_variants,baselineSample.negative_variants,'bug rejection parity changed');
  assert.equal(sample.human_acceptance,'pending');
  assert.deepEqual(sample.semantic_claim_links,baselineSample.semantic_claim_links,'fact-to-requirement mapping differs across profiles');
  if(sample.profile==='full')assert.equal(sample.graph_sha256,baselineSample.graph_sha256,'candidate Full changed the baseline task/output graph');
}
if(!baselineOnly)assert.equal(await candidateFingerprint(),candidateHash,'Candidate runtime/assets changed during measurement; rerun against stable source');
report.completed=true;
await writeFile(resolve(output,baselineOnly?'baseline.json':'comparison.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(report.suites).map(([name,value])=>[name,value.summary])),null,2)+'\n');
