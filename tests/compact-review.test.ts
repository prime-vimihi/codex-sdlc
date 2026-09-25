import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { publishCompactQc, publishCompactSpecification, type CompactQcInput } from "../src/compact-artifacts.js";
import { executeConfiguredCommand } from "../src/evidence.js";
import { initializeProject } from "../src/install.js";
import { recordQualityGate } from "../src/lifecycle.js";
import { mutateRunManifest } from "../src/manifest-transaction.js";
import { loadRun, startRun } from "../src/runs.js";
import { prepareTask, handoffTask } from "../src/task-operations.js";
import { prepareTransitionContext, transitionTask } from "../src/transitions.js";
import type { TaskStatus } from "../src/types.js";

// These integration regressions traverse a full lifecycle; allow for parallel CI filesystem load.
const exec=promisify(execFile), roots:string[]=[];
const runId="REVIEW-001";
const assessment={bounded_scope:true as const,existing_patterns:true as const,migrations:false as const,breaking_api:false as const,authorization_changes:false as const,sensitive_data_exposure:false as const,cross_system_uncertainty:false as const,rationale:"Existing bounded display correction"};
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function transition(root:string,taskId:string,to:TaskStatus,actor="pm") {
  await mutateRunManifest(root,runId,async manifest=>{const request={taskId,to,actor,reason:"Independent regression fixture",at:new Date().toISOString()};Object.assign(manifest,transitionTask(manifest,request,await prepareTransitionContext(root,runId,manifest,request)));});
}
async function collect(root:string,taskId:string) {
  const previous=process.env.CODEX_SDLC_NETWORK_POLICY;process.env.CODEX_SDLC_NETWORK_POLICY="disabled";
  try{return await executeConfiguredCommand(root,runId,taskId,"sdlc_test");}
  finally{if(previous===undefined)delete process.env.CODEX_SDLC_NETWORK_POLICY;else process.env.CODEX_SDLC_NETWORK_POLICY=previous;}
}
async function fixture() {
  const root=await mkdtemp(resolve(tmpdir(),"compact-independent-review-"));roots.push(root);
  await mkdir(resolve(root,"web"));await writeFile(resolve(root,"web/feature.cjs"),"module.exports='before';\n");
  await exec("git",["init","-b","main"],{cwd:root});await exec("git",["add","."],{cwd:root});await exec("git",["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","Fixture baseline"],{cwd:root});
  await initializeProject({root,projectName:"Independent Compact regression",applications:["web"],webRoot:"web",dryRun:false});
  const projectPath=resolve(root,".sdlc/project.yaml"),project=parse(await readFile(projectPath,"utf8"));project.applications.web.lifecycle="scaffolded";
  project.commands.sdlc_test={executable:process.execPath,args:["-e","require('node:fs').appendFileSync('executed.log','check\\n');if(require('./feature.cjs')!=='after')process.exit(1)"],cwd:"web",network:"disabled",mutates:true};await writeFile(projectPath,stringify(project));
  await writeFile(resolve(root,".sdlc/requests/change.md"),"Correct the existing display.");
  await startRun(root,{id:runId,title:"Correction",requestFile:".sdlc/requests/change.md",profile:"compact",assessment,affectedApplications:{web:true,backend:false,mobile:false,database:false,sharedPackages:false},now:new Date().toISOString()});
  const base=resolve(root,`.sdlc/runs/${runId}`);
  await transition(root,"PM-001","running");
  await writeFile(resolve(base,"facts.yaml"),stringify({schema_version:1,run_id:runId,producer:"pm",revision:1,facts:[{id:"FACT-001",subject:"feature.status",relation:"equals",value:"after",status:"approved"}]}));
  await transition(root,"PM-001","awaiting_review");await transition(root,"PM-001","completed");await transition(root,"BA-001","running","ba");
  await publishCompactSpecification(root,runId,{scope:{summary:"Existing display correction",in_scope:["Existing display"],out_of_scope:["New permissions"]},requirements:[{id:"REQ-001",description:"Correct existing status",fact_ids:["FACT-001"]}],acceptance_criteria:[{id:"AC-001",requirement_id:"REQ-001",given:"Existing feature",when:"Display opens",then:"Correct status is visible",evidence_types:["command","ui"]}],api_change:{kind:"unchanged",description:"Existing response contract"}});
  await transition(root,"BA-001","awaiting_review","ba");await recordQualityGate(root,runId,"requirements","passed",["artifacts/ba/specification.yaml"],"pm","Independent fixture specification review",new Date().toISOString());await transition(root,"BA-001","completed");
  await prepareTask(root,runId,"WEB-001",{controls:{api_contract_status:"approved",gaps:[],questions:[],requirements:[{requirement_id:"REQ-001",capability:"feature_status",required:true,parameters:{},source_references:[{kind:"fact",reference:"FACT-001" as any}]}]},commandIds:["sdlc_test"]});
  await transition(root,"WEB-001","running","frontend");await writeFile(resolve(root,"web/feature.cjs"),"module.exports='after';\n");
  await mkdir(resolve(base,"artifacts/web"),{recursive:true});await writeFile(resolve(base,"artifacts/web/implementation-summary.md"),"---\nrevision: 1\n---\nREQ-001: Corrected the status.\n");
  const implementation=await collect(root,"WEB-001");
  await handoffTask(root,runId,"WEB-001",{requirementOutcomes:[{requirement_id:"REQ-001",capability:"feature_status",status:"implemented"}],changedFiles:[{path:"web/feature.cjs",type:"source"}]});
  await recordQualityGate(root,runId,"web","passed",[implementation.evidence_path],"pm","Fixture implementation review",new Date().toISOString());await transition(root,"WEB-001","completed");await transition(root,"QC-001","running","qc");
  const evidence=await collect(root,"QC-001");
  const reference="artifacts/qc/evidence/display.yaml", observation={schema_version:1,run_id:runId,task_id:"QC-001",producer:"qc",revision:1,evidence_type:"ui",observed_at:new Date().toISOString(),environment:"Isolated fixture",procedure:"Read status view",actual_result:"Expected status appeared",status:"passed"};
  await mkdir(resolve(base,"artifacts/qc/evidence"),{recursive:true});await writeFile(resolve(base,reference),stringify(observation));
  const input:CompactQcInput={results:[{ac_id:"AC-001",status:"passed",evidence:[{type:"command",reference:evidence.evidence_path},{type:"ui",reference}],notes:"Independent fixed fixture result"}],defects:[]};
  return {root,base,input,evidence,reference,observation};
}

