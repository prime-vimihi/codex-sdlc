import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { expect, test } from 'vitest';
import { createDeliveryFixture, activateFixture, writeFixtureOutputs, collectFixtureEvidence } from './helpers/delivery-fixture.js';
import { prepareTask, handoffTask } from '../src/task-operations.js';

test('independent repro: changed-during-test source must not count as verified', async () => {
  const fixture = await createDeliveryFixture();
  try {
    const path = resolve(fixture.root,'.sdlc/project.yaml');
    const project = parse(await readFile(path,'utf8'));
    project.commands.sdlc_test.args=['-e',"if(require('./feature.cjs') !== 'after') process.exit(1);require('node:fs').writeFileSync('test-read.done','yes');setTimeout(()=>process.exit(0),600)"];
    await writeFile(path,stringify(project));
    await prepareTask(fixture.root,fixture.runId,fixture.taskId,fixture.input);
    await activateFixture(fixture); await writeFixtureOutputs(fixture);
    const command=collectFixtureEvidence(fixture);
    for(let i=0;i<100;i++) {
      try { await readFile(resolve(fixture.root,fixture.appRoot,'test-read.done'));break; } catch { await new Promise(r=>setTimeout(r,10)); }
    }
    await writeFile(resolve(fixture.root,fixture.appRoot,'feature.cjs'),"module.exports = 'broken after test read';\n");
    await command;
    await expect(handoffTask(fixture.root,fixture.runId,fixture.taskId,fixture.handoffInput)).rejects.toThrow(/stale|changed|verification/);
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

import { activateAndHandoffFixture } from './helpers/delivery-fixture.js';
import { recordQualityGate } from '../src/lifecycle.js';
import { mutateRunManifest, readAuthorityVersion } from '../src/manifest-transaction.js';
import { loadRun } from '../src/runs.js';
import { prepareTransitionContext, transitionTask } from '../src/transitions.js';
import { repairTask, recoverRepair } from '../src/repairs.js';

test('independent repro: committed repair recovery must advance authority version if interrupted before version update', async () => {
  const fixture = await createDeliveryFixture();
  try {
    await activateAndHandoffFixture(fixture);
    let manifest=await loadRun(fixture.root,fixture.runId);
    const task=manifest.tasks.find(t=>t.id===fixture.taskId)!;
    await recordQualityGate(fixture.root,fixture.runId,'web','passed',task.evidence,'pm','Reviewed independent fixture',new Date().toISOString());
    await mutateRunManifest(fixture.root,fixture.runId,async current=>{
      const request={taskId:fixture.taskId,to:'completed' as const,actor:'pm',reason:'Fixture review',at:new Date().toISOString()};
      Object.assign(current,transitionTask(current,request,await prepareTransitionContext(fixture.root,fixture.runId,current,request)));
    });
    const version=await readAuthorityVersion(fixture.root,fixture.runId);
    const journalPath=resolve(fixture.root,`.sdlc/runs/${fixture.runId}/.repair-transaction.json`);
    let journal='';
    await repairTask(fixture.root,fixture.runId,fixture.taskId,{actor:'pm',defectId:'DEF-001',reason:'Fixture repair'}, {beforeRelease:async()=>{journal=await readFile(journalPath,'utf8');}});
    // Reconstruct the exact crash window after manifest rename but before version update.
    await writeFile(resolve(fixture.root,`.sdlc/runs/${fixture.runId}/.sdlc-authority-version.json`),JSON.stringify({schema_version:1,version}));
    await writeFile(journalPath,journal);
    expect(await recoverRepair(fixture.root,fixture.runId,'pm')).toMatchObject({recovered:true,outcome:'committed'});
    expect(await readAuthorityVersion(fixture.root,fixture.runId)).toBeGreaterThan(version);
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

import { spawnSync } from 'node:child_process';
test('independent built CLI: prepare, plan, activate, failed/passed checks, and handoff', async () => {
  const fixture=await createDeliveryFixture();
  const cli=resolve('dist/bin.js');
  const call=(args:string[],input?:unknown)=>{
    const result=spawnSync(process.execPath,[cli,...args,'--json'],{cwd:fixture.root,input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8',env:{...process.env,CODEX_SDLC_NETWORK_POLICY:'disabled'}});
    return {code:result.status,body:JSON.parse(result.stdout)};
  };
  try {
    const prepared=call(['prepare-task',fixture.runId,fixture.taskId],fixture.input);
    expect(prepared.code).toBe(0); expect(prepared.body.result.executionAuthorized).toBe(false);
    const planned=call(['agent-plan',fixture.runId,fixture.taskId],{source:'independent CLI fixture',model_selection:true,reasoning_selection:true,models:[{id:'gpt-6-luna',reasoning_efforts:['xhigh']}]});
    expect(planned.code).toBe(0);
    const activated=call(['activate-task',fixture.runId,fixture.taskId,'--reason','Actual CLI fixture dispatch'],{plan:planned.body.result,agent_id:'fixture-cli-agent',actual_model:'gpt-6-luna',actual_reasoning_effort:'xhigh',observation_source:'test host response'});
    expect(activated.code).toBe(0); expect(activated.body.result.status).toBe('running');
    const failed=call(['check-task',fixture.runId,fixture.taskId]);
    expect(failed.code).not.toBe(0); expect(failed.body.ok).toBe(false); expect(failed.body.result.passed).toBe(false);
    await writeFixtureOutputs(fixture);
    const passed=call(['check-task',fixture.runId,fixture.taskId]);
    expect(passed.code).toBe(0); expect(passed.body.result.passed).toBe(true);
    const handed=call(['handoff-task',fixture.runId,fixture.taskId],fixture.handoffInput);
    expect(handed.code).toBe(0); expect(handed.body.result.taskStatus).toBe('awaiting_review');
    expect((await loadRun(fixture.root,fixture.runId)).quality_gates.web?.status).toBe('pending');
  } finally {await rm(fixture.root,{recursive:true,force:true});}
});

test('independent repro: unresolved repair journal blocks ordinary mutation, publication, and command execution', async () => {
  const fixture=await createDeliveryFixture();
  try {
    await activateAndHandoffFixture(fixture);
    const task=(await loadRun(fixture.root,fixture.runId)).tasks.find(t=>t.id===fixture.taskId)!;
    await recordQualityGate(fixture.root,fixture.runId,'web','passed',task.evidence,'pm','Fixture review',new Date().toISOString());
    await mutateRunManifest(fixture.root,fixture.runId,async current=>{
      const request={taskId:fixture.taskId,to:'completed' as const,actor:'pm',reason:'Fixture review',at:new Date().toISOString()};
      Object.assign(current,transitionTask(current,request,await prepareTransitionContext(fixture.root,fixture.runId,current,request)));
    });
    const journalPath=resolve(fixture.root,`.sdlc/runs/${fixture.runId}/.repair-transaction.json`);
    let journal='';
    await repairTask(fixture.root,fixture.runId,fixture.taskId,{actor:'pm',defectId:'DEF-001',reason:'Fixture repair'}, {beforeRelease:async()=>{journal=await readFile(journalPath,'utf8');}});
    await writeFile(journalPath,journal);
    await expect(mutateRunManifest(fixture.root,fixture.runId,()=>undefined)).rejects.toThrow(/repair|interrupted/);
    await expect(prepareTask(fixture.root,fixture.runId,fixture.taskId,fixture.input)).rejects.toThrow(/repair|interrupted/);
    const projectPath=resolve(fixture.root,'.sdlc/project.yaml'), project=parse(await readFile(projectPath,'utf8'));
    project.commands.sdlc_test.args=['-e',"require('node:fs').writeFileSync('must-not-run-during-recovery','ran')"];
    await writeFile(projectPath,stringify(project));
    await expect(collectFixtureEvidence(fixture)).rejects.toThrow(/repair|interrupted/);
    await expect(readFile(resolve(fixture.root,fixture.appRoot,'must-not-run-during-recovery'))).rejects.toThrow();
  } finally {await rm(fixture.root,{recursive:true,force:true});}
});