test("future-dated direct UI observations cannot support current acceptance",async()=>{
  const f=await fixture();await writeFile(resolve(f.base,f.reference),stringify({...f.observation,observed_at:"2099-01-01T00:00:00.000Z"}));
  await expect(publishCompactQc(f.root,runId,f.input)).rejects.toThrow(/future|time|observation/);
}, 30_000);
test("future-dated collector metadata cannot support current acceptance",async()=>{
  const f=await fixture();await writeFile(resolve(f.base,f.evidence.evidence_path),JSON.stringify({...f.evidence,started_at:"2099-01-01T00:00:00.000Z",completed_at:"2099-01-01T00:00:01.000Z"}));
  await expect(publishCompactQc(f.root,runId,f.input)).rejects.toThrow(/future|time|collector/);
}, 30_000);
test("QC reruns after gate review cannot execute and silently discard a failure",async()=>{
  const f=await fixture();await publishCompactQc(f.root,runId,f.input);
  for(const gate of ["integration","qc"])await recordQualityGate(f.root,runId,gate,"passed",[f.evidence.evidence_path],"pm","Independent fixture gate review",new Date().toISOString());
  const before=await readFile(resolve(f.root,"web/executed.log"),"utf8");
  await writeFile(resolve(f.root,"web/feature.cjs"),"module.exports='broken';\n");
  let result, failure;try{result=await collect(f.root,"QC-001");}catch(error){failure=error;}
  const executed=(await readFile(resolve(f.root,"web/executed.log"),"utf8"))!==before;
  const manifest=await loadRun(f.root,runId);
  if(executed){expect(failure).toBeUndefined();expect(result?.result_status).toBe("failed");expect(manifest.quality_gates.qc?.status).not.toBe("passed");}
  else expect(failure).toBeDefined();
}, 30_000);
